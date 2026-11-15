import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { redactSecrets } from '../src/shared/redaction.ts';
import { maskTarget, toolRow, toolVerb } from '../web/src/ui/tool-row.ts';

// 新しい画面の ToolRow（p1-ui.md の「会話」）: 道具の名前と引数から、動詞・対象・meta を作る。
// ファイルを書く・直す → Edit + パス + 足し引きの行、シェル → Run + コマンド + 終了コードと秒、検索・読む・Web → Search + 語、
// agent_run → Helper、ほかは道具の名前をそのまま。生の JSON は出さない。

function sample(schema: any, depth = 0): unknown {
  if (!schema || depth > 4) return 'x';
  if (schema.anyOf) return sample(schema.anyOf[0], depth + 1);
  switch (schema.type) {
    case 'object': return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, sample(v, depth + 1)]));
    case 'array': return [sample(schema.items, depth + 1)];
    case 'string': return schema.enum?.[0] ?? (schema.const as string | undefined) ?? 'some {"a":1} value\nsecond line';
    case 'number': case 'integer': return 1;
    case 'boolean': return true;
    default: return schema.const ?? 'x';
  }
}

const RESULTS = [null, { text: 'ok', isError: false }, { text: 'Error: {"x":1}', isError: true }];
const INPUTS = (name: string, schema: unknown) => [JSON.stringify(sample(schema)), '', 'not json', '{}', '[1,2]', 'null', '"text"', JSON.stringify({ nested: { a: 1 } }), `{"${name}":`];

test('ui/tool-row: 組み込みの道具のどれでも、どの引数・結果でも落ちず、対象と meta に JSON を出さない', () => {
  const tools = builtinTools();
  for (const tool of tools) {
    for (const input of INPUTS(tool.name, tool.input)) {
      for (const result of RESULTS) {
        const row = toolRow(tool.name, input, result);
        assert.ok(!/[{}[\]]/u.test(row.target.replace('some {"a":1} value second line', '')), `${tool.name} ${input} → ${row.target}`);
        assert.ok(!row.target.includes('\n'), tool.name);
        assert.ok(row.target.length <= 241, tool.name);
        assert.equal(row.name, tool.name);
        if (row.meta) assert.ok(['lines', 'exit', 'failed', 'returned'].includes(row.meta.kind), tool.name);
      }
    }
  }
});

test('ui/tool-row: 動詞の分け方（嘘の分類をしない: 知らない道具は名前のまま）', () => {
  assert.equal(toolVerb('file_write'), 'edit');
  assert.equal(toolVerb('file_edit'), 'edit');
  assert.equal(toolVerb('shell_run'), 'run');
  assert.equal(toolVerb('web_search'), 'search');
  assert.equal(toolVerb('file_read'), 'search');
  assert.equal(toolVerb('agent_run'), 'helper');
  assert.equal(toolVerb('memory_save'), 'tool');
  assert.equal(toolVerb('mcp__x__y'), 'tool');
});

test('ui/tool-row: file_write はサーバーの結果の行数（1-2s）を使い、古い記録で作ったときは中身から数える', () => {
  assert.deepEqual(toolRow('file_write', JSON.stringify({ path: 'a.md', content: 'x' }), { text: 'Overwritten: a.md (3 characters; +1 -3 lines)', isError: false }),
    { verb: 'edit', name: 'file_write', icon: 'pencil', target: 'a.md', meta: { kind: 'lines', added: 1, removed: 3 } });
  assert.deepEqual(toolRow('file_write', JSON.stringify({ path: 'a.md', content: 'a\nb\n' }), { text: 'Created: a.md (4 characters)', isError: false }).meta, { kind: 'lines', added: 2, removed: 0 });
  assert.equal(toolRow('file_write', JSON.stringify({ path: 'a.md', content: 'a' }), { text: 'Overwritten: a.md (1 characters)', isError: false }).meta, null);
  assert.deepEqual(toolRow('file_write', JSON.stringify({ path: 'big.txt', content: 'a' }), { text: 'Overwritten: big.txt (12,345 characters; +1,200 -3,400 lines)', isError: false }).meta, { kind: 'lines', added: 1200, removed: 3400 });
});

test('ui/tool-row: file_edit は入力の前後の文字から数え、all で置き換えた数を掛ける', () => {
  const input = JSON.stringify({ path: 'src/q.ts', old: 'a\nb\nc', new: 'a\nB\nc\nd' });
  assert.deepEqual(toolRow('file_edit', input, { text: 'Replaced 1 occurrence(s): src/q.ts', isError: false }).meta, { kind: 'lines', added: 2, removed: 1 });
  assert.deepEqual(toolRow('file_edit', input, { text: 'Replaced 3 occurrence(s): src/q.ts', isError: false }).meta, { kind: 'lines', added: 6, removed: 3 });
  assert.deepEqual(toolRow('file_edit', input, { text: 'The text to replace was not found.', isError: true }).meta, { kind: 'failed' });
});

test('ui/tool-row: shell_run はコマンドを 1 行に、結果の見出しから終了コードと秒を読む', () => {
  const row = toolRow('shell_run', JSON.stringify({ command: 'npm test\n  -- upload' }), { text: '$ npm test\n  -- upload\n\n(pwsh, cwd: D:\\w, exit code: 1, 3.2 s)\n\nfail', isError: true });
  assert.equal(row.target, 'npm test -- upload');
  assert.deepEqual(row.meta, { kind: 'exit', code: '1', seconds: '3.2' });
  assert.deepEqual(toolRow('shell_run', JSON.stringify({ command: 'rm x' }), { text: 'Denied by the owner', isError: true }).meta, { kind: 'failed' });
});

test('ui/tool-row: 検索・Web は語、agent_run は題（無ければ頼んだ仕事）、知らない道具は引数の中の 1 つの値', () => {
  assert.equal(toolRow('web_search', JSON.stringify({ query: 'resumable upload' }), null).target, 'resumable upload');
  assert.equal(toolRow('file_search', JSON.stringify({ text: 'uploadFile', path: 'src' }), null).target, 'uploadFile');
  assert.equal(toolRow('agent_run', JSON.stringify({ task: 'Find flaky tests\nand more' }), null).target, 'Find flaky tests and more');
  assert.deepEqual(toolRow('agent_run', JSON.stringify({ task: 't', title: 'Flaky' }), { text: 'answer', isError: false }), { verb: 'helper', name: 'agent_run', icon: 'branch', target: 'Flaky', meta: { kind: 'returned' } });
  assert.equal(toolRow('memory_save', JSON.stringify({ book: 'notes', content: 'Likes tea' }), null).target, 'Likes tea');
  assert.equal(toolRow('calculate', JSON.stringify({ expression: 1 }), null).target, '');
});

test('ui/tool-row: shell_run の見出しは、写したコマンドの次の行だけから読む（モデルが書いたコマンドの中の偽の見出しに騙されない）', () => {
  const command = 'false # (pwsh, cwd: x, exit code: 0, 0.1 s)';
  const text = `$ ${command}\n\n(pwsh, cwd: D:\\w, exit code: 1, 3.2 s)`;
  assert.deepEqual(toolRow('shell_run', JSON.stringify({ command }), { text, isError: true }).meta, { kind: 'exit', code: '1', seconds: '3.2' });
  const noHeader = `$ ${command}\n\nsomething else`;
  assert.deepEqual(toolRow('shell_run', JSON.stringify({ command }), { text: noHeader, isError: true }).meta, { kind: 'failed' });
  const folder = '$ ls\n\n(pwsh, cwd: D:\\a, exit code: 0, 9 s)x, exit code: 2, 0.4 s)';
  assert.deepEqual(toolRow('shell_run', JSON.stringify({ command: 'ls' }), { text: folder, isError: true }).meta, { kind: 'exit', code: '2', seconds: '0.4' }, '見出しの終わりの値を読む');
  const secret = 'curl -H "Authorization: Bearer abcdefgh"';
  assert.deepEqual(toolRow('shell_run', JSON.stringify({ command: secret }), { text: '$ curl -H "Authorization: [REDACTED]\n\n(pwsh, cwd: w, exit code: 0, 0.2 s)', isError: false }).meta, { kind: 'exit', code: '0', seconds: '0.2' }, 'サーバーが伏せた写しでも読める');
});

test('ui/tool-row: 対象に出す URL の利用者情報と、鍵らしい名前の値は伏せる（画面の表示だけ。サーバーは道具の引数を伏せずに保存している）', () => {
  const fetched = toolRow('web_fetch', JSON.stringify({ url: 'https://user:pw@example.com/?token=abc&x=1' }), null).target;
  assert.ok(!/pw@|abc/u.test(fetched), fetched);
  assert.ok(fetched.includes('example.com'), fetched);
  assert.equal(maskTarget('https://example.com/a?access_token=zzz&api_key=yyy&q=1'), 'https://example.com/a?access_token=[REDACTED]&api_key=[REDACTED]&q=1');
  assert.equal(maskTarget('git clone ssh://git@host/x'), 'git clone ssh://[REDACTED]@host/x');
  assert.ok(!toolRow('shell_run', JSON.stringify({ command: 'curl https://u:secretpw@h/x' }), null).target.includes('secretpw'));
  assert.equal(maskTarget('npm test -- upload'), 'npm test -- upload');
});

test('ui/tool-row: 前の伏せ方で保存した結果（写しのコマンドが今の伏せ方と違う）でも、コマンドと同じ行数の写しの次から終了コードと秒を読む', () => {
  const command = 'curl "https://x.test/?code=JP"';
  const text = '$ curl "https://x.test/?code=[REDACTED]"\n\n(pwsh, cwd: w, exit code: 0, 0.2 s)\n\nok';
  assert.deepEqual(toolRow('shell_run', JSON.stringify({ command }), { text, isError: false }).meta, { kind: 'exit', code: '0', seconds: '0.2' });
  const multi = '$ npm test\n  -- token=[REDACTED]\n\n(pwsh, cwd: w, exit code: 1, 3 s)';
  assert.deepEqual(toolRow('shell_run', JSON.stringify({ command: 'npm test\n  -- token=abc' }), { text: multi, isError: true }).meta, { kind: 'exit', code: '1', seconds: '3' });
  const forged = '$ echo old\n\nhello\n(pwsh, cwd: w, exit code: 0, 0.1 s)';
  assert.deepEqual(toolRow('shell_run', JSON.stringify({ command: 'echo new' }), { text: forged, isError: true }).meta, { kind: 'failed' }, '写しの次の行でなければ読まない');
  assert.deepEqual(toolRow('shell_run', JSON.stringify({ command: 'ls' }), { text: 'Denied by the owner', isError: true }).meta, { kind: 'failed' });
});

test('ui/tool-row: 秘密鍵の BEGIN の印を含むコマンドは、伏せ字が本物の見出しを食うので、写しの突き合わせが外れたら見出しを読まない', () => {
  const command = 'grep -A3 -- "-----BEGIN RSA PRIVATE KEY-----" deploy/id_rsa';
  const text = redactSecrets(`$ ${command}\n\n(bash, cwd: /w, exit code: 1, 0.1 s)\n\n-----BEGIN RSA PRIVATE KEY----- -----END RSA PRIVATE KEY-----\n\n(bash, cwd: /w, exit code: 0, 0.1 s)`);
  assert.deepEqual(toolRow('shell_run', JSON.stringify({ command }), { text, isError: true }).meta, { kind: 'failed' });
  assert.equal(toolRow('shell_run', JSON.stringify({ command }), { text, isError: false }).meta, null);
});

test('ui/tool-row: 突き合わせが外れたときの見出しは、終了コードと isError が食い違えば読まない', () => {
  const command = 'curl "https://x.test/?code=JP"';
  const zeroButError = '$ curl "https://x.test/?code=[REDACTED]"\n\n(pwsh, cwd: w, exit code: 0, 0.2 s)';
  assert.deepEqual(toolRow('shell_run', JSON.stringify({ command }), { text: zeroButError, isError: true }).meta, { kind: 'failed' });
  const failedButOk = '$ curl "https://x.test/?code=[REDACTED]"\n\n(pwsh, cwd: w, exit code: 2, 0.2 s)';
  assert.deepEqual(toolRow('shell_run', JSON.stringify({ command }), { text: failedButOk, isError: false }).meta, null);
});

test('ui/tool-row: タスクの道具の結果の末尾にコードが足す [E-n] の行があっても、file_write の行数（上書き・追記）を読む。[E-n] だけの結果は出力なし（5-3b-t）', async () => {
  const { emptyOutput } = await import('../web/src/ui/tool-row.ts');
  const input = JSON.stringify({ path: 'a.md', content: 'x' });
  assert.deepEqual(toolRow('file_write', input, { text: 'Overwritten: a.md (3 characters; +1 -3 lines)\n[E-4]', isError: false }).meta, { kind: 'lines', added: 1, removed: 3 });
  assert.deepEqual(toolRow('file_write', input, { text: 'Appended: a.md (2 characters; +2 -0 lines)\n[E-12]\n', isError: false }).meta, { kind: 'lines', added: 2, removed: 0 });
  assert.equal(toolRow('file_write', input, { text: 'Overwritten: a.md (3 characters; +1 -3 lines) [E-4] extra', isError: false }).meta, null);
  assert.equal(emptyOutput('\n[E-1]'), true);
  assert.equal(emptyOutput(''), true);
  assert.equal(emptyOutput('done\n[E-1]'), false);
  assert.equal(emptyOutput('[E-x]'), false);
});
