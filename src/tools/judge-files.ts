import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { estimateTextTokens } from '../engine/tokens.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { FILE_ROUND_TOKENS, FILE_ROUNDS_MAX, type JudgeFile } from './auto-approve.ts';
import { isInside, realish } from './hooks/scope.ts';

// 判定役に見せるファイル（P2）: 名前の出るスクリプトと、そこ（とその場のコード）から相対パスで import・require されるファイル（1 段、製品の中だけ）。中身は秘密を伏せた写し

export const JUDGE_FILE_BYTES = 1_048_576;

export type JudgeFileProblem = 'unreadable' | 'binary' | 'big' | 'overwritten' | 'unshown' | 'native' | 'too_many' | 'encoding';
export type JudgeFilesFact = { files: JudgeFile[]; links: Array<[string, string]> } | { problem: JudgeFileProblem; path: string };

const FOLLOW_FILES = 50;
const FOLLOW_BYTES = FILE_ROUND_TOKENS * FILE_ROUNDS_MAX * 4;
const FOLLOW_SPECS = 200;
const PY_COOKIE = /^[ \t\f]*#.*?coding[:=][ \t]*([-\w.]+)/u;
const UTF8_NAMES = /^utf[-_]?8(?:[-_]sig)?$/iu;

// 無いファイルは中身が無いので、無いと書いて見せる（判定のあとに現れたら、事前の判定のやり直しで bind が変わって断る）
export const MISSING_FILE_TEXT = '(this file does not exist now)';

export interface ReadFile { path: string; fingerprint: string; content?: string; problem?: 'missing' | 'unreadable' | 'binary' | 'big' | 'native' | 'encoding' }

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

export function readForJudge(file: string): ReadFile {
  const stat = statSync(file, { throwIfNoEntry: false });
  if (!stat) return { path: file, fingerprint: `${file}\0missing`, problem: 'missing' };
  if (!stat.isFile()) return { path: file, fingerprint: `${file}\0dir\0${stat.size}\0${stat.mtimeMs}`, problem: 'unreadable' };
  if (stat.size > JUDGE_FILE_BYTES) return { path: file, fingerprint: `${file}\0big\0${stat.size}\0${stat.mtimeMs}`, problem: 'big' };
  let bytes: Buffer;
  try { bytes = readFileSync(file); } catch { return { path: file, fingerprint: `${file}\0unreadable`, problem: 'unreadable' }; }
  const fingerprint = `${file}\0${sha256(bytes)}`;
  if (/\.(?:node|pyd|so)$/iu.test(file)) return { path: file, fingerprint, problem: 'native' };
  if (bytes.subarray(0, 8000).includes(0)) return { path: file, fingerprint, problem: 'binary' };
  const content = bytes.toString('utf8');
  if (content.split('\n', 2).some(line => { const m = PY_COOKIE.exec(line); return m !== null && !UTF8_NAMES.test(m[1]!); })) return { path: file, fingerprint, problem: 'encoding' };
  return { path: file, fingerprint, content };
}

const JS_SPEC = /(?:\bimport\s*(?:[\w*{}\s,$]+\s*from\s*)?|\bexport\s*[\w*{}\s,$]*\s*from\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)(['"`])(\.{1,2}[\\/][^'"`\n]*)\1/gu;
const PY_SPEC = /^[ \t]*(?:from[ \t]+(\.?[A-Za-z_][\w.]*)[ \t]+import\b|import[ \t]+([A-Za-z_][\w.]*(?:[ \t]*,[ \t]*[A-Za-z_][\w.]*)*))/gmu;
const JS_TRIES = ['', '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx', '.json', '.node', '/index.js', '/index.ts', '/index.mjs', '/index.json', '/index.node'];

function packageMain(dir: string): string[] {
  try {
    const main = (JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as { main?: unknown }).main;
    return typeof main === 'string' ? JS_TRIES.map(end => resolve(dir, main) + end).filter(isFile) : [];
  } catch { return []; }
}

// node が読むかもしれない候補のうち、あるものを全部（拡張子・フォルダの package.json の main・index）
export const jsCandidates = (base: string): string[] => [...new Set([...JS_TRIES.map(end => base + end).filter(isFile), ...packageMain(base)])];

const isFile = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isFile() === true;

// 印の付いた Python のネイティブの部品（helper.cp312-win_amd64.pyd・helper.cpython-312-x86_64-linux-gnu.so）
function taggedNative(base: string): string[] {
  const head = `${basename(base)}.`;
  try { return readdirSync(dirname(base)).filter(name => name.startsWith(head) && /\.(?:pyd|so)$/iu.test(name)).map(name => join(dirname(base), name)); } catch { return []; }
}

// 文字のまま書かれた相対の import・require・Python の import（この PC にあるファイルだけ）
export function relativeImports(text: string, fromDir: string, limit = Infinity, specs?: { count: number }): string[] {
  const out = new Set<string>();
  const asked = new Set<string>();
  const fresh = (spec: string): boolean => {
    if (asked.has(spec)) return false;
    asked.add(spec);
    if (specs) specs.count++;
    return true;
  };
  for (const match of text.matchAll(JS_SPEC)) {
    if (out.size > limit || (specs?.count ?? 0) > FOLLOW_SPECS) break;
    if (!fresh(match[2]!)) continue;
    const base = resolve(fromDir, match[2]!.replace(/\\+/gu, '/'));
    for (const found of jsCandidates(base)) out.add(found);
  }
  for (const match of text.matchAll(PY_SPEC)) {
    if (out.size > limit || (specs?.count ?? 0) > FOLLOW_SPECS) break;
    const names = match[1] ? [match[1]] : match[2]!.split(',').map(name => name.trim());
    for (const name of names) {
      if (!fresh(`py:${name}`)) continue;
      const parts = name.replace(/^\./u, '').split('.');
      const base = resolve(fromDir, ...parts);
      for (const found of [`${base}.py`, resolve(base, '__init__.py'), `${base}.pyd`, `${base}.so`, ...taggedNative(base)].filter(isFile)) out.add(found);
    }
  }
  return [...out];
}

const inside = (root: string, path: string): boolean => isInside(root, path) && isInside(realish(root), realish(path));

export interface JudgeFilesInput { scripts: readonly string[]; inline: ReadonlyArray<{ code: string; cwd: string }>; root: string | undefined; writes?: readonly string[]; unshown?: string | undefined; rewrites?: string | undefined }

const writesInto = (write: string, file: string): boolean => isInside(write, file) || isInside(realish(write), realish(file));

// 返すのは、見せるファイル（とその読み）と、bind に入れる指紋。名前の出るスクリプトか import されるファイルが読めない・バイナリ・1MB 超なら problem
export function judgeFilesOf(input: JudgeFilesInput): { fact: JudgeFilesFact; read: ReadFile[] } {
  const named = [...new Set(input.scripts)].map(readForJudge);
  const links: Array<[string, string]> = [];
  const seen = new Set(named.map(file => file.path));
  const imported: ReadFile[] = [];
  let bytes = 0;
  let tooMany: string | undefined;
  let outside: string | undefined;
  const specs = { count: 0 };
  const follow = (text: string, fromDir: string, from: string | undefined): void => {
    if (!input.root || tooMany !== undefined) return;
    const found = relativeImports(text, fromDir, FOLLOW_FILES, specs);
    if (specs.count > FOLLOW_SPECS) { tooMany = from ?? fromDir; return; }
    for (const path of found) {
      if (tooMany !== undefined) return;
      if (!inside(input.root, path)) { outside ??= path; continue; }
      if (from) links.push([from, path]);
      if (seen.has(path)) continue;
      seen.add(path);
      bytes += statSync(path, { throwIfNoEntry: false })?.size ?? 0;
      if (seen.size > FOLLOW_FILES || bytes > FOLLOW_BYTES) { tooMany = path; return; }
      imported.push(readForJudge(path));
    }
  };
  for (const file of named) if (file.content !== undefined) follow(file.content, dirname(file.path), file.path);
  for (const { code, cwd } of input.inline) follow(code, cwd, undefined);
  const read = [...named, ...imported];
  if (input.unshown !== undefined) return { fact: { problem: 'unshown', path: input.unshown }, read };
  if (outside !== undefined) return { fact: { problem: 'unshown', path: outside }, read };
  if (tooMany !== undefined) return { fact: { problem: 'too_many', path: tooMany }, read };
  const bad = read.find(file => file.problem !== undefined && file.problem !== 'missing');
  if (bad) return { fact: { problem: bad.problem as JudgeFileProblem, path: bad.path }, read };
  const overwritten = read.find(file => (input.writes ?? []).some(write => writesInto(write, file.path)));
  if (overwritten) return { fact: { problem: 'overwritten', path: overwritten.path }, read };
  if (input.rewrites !== undefined && read.length > 0) return { fact: { problem: 'overwritten', path: input.rewrites }, read };
  const files = read.map(file => {
    const text = file.content === undefined ? MISSING_FILE_TEXT : redactSecrets(file.content);
    return { path: file.path, sha256: file.content === undefined ? 'missing' : file.fingerprint.slice(file.fingerprint.lastIndexOf('\0') + 1), text, tokens: estimateTextTokens(text) };
  });
  return { fact: { files, links }, read };
}
