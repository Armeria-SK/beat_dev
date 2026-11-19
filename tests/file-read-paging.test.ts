import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { resolvePaths } from '../src/paths.ts';
import { PendingStore } from '../src/pending/store.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { fileRead } from '../src/tools/builtin/files.ts';
import { runToolCall, TOOL_OUTPUT_LIMIT } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

// TE-3: file_read は limit が無ければ 2,000 行まで。切れたら（2,000 行でも 16,000 字の上限でも）必ず「offset=N」で続きを示す

function setup(t: { after: (fn: () => void) => void }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config = parseConfig(testConfig());
  const policy = buildPolicy(config, paths);
  const workspace = defaultWorkspace(policy, paths);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config, paths, policy, workspace,
    taint: { tainted: false, sources: [] }, log: () => undefined, permissionMode: 'auto',
  };
  const db = openDatabase(':memory:', MIGRATIONS);
  const registry = new ToolRegistry().register(fileRead);
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const read = async (args: Record<string, unknown>, over: Partial<ToolContext> = {}) => (await runToolCall({ id: `call-${Math.random()}`, name: 'file_read', arguments: args }, { ...ctx, ...over }, {
    registry, approvals: new ApprovalBroker(db), pending, db, emit: () => undefined, permissionMode: () => 'auto',
    autoClassify: async () => '{"decision":"ask","reason":"x"}', lastUserRequest: () => 'read it', conversationTainted: () => false,
  })).output.content;
  const write = (name: string, lines: readonly string[]) => writeFileSync(join(workspace, name), lines.join('\n'));
  return { read, write, dir: workspace };
}

const HINT = /\n\n\[Lines (\d+) to (\d+) of (\d+)\. Read on with offset=(\d+)\]$/u;

// 返ってきた offset をたどって最後まで読み、つないだ行を返す
async function readAll(s: ReturnType<typeof setup>, path: string, over: Partial<ToolContext> = {}): Promise<{ lines: string[]; calls: number }> {
  const lines: string[] = [];
  let offset = 1;
  for (let calls = 1; calls < 100; calls++) {
    const out = await s.read({ path, offset }, over);
    const hint = HINT.exec(out);
    assert.doesNotMatch(out, /characters were returned/u, 'パイプラインの切りに頼らず、file_read が行の切れ目で切る');
    lines.push(...(hint ? out.slice(0, hint.index) : out).split('\n'));
    if (!hint) return { lines, calls };
    assert.equal(Number(hint[1]), offset);
    assert.equal(Number(hint[4]), Number(hint[2]) + 1);
    offset = Number(hint[4]);
  }
  throw new Error('終わらない');
}

test('TE-3: 3,000 行のファイルは、limit なしで 2,000 行と「offset=2001」。続きは offset=2001 で最後まで', async t => {
  const s = setup(t);
  const lines = Array.from({ length: 3000 }, (_, i) => `L${i + 1}`);
  s.write('three.txt', lines);
  const first = await s.read({ path: 'three.txt' });
  assert.ok(first.endsWith('\n\n[Lines 1 to 2000 of 3000. Read on with offset=2001]'), first.slice(-80));
  assert.equal(first.slice(0, first.lastIndexOf('\n\n[')), lines.slice(0, 2000).join('\n'));
  assert.equal(await s.read({ path: 'three.txt', offset: 2001 }), lines.slice(2000).join('\n'), '最後の頁には案内が無い');
  assert.equal(await s.read({ path: 'three.txt', offset: 2001, limit: 5 }), `${lines.slice(2000, 2005).join('\n')}\n\n[Lines 2001 to 2005 of 3000. Read on with offset=2006]`, 'limit は今までどおり効く');
});

test('TE-3: 2,000 行に満たなくても 16,000 字に収まらなければ、行の切れ目で切って「offset=N」を返し、たどると全部が元どおり', async t => {
  const s = setup(t);
  const lines = Array.from({ length: 1500 }, (_, i) => `row ${String(i + 1).padStart(5, '0')} ${'v'.repeat(20)}`);
  s.write('wide.txt', lines);
  const first = await s.read({ path: 'wide.txt' });
  const hint = HINT.exec(first);
  assert.ok(hint, first.slice(-120));
  assert.ok(Number(hint[2]) < 1500 && first.length <= TOOL_OUTPUT_LIMIT, `${hint[2]} 行・${first.length} 字`);
  assert.ok(first.length > TOOL_OUTPUT_LIMIT - 600, `上限の近くまで使う: ${first.length}`);
  const all = await readAll(s, 'wide.txt');
  assert.deepEqual(all.lines, lines);
  assert.equal(all.calls, 3);
});

test('TE-3: 使える量（outputTokens）が小さくても、案内の行は残り、たどると全部が元どおり', async t => {
  const s = setup(t);
  const lines = Array.from({ length: 300 }, (_, i) => `item ${i + 1}: ${'w'.repeat(30)}`);
  s.write('tight.txt', lines);
  const first = await s.read({ path: 'tight.txt' }, { outputTokens: 600 });
  assert.match(first, HINT);
  assert.ok(first.length < 2_400, `${first.length}`);
  assert.deepEqual((await readAll(s, 'tight.txt', { outputTokens: 600 })).lines, lines);
});

test('TE-3: 伏せ字で長くなる行が並んでも、案内の行はパイプラインに切られない', async t => {
  const s = setup(t);
  const lines = Array.from({ length: 1900 }, (_, i) => `PASSWORD=${i % 10}`);
  s.write('secrets.env.txt', lines);
  const first = await s.read({ path: 'secrets.env.txt' });
  assert.match(first, HINT);
  assert.doesNotMatch(first, /PASSWORD=\d/u, '伏せ字は効いている');
  const all = await readAll(s, 'secrets.env.txt');
  assert.equal(all.lines.length, 1900);
  assert.ok(all.lines.every(line => line === 'PASSWORD=[REDACTED]'), all.lines.find(line => line !== 'PASSWORD=[REDACTED]'));
});

test('TE-3: 1 行が 16,000 字より長いときは、伏せたあとの行の頭と、次の行の offset を返す（秘密のかけらは出ない）', async t => {
  const s = setup(t);
  const secret = 'sk-ant-api03-Zq7Wm3Xr9Lp2Vn5Tb8Hc4Jd6Kf1Gs0';
  s.write('minified.js', [`${'c'.repeat(15_590)} ${secret} ${'d'.repeat(5_000)}`, 'second line']);
  const out = await s.read({ path: 'minified.js' });
  assert.ok(out.endsWith('. Read the following lines with offset=2]'), out.slice(-160));
  assert.match(out, /\[Line 1 of 2 is [\d,]+ characters long, so only its first [\d,]+ characters were returned/u);
  assert.equal(out.includes('Zq7Wm3'), false, '秘密のかけらが出た');
  assert.equal(out.includes('sk-ant'), false);
  assert.equal(await s.read({ path: 'minified.js', offset: 2 }), 'second line');
});

// ── 安全の審査（TE-3）: 伏せ字はファイル全体に掛けてから頁に分ける ──

test('TE-3 審査: 頁が秘密鍵の途中で切れても、どの頁にも鍵の中身が出ない（outputTokens 600 で最後まで）', async t => {
  const s = setup(t);
  const body = Array.from({ length: 52 }, (_, i) => `KEYBODY${String(i).padStart(2, '0')}${'Q'.repeat(55)}`);
  const lines = ['intro line', '-----BEGIN PRIVATE KEY-----', ...body, '-----END PRIVATE KEY-----', ...Array.from({ length: 400 }, (_, i) => `filler ${i + 1}`)];
  assert.equal(body[0]!.length, 64);
  s.write('key.txt', lines);
  const seen: string[] = [];
  let offset = 1;
  for (let calls = 0; calls < 200; calls++) {
    const out = await s.read({ path: 'key.txt', offset }, { outputTokens: 600 });
    seen.push(out);
    assert.doesNotMatch(out, /KEYBODY\d\d/u, `offset=${offset} の頁に鍵の中身が出た`);
    const hint = HINT.exec(out);
    if (!hint) break;
    offset = Number(hint[4]);
  }
  assert.ok(seen.length > 2, '前提: 何頁にも分かれる');
  assert.ok(seen.at(-1)!.endsWith('filler 400'), '最後まで読める');
  assert.match(seen.join('\n'), /filler 1\n/u, '鍵のあとの行は、行の番号がずれずに続く');
  for (const limit of [1, 3, 10]) assert.doesNotMatch(await s.read({ path: 'key.txt', offset: 3, limit }), /KEYBODY\d\d/u, `limit=${limit} で鍵の途中から読んでも出ない`);
});

test('TE-3 審査: YAML の password: が 2,000 行目で値が 2,001 行目でも、どちらの頁にも値が出ない', async t => {
  const s = setup(t);
  const lines = [...Array.from({ length: 1999 }, () => 'k'), 'password:', '  hunter2secretvalue', 'after: ok'];
  s.write('conf.yaml', lines);
  const first = await s.read({ path: 'conf.yaml' });
  assert.ok(first.endsWith('[Lines 1 to 2000 of 2002. Read on with offset=2001]'), first.slice(-80));
  const second = await s.read({ path: 'conf.yaml', offset: 2001 });
  assert.equal(second.split('\n').at(-1), 'after: ok', '行の番号はずれない');
  assert.equal(`${first}\n${second}`.includes('hunter2'), false);
  assert.equal((await s.read({ path: 'conf.yaml', offset: 2001, limit: 1 })).includes('hunter2'), false, 'limit を付けた読み方でも出ない');
});

test('TE-3 審査: 頁が BEGIN の行でちょうど終わっても、offset=2001 の案内は消えない', async t => {
  const s = setup(t);
  const lines = [...Array.from({ length: 1999 }, (_, i) => `n${i}`), '-----BEGIN PRIVATE KEY-----', ...Array.from({ length: 30 }, () => 'B'.repeat(64)), '-----END PRIVATE KEY-----'];
  s.write('edge.txt', lines);
  const out = await s.read({ path: 'edge.txt' });
  assert.ok(out.endsWith('\n\n[Lines 1 to 2000 of 2031. Read on with offset=2001]'), out.slice(-120));
  assert.equal(out.includes('BBBBBBBB'), false);
});

test('TE-3 審査: 改行で終わる 2,000 行のファイルは、末尾の空の行を数えず 1 回で読み終わる', async t => {
  const s = setup(t);
  const lines = Array.from({ length: 2000 }, (_, i) => `r${i + 1}`);
  writeFileSync(join(s.dir, 'ends.txt'), `${lines.join('\n')}\n`);
  const out = await s.read({ path: 'ends.txt' });
  assert.equal(out, lines.join('\n'), '案内（of 2001）が付かない');
});

test('TE-3 再審査: 伏せ字の窓（頁の前後 300 行）の両端を秘密鍵がまたいでも（BEGIN も END も窓の外）、鍵の中身は出ない', async t => {
  const s = setup(t);
  const body = Array.from({ length: 800 }, (_, i) => `KEYBODY${String(i).padStart(3, '0')}${'Q'.repeat(54)}`);
  const lines = [...Array.from({ length: 9 }, (_, i) => `head ${i}`), '-----BEGIN PRIVATE KEY-----', ...body, '-----END PRIVATE KEY-----', ...Array.from({ length: 1000 }, (_, i) => `tail ${i}`)];
  s.write('long-key.txt', lines);
  for (const [offset, limit] of [[350, 20], [805, 30], [20, 5]] as const) {
    const out = await s.read({ path: 'long-key.txt', offset, limit });
    assert.doesNotMatch(out, /KEYBODY\d{3}/u, `offset=${offset} limit=${limit}`);
    assert.ok(out.endsWith(`Read on with offset=${offset + limit}]`), out.slice(-80));
  }
  assert.equal((await s.read({ path: 'long-key.txt', offset: 812, limit: 1 })).split('\n')[0], 'tail 0', '行の番号はずれない');
});
