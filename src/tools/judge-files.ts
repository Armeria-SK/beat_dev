import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { estimateTextTokens } from '../engine/tokens.ts';
import { redactSecrets } from '../shared/redaction.ts';
import type { JudgeFile } from './auto-approve.ts';
import { isInside, realish } from './hooks/scope.ts';

// 判定役に見せるファイル（P2）: 名前の出るスクリプトと、そこ（とその場のコード）から相対パスで import・require されるファイル（1 段、製品の中だけ）。中身は秘密を伏せた写し

export const JUDGE_FILE_BYTES = 1_048_576;

export type JudgeFilesFact = { files: JudgeFile[]; links: Array<[string, string]> } | { problem: 'unreadable' | 'binary' | 'big'; path: string };

// 無いファイルは中身が無いので、無いと書いて見せる（判定のあとに現れたら、事前の判定のやり直しで bind が変わって断る）
export const MISSING_FILE_TEXT = '(this file does not exist now)';

export interface ReadFile { path: string; fingerprint: string; content?: string; problem?: 'missing' | 'unreadable' | 'binary' | 'big' }

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

export function readForJudge(file: string): ReadFile {
  const stat = statSync(file, { throwIfNoEntry: false });
  if (!stat) return { path: file, fingerprint: `${file}\0missing`, problem: 'missing' };
  if (!stat.isFile()) return { path: file, fingerprint: `${file}\0dir\0${stat.size}\0${stat.mtimeMs}`, problem: 'unreadable' };
  if (stat.size > JUDGE_FILE_BYTES) return { path: file, fingerprint: `${file}\0big\0${stat.size}\0${stat.mtimeMs}`, problem: 'big' };
  let bytes: Buffer;
  try { bytes = readFileSync(file); } catch { return { path: file, fingerprint: `${file}\0unreadable`, problem: 'unreadable' }; }
  const fingerprint = `${file}\0${sha256(bytes)}`;
  if (bytes.subarray(0, 8000).includes(0)) return { path: file, fingerprint, problem: 'binary' };
  return { path: file, fingerprint, content: bytes.toString('utf8') };
}

const JS_SPEC = /(?:\bimport\s*(?:[\w*{}\s,$]+\s*from\s*)?|\bexport\s*[\w*{}\s,$]*\s*from\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)(['"`])(\.{1,2}\/[^'"`\n]*)\1/gu;
const PY_SPEC = /^[ \t]*(?:from[ \t]+(\.?[A-Za-z_][\w.]*)[ \t]+import\b|import[ \t]+([A-Za-z_][\w.]*(?:[ \t]*,[ \t]*[A-Za-z_][\w.]*)*))/gmu;
const JS_TRIES = ['', '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx', '/index.js', '/index.ts', '/index.mjs'];

const isFile = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isFile() === true;

// 文字のまま書かれた相対の import・require・Python の import（この PC にあるファイルだけ）
export function relativeImports(text: string, fromDir: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(JS_SPEC)) {
    const base = resolve(fromDir, match[2]!);
    const found = JS_TRIES.map(end => base + end).find(isFile);
    if (found) out.add(found);
  }
  for (const match of text.matchAll(PY_SPEC)) {
    const names = match[1] ? [match[1]] : match[2]!.split(',').map(name => name.trim());
    for (const name of names) {
      const parts = name.replace(/^\./u, '').split('.');
      const base = resolve(fromDir, ...parts);
      const found = [`${base}.py`, resolve(base, '__init__.py')].find(isFile);
      if (found) out.add(found);
    }
  }
  return [...out];
}

const inside = (root: string, path: string): boolean => isInside(root, path) && isInside(realish(root), realish(path));

export interface JudgeFilesInput { scripts: readonly string[]; inline: ReadonlyArray<{ code: string; cwd: string }>; root: string | undefined }

// 返すのは、見せるファイル（とその読み）と、bind に入れる指紋。名前の出るスクリプトか import されるファイルが読めない・バイナリ・1MB 超なら problem
export function judgeFilesOf(input: JudgeFilesInput): { fact: JudgeFilesFact; read: ReadFile[] } {
  const named = [...new Set(input.scripts)].map(readForJudge);
  const links: Array<[string, string]> = [];
  const seen = new Set(named.map(file => file.path));
  const imported: ReadFile[] = [];
  const follow = (text: string, fromDir: string, from: string | undefined): void => {
    if (!input.root) return;
    for (const path of relativeImports(text, fromDir)) {
      if (!inside(input.root, path)) continue;
      if (from) links.push([from, path]);
      if (seen.has(path)) continue;
      seen.add(path);
      imported.push(readForJudge(path));
    }
  };
  for (const file of named) if (file.content !== undefined) follow(file.content, dirname(file.path), file.path);
  for (const { code, cwd } of input.inline) follow(code, cwd, undefined);
  const read = [...named, ...imported];
  const bad = read.find(file => file.problem !== undefined && file.problem !== 'missing');
  if (bad) return { fact: { problem: bad.problem as 'unreadable' | 'binary' | 'big', path: bad.path }, read };
  const files = read.map(file => {
    const text = file.content === undefined ? MISSING_FILE_TEXT : redactSecrets(file.content);
    return { path: file.path, sha256: file.content === undefined ? 'missing' : file.fingerprint.slice(file.fingerprint.lastIndexOf('\0') + 1), text, tokens: estimateTextTokens(text) };
  });
  return { fact: { files, links }, read };
}
