import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { resolvePaths } from '../src/paths.ts';
import { PendingStore } from '../src/pending/store.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { runToolCall, TOOL_OUTPUT_LIMIT } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { runProcess, scrubEnv } from '../src/tools/shell/runner.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

// TE-3: shell の長い出力は頭と尻を残す（失敗の最後の行が見える）。省略の行と全文のファイルの場所を必ず書く

const LAST = 'FINAL-LINE: build failed at step 9';
const BIG = 200_000;

// 1 行 40 バイトほどの行を BIG バイトまで出し、最後の行に LAST を置く
function writeGenerator(dir: string, extra = ''): void {
  writeFileSync(join(dir, 'gen.js'), [
    'const lines = [];',
    'let size = 0;',
    `for (let i = 0; size < ${BIG}; i++) { const line = 'line ' + String(i).padStart(6, '0') + ' ' + 'x'.repeat(28); lines.push(line); size += line.length + 1; }`,
    `lines.push(${JSON.stringify(LAST)});`,
    "process.stdout.write(lines.join('\\n') + '\\n');",
    extra,
  ].join('\n'));
}

function setup(t: { after: (fn: () => void) => void }, capBytes?: number) {
  const dir = realpathSync.native(tempDir(t));
  const paths = resolvePaths(dir);
  mkdirSync(paths.workspace, { recursive: true });
  const raw = testConfig();
  if (capBytes !== undefined) raw.tools.shell.outputCapBytes = capBytes;
  const config = parseConfig(raw);
  const policy = buildPolicy(config, paths);
  const workspace = defaultWorkspace(policy, paths);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config, paths, policy, workspace,
    taint: { tainted: false, sources: [] }, log: () => undefined, permissionMode: 'auto',
  };
  const db = openDatabase(':memory:', MIGRATIONS);
  const registry = new ToolRegistry().register(shellRun);
  const approvals = new ApprovalBroker(db);
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const call = (args: unknown, c: ToolContext = ctx) => runToolCall({ id: `call-${Math.random()}`, name: 'shell_run', arguments: args }, c, {
    registry, approvals, pending, db, emit: () => undefined, permissionMode: () => 'auto',
    autoClassify: async () => '{"decision":"allow","reason":"runs the product generator"}', lastUserRequest: () => 'run gen.js', conversationTainted: () => false,
  });
  return { ctx, workspace, call };
}

test('TE-3: 20 万バイトの出力で、モデルに渡る結果に最後の行・省略の行・全文のファイルの場所がある', async t => {
  const s = setup(t);
  writeGenerator(s.workspace);
  const outcome = await s.call({ command: 'node gen.js' });
  assert.equal(outcome.decision, 'allow', outcome.output.content.slice(0, 500));
  const content = outcome.output.content;
  assert.ok(content.includes(LAST), `最後の行が無い: ${content.slice(-400)}`);
  assert.ok(content.includes('line 000000'), '頭も残る');
  assert.match(content, /characters in the middle were left out/u, '省略の行');
  const ref = outcome.output.fullRef;
  assert.ok(ref && existsSync(ref), '全文のファイルがある');
  assert.ok(content.includes(`Full output: ${ref}`), '全文のファイルの場所が結果の文にある');
  assert.ok(statSync(ref).size > BIG, '全文のファイルは全部を持つ');
  assert.ok(content.length <= TOOL_OUTPUT_LIMIT + 400, `16,000 字の上限（+ 案内の行）に収まる: ${content.length}`);
});

test('TE-3: shell_run そのものの結果は、頭（outputCapBytes まで）+「… N bytes left out …」+ 尻で、尻は行の頭から始まる', async t => {
  const s = setup(t);
  writeGenerator(s.workspace);
  const out = await shellRun.execute({ command: 'node gen.js' }, s.ctx, undefined as never);
  assert.equal(out.keepTail, true, 'パイプラインに「尻も大事」と知らせる印');
  assert.ok(out.content.includes(LAST));
  const omitted = /\n\[\.\.\. ([\d,]+) bytes left out \.\.\.\]\n(line \d{6} x{28}\n)/u.exec(out.content);
  assert.ok(omitted, '省略の行のあとは、途中で切れていない行から始まる');
  assert.match(out.content, /\[The output was [\d,]+ bytes, so only its beginning \(the first 65,536 bytes\) and its end were returned\. Full output: /u);
  const full = readFileSync(out.fullRef!, 'utf8');
  const head = out.content.slice(out.content.indexOf('line 000000'), out.content.indexOf('\n[... '));
  const tail = out.content.slice(out.content.indexOf(omitted[2]!), out.content.indexOf(LAST) + LAST.length);
  assert.ok(full.startsWith(head), '頭は全文の頭そのもの');
  assert.ok(full.trimEnd().endsWith(tail), '尻は全文の尻そのもの');
  assert.equal(Buffer.byteLength(full, 'utf8') - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8') - 1, Number(omitted[1]!.replaceAll(',', '')), '省略したバイト数は、頭と尻の間の分と合う（全文の末尾の改行 1 つを除いて）');
});

test('TE-3: 直す実行（8-6a、ctx.fix と fixJob）のシェルでも、頭 + 尻になり、子のプロセスは入れ物に入る', async t => {
  const s = setup(t);
  writeGenerator(s.workspace);
  const added: unknown[] = [];
  const ctx: ToolContext = { ...s.ctx, kind: 'task', project: { id: 'p', root: s.workspace, productRoot: s.workspace }, fix: true, fixJob: { add: child => { added.push(child); } } };
  const out = await shellRun.execute({ command: 'node gen.js' }, ctx, undefined as never);
  assert.notEqual(out.isError, true, out.content.slice(0, 400));
  assert.equal(added.length, 1, '子のプロセスは入れ物に入る（onSpawn と尻の口が両方効く）');
  assert.equal(out.keepTail, true);
  assert.ok(out.content.includes(LAST));
  assert.match(out.content, /\[\.\.\. [\d,]+ bytes left out \.\.\.\]/u);
});

test('TE-3: stderr も長ければ、stdout と stderr の両方の最後の行が見える', async t => {
  const s = setup(t);
  writeGenerator(s.workspace, "process.stderr.write('e'.repeat(90000) + '\\nERR-LAST: assertion failed\\n'); process.exitCode = 1;");
  const out = await shellRun.execute({ command: 'node gen.js' }, s.ctx, undefined as never);
  assert.equal(out.isError, true);
  assert.ok(out.content.includes(LAST), 'stdout の最後の行');
  assert.ok(out.content.includes('ERR-LAST: assertion failed'), 'stderr の最後の行');
  const outcome = await s.call({ command: 'node gen.js' });
  assert.ok(outcome.output.content.includes('ERR-LAST: assertion failed'), 'パイプラインで切ったあとも、最後の行は残る');
});

test('TE-3: 短い出力は今までどおり（省略の行も上限の文も無い）', async t => {
  const s = setup(t);
  writeFileSync(join(s.workspace, 'small.js'), "console.log('hello'); console.error('warn');");
  const out = await shellRun.execute({ command: 'node small.js' }, s.ctx, undefined as never);
  assert.doesNotMatch(out.content, /left out|were returned/u);
  assert.match(out.content, /\nhello\n\n\[stderr\]\nwarn$/u);
  assert.equal(out.fullRef, undefined);
});

test('TE-3 runner: 上限を少し超えただけなら、頭と尻はつながり（skipped 0）、つなぐと全文と同じ', async t => {
  const dir = tempDir(t);
  const result = await runProcess(process.execPath, ['-e', "process.stdout.write('ab\\n'.repeat(500))"], {
    cwd: dir, env: scrubEnv(), timeoutMs: 10_000, signal: new AbortController().signal, maxBytes: 1000, tailBytes: 600,
  });
  assert.equal(result.truncated, true);
  assert.equal(result.rest?.out.skipped, 0);
  assert.equal(result.stdout + result.rest!.out.text, 'ab\n'.repeat(500));
  assert.deepEqual(result.rest?.err, { text: '', skipped: 0, before: '', afterHead: '' });
});

test('TE-3 runner: 間を飛ばした尻は、途中で切れた行（と文字の途中）を落として行の頭から始め、落とした分も skipped に数える', async t => {
  const dir = tempDir(t);
  const result = await runProcess(process.execPath, ['-e', "process.stdout.write('あいうえお-0123456789\\n'.repeat(400))"], {
    cwd: dir, env: scrubEnv(), timeoutMs: 10_000, signal: new AbortController().signal, maxBytes: 1000, tailBytes: 500,
  });
  const line = 'あいうえお-0123456789\n';
  const rest = result.rest!.out;
  assert.ok(rest.text.startsWith(line), rest.text.slice(0, 40));
  assert.equal(rest.text.length % line.length, 0, '行の途中で終わらない');
  assert.equal(1000 + rest.skipped + Buffer.byteLength(rest.text, 'utf8'), result.totalBytes, '頭 + 飛ばした分 + 尻 = 全部');
});

// ── 安全の審査（TE-3）: 切れ目が秘密の途中に来ても、かけらを出さない ──

const TOKEN = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

function assertNoTokenPiece(content: string): void {
  for (let i = 0; i + 6 <= TOKEN.length; i++) assert.equal(content.includes(TOKEN.slice(i, i + 6)), false, `秘密のかけら ${TOKEN.slice(i, i + 6)} が出た`);
}

// 空白も改行も無い 1 行の JSON。tok の値（TOKEN）が始まる位置を tokenAt バイト目にする
function writeJsonLine(dir: string, tokenAt: number, suffixPad: number, lead = ''): void {
  const pad = tokenAt - lead.length - '{"pad":"'.length - '","tok":"'.length;
  const line = `${lead}{"pad":"${'a'.repeat(pad)}","tok":"${TOKEN}","more":"${'b'.repeat(suffixPad)}"}`;
  writeFileSync(join(dir, 'tok.js'), `process.stdout.write(${JSON.stringify(line)});`);
}

test('TE-3 審査: 尻の始まりが秘密の 8 バイトあとに来ても（改行の無い JSON）、秘密のかけらは出ない', async t => {
  const s = setup(t, 4096);
  const suffix = 4096 + 8 - TOKEN.length - '","more":"'.length - '"}'.length;
  writeJsonLine(s.workspace, 20_000, suffix, `${'z'.repeat(18_000)}\n`);
  const outcome = await s.call({ command: 'node tok.js' });
  assert.equal(outcome.decision, 'allow', outcome.output.content.slice(0, 300));
  assert.match(outcome.output.content, /\[\.\.\. [\d,]+ bytes left out \.\.\.\]/u, '前提: 頭と尻に切れている');
  assertNoTokenPiece(outcome.output.content);
  assert.ok(outcome.output.content.includes('"more":"bbbb'), '尻の残りは見える');
});

test('TE-3 審査: 頭の終わりが秘密の 8 バイトあとに来ても、秘密のかけらは出ない', async t => {
  const s = setup(t, 4096);
  writeJsonLine(s.workspace, 4096 - 8, 20_000);
  const outcome = await s.call({ command: 'node tok.js' });
  assert.equal(outcome.decision, 'allow', outcome.output.content.slice(0, 300));
  assert.match(outcome.output.content, /\[\.\.\. [\d,]+ bytes left out \.\.\.\]/u, '前提: 頭と尻に切れている');
  assertNoTokenPiece(outcome.output.content);
  assert.ok(outcome.output.content.includes('{"pad":"aaaa'), '頭の残りは見える');
});

// 決まった並びの英数字（同じ 6 文字が繰り返さない）
function valueOf(length: number): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let seed = 12345; let out = '';
  for (let i = 0; i < length; i++) { seed = (seed * 1103515245 + 12345) % 2147483648; out += chars[seed % chars.length]; }
  return out;
}

function assertNoValuePiece(content: string, value: string): void {
  for (let i = 0; i + 6 <= value.length; i += 3) assert.equal(content.includes(value.slice(i, i + 6)), false, `値のかけら ${value.slice(i, i + 6)} が出た`);
}

// 改行のある行のあとに 1 行の JSON '{"cookie":"<値>","note":"VISIBLE-REST..."}'。尻（4096 バイト）は値の into バイト目から始まる
function writeCookieLine(dir: string, valueLength: number, into: number): string {
  const value = valueOf(valueLength);
  const lead = `${'z'.repeat(30_000)}\n{"cookie":"`;
  const after = 4096 - (valueLength - into) - '","note":"'.length - '"}'.length;
  const line = `${lead}${value}","note":"VISIBLE-REST${'r'.repeat(after - 'VISIBLE-REST'.length)}"}`;
  writeFileSync(join(dir, 'cookie.js'), `process.stdout.write(${JSON.stringify(line)});`);
  return value;
}

test('TE-3 再審査: 5,000 字の cookie の値の 3,000 バイト目から尻が始まっても、値は出ず、同じ行の値のあとは見える', async t => {
  const s = setup(t, 4096);
  const value = writeCookieLine(s.workspace, 5_000, 3_000);
  const outcome = await s.call({ command: 'node cookie.js' });
  assert.equal(outcome.decision, 'allow', outcome.output.content.slice(0, 300));
  assert.match(outcome.output.content, /\[\.\.\. [\d,]+ bytes left out \.\.\.\]/u, '前提: 頭と尻に切れている');
  assertNoValuePiece(outcome.output.content, value);
  assert.ok(outcome.output.content.includes('VISIBLE-REST'), '行の頭が文脈（8KB）の中にあれば、値のあとは見える');
});

test('TE-3 再審査: 値が文脈（8KB）より長く、行の頭が文脈の外なら、尻の切れた最初の行を出さない', async t => {
  const s = setup(t, 4096);
  const value = writeCookieLine(s.workspace, 20_000, 17_000);
  const outcome = await s.call({ command: 'node cookie.js' });
  assert.match(outcome.output.content, /\[\.\.\. [\d,]+ bytes left out \.\.\.\]/u);
  assertNoValuePiece(outcome.output.content, value);
});
