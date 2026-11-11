import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MCP_ENV_NAME_PATTERN, MCP_HEADER_NAME_PATTERN, MCP_ID_PATTERN } from '../src/config/schema.ts';
import { en } from '../web/src/i18n/en.ts';
import { accessWidening, mcpSecretAccess } from '../web/src/settings/access.ts';
import {
  addBody, addProblem, argsFromText, attempt, emptyAddForm, idFromName, previewAdd, previewServer, previewTool, reasonKey, revealHidden, sameShape, scrubSecrets, shapeChanges, summarize, tone,
  PATTERNS,
} from '../web/src/settings/mcp-model.ts';
import { SECTION_GROUPS, sectionSlice, type Config } from '../web/src/settings/model.ts';

// AU-5b-2: 設定の「MCP サーバー」の、画面を使わない部分（広がる変更の検出・追加フォームの組み立て・失敗の扱い・節の登録・文言）

const server = (over: Record<string, unknown> = {}) => ({
  id: 'files', transport: 'stdio', enabled: true, localOk: false, tools: {}, command: ['node', 'srv.mjs'], env: {}, headers: {}, ...over,
});
const config = (...servers: Array<Record<string, unknown>>): Config => ({ mcp: { servers, limits: { maxServers: 4 } } } as unknown as Config);

// ---- T-51: on にする操作は確かめ、off にする操作は確かめない ----

test('サーバーを off → on にするときだけ確かめる', () => {
  const off = config(server({ enabled: false }));
  assert.deepEqual(accessWidening(off, previewServer(off, 'files', { enabled: true })), [{ kind: 'mcp-server-enabled', id: 'files' }]);
  const on = config(server());
  assert.deepEqual(accessWidening(on, previewServer(on, 'files', { enabled: false })), []);
  assert.deepEqual(accessWidening(on, previewServer(on, 'files', { enabled: true })), []);
});

test('「手元のモデルの会話にも使う」を on にするときだけ確かめる', () => {
  const closed = config(server());
  assert.deepEqual(accessWidening(closed, previewServer(closed, 'files', { localOk: true })), [{ kind: 'mcp-server-local', id: 'files' }]);
  const open = config(server({ localOk: true }));
  assert.deepEqual(accessWidening(open, previewServer(open, 'files', { localOk: false })), []);
});

test('道具を on にする: 設定に無い道具を足す・enabled:false から戻すは確かめる。off にするのは確かめない', () => {
  const none = config(server());
  assert.deepEqual(accessWidening(none, previewTool(none, 'files', 'read_file', { enabled: true })), [{ kind: 'mcp-tool-added', id: 'files', tool: 'read_file' }]);
  const off = config(server({ tools: { read_file: { enabled: false } } }));
  assert.deepEqual(accessWidening(off, previewTool(off, 'files', 'read_file', { enabled: true })), [{ kind: 'mcp-tool-enabled', id: 'files', tool: 'read_file' }]);
  const on = config(server({ tools: { read_file: {} } }));
  assert.deepEqual(accessWidening(on, previewTool(on, 'files', 'read_file', { enabled: false })), []);
  // 設定に無い道具を「off」で書き足すのは、登録しないままなので確かめない
  assert.deepEqual(accessWidening(none, previewTool(none, 'files', 'read_file', { enabled: false })), []);
});

test('申告を緩める（読むだけ・送らない・消さない）ときは確かめる。厳しくする向きは確かめない', () => {
  const strict = config(server({ tools: { t: { effect: 'write', sends: true, removes: true } } }));
  assert.deepEqual(accessWidening(strict, previewTool(strict, 'files', 't', { effect: 'read' })), [{ kind: 'mcp-tool-loosened', id: 'files', tool: 't' }]);
  assert.deepEqual(accessWidening(strict, previewTool(strict, 'files', 't', { sends: false })), [{ kind: 'mcp-tool-loosened', id: 'files', tool: 't' }]);
  assert.deepEqual(accessWidening(strict, previewTool(strict, 'files', 't', { removes: false })), [{ kind: 'mcp-tool-loosened', id: 'files', tool: 't' }]);
  assert.deepEqual(accessWidening(strict, previewTool(strict, 'files', 't', { removes: null })), [{ kind: 'mcp-tool-loosened', id: 'files', tool: 't' }]);
  // 未指定は「外へ出る・送りうる」として確かめられるので、そこから declared へ動くのも緩み
  const unset = config(server({ tools: { t: {} } }));
  assert.deepEqual(accessWidening(unset, previewTool(unset, 'files', 't', { effect: 'read' })), [{ kind: 'mcp-tool-loosened', id: 'files', tool: 't' }]);
  assert.deepEqual(accessWidening(unset, previewTool(unset, 'files', 't', { sends: false })), [{ kind: 'mcp-tool-loosened', id: 'files', tool: 't' }]);
  const loose = config(server({ tools: { t: { effect: 'read', sends: false } } }));
  assert.deepEqual(accessWidening(loose, previewTool(loose, 'files', 't', { effect: 'network' })), []);
  assert.deepEqual(accessWidening(loose, previewTool(loose, 'files', 't', { sends: true })), []);
  assert.deepEqual(accessWidening(loose, previewTool(loose, 'files', 't', { effect: null })), []);
  assert.deepEqual(accessWidening(unset, previewTool(unset, 'files', 't', { effect: 'write' })), []);
});

test('サーバーを足す: 足したこと・宛先・渡す欄の名前を並べる。道具は空なので道具の確かめは出ない', () => {
  const none = config();
  const stdio = previewAdd(none, { id: 'files', transport: 'stdio', command: ['node', 'srv.mjs'], secretNames: ['TOKEN'] });
  assert.deepEqual(accessWidening(none, stdio), [
    { kind: 'mcp-server-added', id: 'files', transport: 'stdio', target: 'node srv.mjs' },
    { kind: 'mcp-server-env', id: 'files', names: ['TOKEN'] },
  ]);
  const http = previewAdd(none, { id: 'web', transport: 'http', url: 'https://mcp.example.com/sse', secretNames: ['Authorization'] });
  assert.deepEqual(accessWidening(none, http), [
    { kind: 'mcp-server-added', id: 'web', transport: 'http', target: 'https://mcp.example.com/sse' },
    { kind: 'mcp-server-env', id: 'web', names: ['Authorization'] },
  ]);
  assert.deepEqual(accessWidening(none, previewAdd(none, { id: 'plain', transport: 'stdio', command: ['node'], secretNames: [] })), [
    { kind: 'mcp-server-added', id: 'plain', transport: 'stdio', target: 'node' },
  ]);
});

test('宛先（command・cwd・url）や、渡す欄が変わるのも確かめる', () => {
  const base = config(server());
  assert.deepEqual(accessWidening(base, config(server({ command: ['node', 'other.mjs'] }))), [{ kind: 'mcp-server-target', id: 'files', target: 'node other.mjs' }]);
  assert.deepEqual(accessWidening(base, config(server({ cwd: '/work' }))), [{ kind: 'mcp-server-target', id: 'files', target: 'node srv.mjs (cwd: /work)' }]);
  // 引数の区切りだけが変わる（["a b"] と ["a","b"]）のも、宛先が変わったこと
  const joined = config(server({ command: ['node', 'a b'] }));
  assert.equal(accessWidening(joined, config(server({ command: ['node', 'a', 'b'] }))).length, 1);
  const web = config(server({ transport: 'http', command: undefined, url: 'https://a.example.com/' }));
  assert.deepEqual(accessWidening(web, config(server({ transport: 'http', command: undefined, url: 'https://b.example.com/' }))), [{ kind: 'mcp-server-target', id: 'files', target: 'https://b.example.com/' }]);
  assert.deepEqual(accessWidening(base, config(server({ env: { TOKEN: 'CLIVE_MCP_FILES_E_TOKEN_SECRET' } }))), [{ kind: 'mcp-server-env', id: 'files', names: ['TOKEN'] }]);
  const withEnv = config(server({ env: { TOKEN: 'A_SECRET' } }));
  assert.deepEqual(accessWidening(withEnv, config(server({ env: { TOKEN: 'B_SECRET' } }))), [{ kind: 'mcp-server-env', id: 'files', names: ['TOKEN'] }]);
  // 欄を減らすのは確かめない
  assert.deepEqual(accessWidening(withEnv, base), []);
  assert.deepEqual(accessWidening(base, base), []);
});

test('秘密の値を入れる・変えるときは確かめる。設定にないサーバーは確かめない', () => {
  const c = config(server({ env: { TOKEN: 'CLIVE_MCP_FILES_E_TOKEN_SECRET' } }));
  assert.deepEqual(mcpSecretAccess({ id: 'files', kind: 'env', name: 'TOKEN' }, c), [{ kind: 'mcp-server-secret', id: 'files', name: 'TOKEN' }]);
  assert.deepEqual(mcpSecretAccess({ id: 'ghost', kind: 'env', name: 'TOKEN' }, c), []);
});

test('上限（mcp.limits）を上げるのは共用の確かめに出る', () => {
  const a = { mcp: { servers: [], limits: { maxServers: 2 } } } as unknown as Config;
  const b = { mcp: { servers: [], limits: { maxServers: 4 } } } as unknown as Config;
  assert.deepEqual(accessWidening(a, b), [{ kind: 'limit-raised', key: 'mcp.maxServers', from: 2, to: 4 }]);
});

// ---- T-52: 追加フォーム ----

test('引数は 1 行に 1 つ。空白や引用符はそのまま 1 つの引数で、シェルとして読まない', () => {
  assert.deepEqual(argsFromText('-y\n@scope/server\n--root\n/tmp/a b'), ['-y', '@scope/server', '--root', '/tmp/a b']);
  assert.deepEqual(argsFromText('--name="a b"\r\n$HOME\r\n`x`\r\n; rm -rf /'), ['--name="a b"', '$HOME', '`x`', '; rm -rf /']);
  assert.deepEqual(argsFromText('a\n\n   \nb\n'), ['a', 'b']);
  assert.deepEqual(argsFromText(''), []);
});

test('追加の本文: stdio はプログラム＋引数の配列・環境変数。http は URL・見出し。空の欄は送らない', () => {
  const form = { ...emptyAddForm(), id: 'files', transport: 'stdio' as const, program: ' npx ', args: '-y\n@scope/server --flag', cwd: ' ', rows: [{ name: 'API_TOKEN', value: 's3cret-value' }, { name: '', value: '' }] };
  assert.deepEqual(addBody(form), { id: 'files', transport: 'stdio', command: ['npx', '-y', '@scope/server --flag'], secrets: { env: { API_TOKEN: 's3cret-value' } } });
  const web = { ...emptyAddForm(), id: 'web', transport: 'http' as const, url: ' https://mcp.example.com/sse ', rows: [{ name: 'Authorization', value: 'Bearer abc' }] };
  assert.deepEqual(addBody(web), { id: 'web', transport: 'http', url: 'https://mcp.example.com/sse', secrets: { headers: { Authorization: 'Bearer abc' } } });
  assert.deepEqual(addBody({ ...form, cwd: '/work', rows: [] }), { id: 'files', transport: 'stdio', command: ['npx', '-y', '@scope/server --flag'], cwd: '/work' });
});

test('送ったあと、秘密の値は画面の状態に残らない（名前だけ残る）', () => {
  const form = { ...emptyAddForm(), id: 'files', program: 'npx', rows: [{ name: 'API_TOKEN', value: 's3cret-value' }, { name: 'B', value: 'another-secret' }] };
  const after = scrubSecrets(form);
  assert.doesNotMatch(JSON.stringify(after), /s3cret-value|another-secret/u);
  assert.deepEqual(after.rows.map(r => r.name), ['API_TOKEN', 'B']);
  // 元の状態は書き換えない
  assert.equal(form.rows[0]!.value, 's3cret-value');
});

test('追加の入力の誤りを、送る前に見つける', () => {
  const ok = { ...emptyAddForm(), id: 'files', program: 'node', args: 'srv.mjs' };
  assert.equal(addProblem(ok, []), null);
  assert.equal(addProblem({ ...ok, id: '' }, []), 'id');
  assert.equal(addProblem({ ...ok, id: 'Files' }, []), 'id');
  assert.equal(addProblem({ ...ok, id: '1files' }, []), 'id');
  assert.equal(addProblem(ok, ['files']), 'taken');
  assert.equal(addProblem({ ...ok, program: '  ' }, []), 'program');
  assert.equal(addProblem({ ...ok, rows: [{ name: '1bad', value: 'x' }] }, []), 'secret_name');
  assert.equal(addProblem({ ...ok, rows: [{ name: 'A', value: '' }] }, []), 'secret_value');
  assert.equal(addProblem({ ...ok, rows: [{ name: 'A', value: 'x' }, { name: 'A', value: 'y' }] }, []), 'secret_name');
  const web = { ...emptyAddForm(), id: 'web', transport: 'http' as const, url: 'https://mcp.example.com/sse' };
  assert.equal(addProblem(web, []), null);
  assert.equal(addProblem({ ...web, url: '' }, []), 'url');
  assert.equal(addProblem({ ...web, url: 'ftp://x.example.com' }, []), 'url');
  assert.equal(addProblem({ ...web, url: 'http://mcp.example.com' }, []), 'url');
  assert.equal(addProblem({ ...web, url: 'http://127.0.0.1:8080/mcp' }, []), null);
  // http の見出しの名前は、環境変数の名前の形ではなく見出しの形
  assert.equal(addProblem({ ...web, rows: [{ name: 'X-Api-Key', value: 'k' }] }, []), null);
  assert.equal(addProblem({ ...ok, rows: [{ name: 'X-Api-Key', value: 'k' }] }, []), 'secret_name');
});

test('id は名前から作る（小文字・数字だけ、先頭は英字、16 字まで）', () => {
  assert.equal(idFromName('Files Server'), 'filesserver');
  assert.equal(idFromName('GitHub MCP!'), 'githubmcp');
  assert.equal(idFromName('123abc'), 'abc');
  assert.equal(idFromName('averyveryverylongservername'), 'averyveryverylon');
  assert.equal(idFromName('日本語'), '');
  assert.match(idFromName('Files Server'), new RegExp(MCP_ID_PATTERN, 'u'));
});

test('画面で使う名前の形は、設定のスキーマと同じ', () => {
  assert.equal(PATTERNS.envName.source, MCP_ENV_NAME_PATTERN);
  assert.equal(PATTERNS.headerName.source, MCP_HEADER_NAME_PATTERN);
  assert.equal(PATTERNS.id.source, MCP_ID_PATTERN);
});

// ---- T-53: 失敗は黙って戻さない ----

test('失敗した操作は toast と誤りの欄の両方に出る。成功のときは出ない', async () => {
  const seen: string[] = [];
  const shown: string[] = [];
  const failed = await attempt(async () => { throw new Error('boom'); }, { describe: e => `失敗: ${(e as Error).message}`, onError: m => seen.push(m), notify: m => shown.push(m) });
  assert.equal(failed, false);
  assert.deepEqual(seen, ['失敗: boom']);
  assert.deepEqual(shown, ['失敗: boom']);
  const okResult = await attempt(async () => 1, { describe: () => 'x', onError: m => seen.push(m), notify: m => shown.push(m) });
  assert.equal(okResult, true);
  assert.equal(seen.length, 1);
  assert.equal(shown.length, 1);
});

// ---- 状態の見せ方 ----

test('状態の色の種類と、説明が変わって止まっている・切られている道具の数', () => {
  assert.equal(tone('ready'), 'ok');
  assert.equal(tone('connecting'), 'busy');
  assert.equal(tone('failed'), 'bad');
  assert.equal(tone('off'), 'off');
  const tools = (states: string[]) => states.map((state, i) => ({ name: `t${i}`, registered: `mcp_x_t${i}`, state, description: '' }));
  assert.deepEqual(summarize({ tools: tools(['registered', 'changed', 'changed', 'cut', 'off', 'unlisted']) } as never), { changed: 2, cut: 1, registered: 1 });
  assert.deepEqual(summarize({ tools: [] } as never), { changed: 0, cut: 0, registered: 0 });
});

test('理由の語は、画面の文言に対応する。知らない語は「その他」になる', () => {
  for (const reason of ['env_missing', 'connect_failed', 'timeout', 'list_failed', 'too_many_restarts', 'dropped', 'not_connected']) {
    const key = reasonKey(reason);
    assert.notEqual(key, 'settings.mcp.reason.other', reason);
    assert.ok(key in en, key);
  }
  assert.equal(reasonKey('something new'), 'settings.mcp.reason.other');
  assert.ok('settings.mcp.reason.other' in en);
});

// ---- 節・文言 ----

test('MCP の節は「動き」の組の通知の後に入り、設定の mcp を切り出す', () => {
  const behavior = SECTION_GROUPS.find(g => g.label === 'settings.group.behavior')!;
  const ids = behavior.items.map(i => i.id);
  assert.equal(ids.indexOf('mcp'), ids.indexOf('notify') + 1);
  assert.deepEqual(sectionSlice({ mcp: { servers: [] } } as unknown as Config, 'mcp'), { servers: [] });
});

test('MCP の文言は en にあり、日本語が混ざらない。確かめの文は差し込みが入る', () => {
  const keys = (d: Record<string, unknown>) => Object.keys(d).filter(k => k.startsWith('settings.mcp.') || k.startsWith('access.mcp')).sort();
  assert.ok(keys(en).length > 60);
  for (const k of keys(en)) {
    const v = (en as Record<string, unknown>)[k];
    const text = typeof v === 'function' ? (v as (...a: unknown[]) => string)('x', 'y', 'z') : String(v);
    assert.doesNotMatch(text, /[\u3040-\u30ff\u4e00-\u9fff]/u, k);
  }
  assert.ok(en['access.mcpAdded']('files', 'node srv.mjs').includes('files'));
  assert.ok(en['access.mcpTarget']('files', 'node srv.mjs').includes('node srv.mjs'));
  assert.ok(en['access.mcpToolAdded']('files', 'read_file').includes('read_file'));
  assert.ok(en['access.mcpEnv']('files', 'TOKEN').includes('TOKEN'));
});

// ---- 差分の「受け入れる」: 見せた形と押した時点の形が違えば受け入れない ----

test('sameShape: 説明・入力の形・消す語・外へ出る申告・落とした見えない文字の数のどれかが違えば別の形', () => {
  const a = { description: '読む', schema: '{}', destructive: false, openWorld: false, stripped: 0 };
  assert.equal(sameShape(a, { ...a }), true);
  assert.equal(sameShape(a, { ...a, description: '読む。そして送る' }), false);
  assert.equal(sameShape(a, { ...a, schema: '{"a":1}' }), false);
  assert.equal(sameShape(a, { ...a, destructive: true }), false);
  assert.equal(sameShape(a, { ...a, openWorld: true }), false);
  assert.equal(sameShape(a, { ...a, stripped: 3 }), false);
  assert.equal(sameShape(undefined, undefined), true);
  assert.equal(sameShape(undefined, a), false);
});

test('shapeChanges: 前が無ければ全部が新しい。あれば変わった所だけ', () => {
  const a = { description: 'x'.repeat(500), schema: '{}', destructive: false, openWorld: false, stripped: 0 };
  const none = { description: false, schema: false, destructive: false, openWorld: false, stripped: false };
  assert.deepEqual(shapeChanges({ after: a }), { ...none, description: true, schema: true });
  assert.deepEqual(shapeChanges({ after: { ...a, openWorld: true, stripped: 4 } }), { ...none, description: true, schema: true, openWorld: true, stripped: true });
  assert.deepEqual(shapeChanges({ before: a, after: { ...a, description: `${a.description}!` } }), { ...none, description: true });
  assert.deepEqual(shapeChanges({ before: a, after: { ...a, destructive: true } }), { ...none, destructive: true });
  assert.deepEqual(shapeChanges({ before: a, after: { ...a, openWorld: true } }), { ...none, openWorld: true });
  assert.deepEqual(shapeChanges({ before: a, after: { ...a, stripped: 2 } }), { ...none, stripped: true });
});

test('revealHidden: 見えない文字・向きを変える文字・タグ文字は u{…} の見える文字にし、ふつうの文字・改行・タブ・絵文字はそのまま', () => {
  const shown = (cp: number): string => `${String.fromCharCode(92)}u{${cp.toString(16).toUpperCase()}}`;
  assert.equal(revealHidden('a\u{e0041}b'), `a${shown(0xe0041)}b`);
  assert.equal(revealHidden('x\u{202e}y\u{200b}z'), `x${shown(0x202e)}y${shown(0x200b)}z`);
  assert.equal(revealHidden('\u{fe0f}\u{2028}\u{ad}\u{0}\u{9f}'), [0xfe0f, 0x2028, 0xad, 0, 0x9f].map(shown).join(''));
  assert.equal(revealHidden(String.fromCodePoint(0x3164, 0x2800, 0x34f, 0x115f, 0xffa0)), [0x3164, 0x2800, 0x34f, 0x115f, 0xffa0].map(shown).join(''), '空白に見える文字も');
  assert.equal(revealHidden('日本語 text\n\t{"a":"b"} 😀'), '日本語 text\n\t{"a":"b"} 😀');
  assert.equal(revealHidden(String.fromCharCode(0xd800)), shown(0xd800), '対の無いサロゲートも見える形にする');
});