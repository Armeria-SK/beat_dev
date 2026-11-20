import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { mcpToolName } from '../src/mcp/names.ts';
import { previewJson } from '../src/shared/json-preview.ts';
import { redactJsonValue, redactSecrets } from '../src/shared/redaction.ts';
import { en } from '../web/src/i18n/en.ts';
import { toolText } from '../src/shared/messages/tools.ts';
import { maskTarget, shownOutput, toolLabel, toolRow, toolVerb } from '../web/src/ui/tool-row.ts';

// 新しい画面の ToolRow（p1-ui.md の「会話」）: 道具の名前と引数から、動詞・対象・meta を作る。
// ファイルを書く・直す → Edit + パス + 足し引きの行、シェル → Run + コマンド + 終了コードと秒、検索・読む・Web → Search + 語、
// agent_run → Helper、ほかは人の言葉の短い名前（en.ts）。生の JSON は出さない。

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
        assert.ok(!/[{}[\]]/u.test(row.target.replaceAll('some {"a":1} value second line', '')), `${tool.name} ${input} → ${row.target}`);
        assert.ok(!row.target.includes('\n'), tool.name);
        assert.ok(row.target.length <= 241, tool.name);
        assert.equal(row.name, tool.name);
        if (row.meta) assert.ok(['lines', 'exit', 'failed', 'returned', 'background'].includes(row.meta.kind), tool.name);
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
  assert.equal(toolVerb('mesh_read'), 'search');
  assert.equal(toolVerb('mesh_search'), 'search');
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
  assert.equal(toolRow('file_search', JSON.stringify({ text: 'uploadFile', path: 'src' }), null).target, '"uploadFile" in src');
  assert.equal(toolRow('agent_run', JSON.stringify({ task: 'Find flaky tests\nand more' }), null).target, 'Find flaky tests and more');
  assert.deepEqual(toolRow('agent_run', JSON.stringify({ task: 't', title: 'Flaky' }), { text: 'answer', isError: false }), { verb: 'helper', name: 'agent_run', icon: 'branch', target: 'Flaky', meta: { kind: 'returned' } });
  assert.equal(toolRow('memory_save', JSON.stringify({ book: 'notes', content: 'Likes tea' }), null).target, 'Likes tea');
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

const VERB_WORDS = { edit: 'Edit', run: 'Run', search: 'Search', helper: 'Helper' } as const;
const shownVerb = (name: string, verb: string): string => (verb === 'tool' ? toolLabel(name) : VERB_WORDS[verb as keyof typeof VERB_WORDS]);

const REAL: Record<string, [unknown, string, string]> = {
  task_complete: [{ summary: 'Added retry with backoff', items: [{ id: 'A-1' }] }, 'Finish task', 'Added retry with backoff'],
  task_checkpoint: [{ tried: 'ran tests', result: '2 failed', next_action: 'Fix the upload test' }, 'Save progress', 'Fix the upload test'],
  question_add: [{ question: 'Apply it to existing data too?', why: 'Not said', options: ['No', 'Yes'] }, 'Ask question', 'Apply it to existing data too?'],
  tool_search: [{ query: 'browser' }, 'Load tool', 'browser'],
  memory_save: [{ book: 'user', content: 'Likes tea' }, 'Save memory', 'Likes tea'],
  history_search: [{ query: 'upload bug' }, 'Search', 'upload bug'],
  web_search: [{ query: 'resumable upload' }, 'Search', 'resumable upload'],
  web_fetch: [{ url: 'https://example.com/docs' }, 'Search', 'https://example.com/docs'],
  file_read: [{ path: 'src/upload/queue.ts' }, 'Search', 'src/upload/queue.ts'],
  file_list: [{}, 'Search', 'working folder'],
  file_write: [{ path: 'notes.md', content: 'x' }, 'Edit', 'notes.md'],
  file_edit: [{ path: 'src/q.ts', old: 'a', new: 'b' }, 'Edit', 'src/q.ts'],
  shell_run: [{ command: 'npm test' }, 'Run', 'npm test'],
  plan_write: [{ content: '# Plan\n1. Upload' }, 'Write plan', 'plan.md'],
  acceptance_write: [{ items: [{ result: 'a', source: 'ai_added', check: 'look' }, { result: 'b', source: 'ai_added', check: 'look' }] }, 'Draft acceptance', '2 items'],
  acceptance_change: [{ changes: [{ op: 'add', result: 'c' }] }, 'Propose', '1 acceptance change'],
  mesh_search: [{ query: 'upload', file: 'plan.md' }, 'Search', '"upload" in plan.md'],
  mesh_read: [{ file: 'plan.md', section: 'Steps' }, 'Search', 'plan.md › Steps'],
  mesh_state_set: [{ now: 'Writing tests', next: 'Run them' }, 'Note status', 'Writing tests'],
  task_create: [{ title: 'Weekly report' }, 'Create task', 'Weekly report'],
  task_list: [{}, 'List tasks', 'open tasks'],
  task_update: [{ id: 'a1b2c3', status: 'done' }, 'Update task', '#a1b2c3'],
  memory_update: [{ id: 'u7', content: 'Likes green tea' }, 'Update memory', 'Likes green tea'],
  memory_forget: [{ id: 'u7', reason: 'outdated' }, 'Forget memory', '#u7'],
  memory_search: [{ query: 'tea' }, 'Search', 'tea'],
  history_read: [{ conversation_id: 'c42' }, 'Search', '#c42'],
  skill_view: [{ name: 'weekly-report' }, 'Search', 'weekly-report'],
  skill_draft: [{ name: 'weekly-report', description: 'd', body: 'b', reason: 'r' }, 'Draft skill', 'weekly-report'],
  curiosity_add: [{ topic: 'WebGPU', why: 'w' }, 'Add curiosity', 'WebGPU'],
  curiosity_list: [{}, 'List curiosities', 'open items'],
  curiosity_update: [{ id: 3, status: 'done' }, 'Update curiosity', '#3'],
  file_search: [{ text: 'uploadFile', path: 'src' }, 'Search', '"uploadFile" in src'],
  calculate: [{ expression: '12*(3+4)' }, 'Calculate', '12*(3+4)'],
  date_calc: [{ op: 'diff', date: '2026-11-15', to: '2026-12-25' }, 'Work out date', '2026-11-15 → 2026-12-25'],
  checklist_write: [{ items: [{ text: 'Find code', status: 'done' }, { text: 'Make the change', status: 'in_progress' }, { text: 'Run tests', status: 'pending' }] }, 'Update checklist', 'Make the change'],
  notify_owner: [{ title: 'Build finished' }, 'Notify owner', 'Build finished'],
  ask_owner: [{ questions: [{ question: 'Which storage?', header: 'Storage', options: [{ label: 'SQLite' }, { label: 'JSON' }] }, { question: 'Which screens?', header: 'Screens', multiSelect: true, options: [{ label: 'List' }, { label: 'Detail' }] }] }, 'Ask you', 'Storage, Screens'],
  doc_read: [{ path: 'report.pdf' }, 'Search', 'report.pdf'],
  table_write: [{ path: 'out.csv', rows: [['a']] }, 'Edit', 'out.csv'],
  image_view: [{ path: 'shot.png' }, 'Search', 'shot.png'],
  web_download: [{ url: 'https://example.com/a.zip' }, 'Download', 'https://example.com/a.zip'],
  agent_run: [{ task: 'Find flaky tests', title: 'Flaky' }, 'Helper', 'Flaky'],
  question_list: [{}, 'List questions', 'this product'],
  shell_output: [{ id: 'bg-3', waitSec: 5 }, 'Read background output', 'bg-3'],
  shell_stop: [{ id: 'bg-3' }, 'Stop background command', 'bg-3'],
  deviation_add: [{ what: 'Skipped the CLI flag', why: 'w' }, 'Note deviation', 'Skipped the CLI flag'],
  mesh_decision_add: [{ decision: 'Use SQLite' }, 'Note decision', 'Use SQLite'],
  ledger_record: [{ title: 'Upload checks', checked: 'read upload.ts', result: 'no problem' }, 'Note checked area', 'Upload checks'],
  research_record: [{ research_id: 'r1', kind: 'similar', name: 'Alpha Notes', url: 'https://alpha.example' }, 'Note research row', 'Alpha Notes'],
  proposal_add: [{ title: 'Add retry to upload', kind: 'bug', why: 'w', size: 'S' }, 'Propose', 'Add retry to upload'],
  browser_open: [{ url: 'https://example.com' }, 'Open page', 'https://example.com'],
  browser_read: [{}, 'Search', 'current page'],
  browser_screenshot: [{ tab: 't2' }, 'Screenshot', 'tab t2'],
  browser_close: [{}, 'Close tab', 'all tabs'],
  browser_click: [{ ref: 'e12' }, 'Click', 'element e12'],
  browser_type: [{ ref: 'e7', text: 'hello' }, 'Type text', 'element e7'],
};

test('ui/tool-row: 組み込みの道具のどれも、ふつうの引数なら行に人の言葉の名前と空でない対象が出る（snake_case の名前を出さない）', () => {
  for (const tool of builtinTools()) {
    const sample = REAL[tool.name];
    assert.ok(sample, `${tool.name} の見本が無い`);
    const row = toolRow(tool.name, JSON.stringify(sample[0]), null);
    const label = shownVerb(tool.name, row.verb);
    assert.ok(row.target !== '', `${tool.name} の対象が空`);
    assert.ok(!/_/u.test(label) && label !== tool.name, `${tool.name} → ${label}`);
    assert.deepEqual([label, row.target], [sample[1], sample[2]], tool.name);
  }
});

test('ui/tool-row: 対象の言い方（節・範囲・数・作業中の項目・番号・タブ・要素・日付）', () => {
  const target = (name: string, args: unknown) => toolRow(name, JSON.stringify(args), null).target;
  assert.equal(target('mesh_read', { file: 'notes/ideas.md' }), 'notes/ideas.md');
  assert.equal(target('mesh_search', { query: 'upload' }), 'upload');
  assert.equal(target('mesh_search', { query: 'say "hi"', file: 'plan.md' }), '“say "hi"” in plan.md');
  assert.equal(target('file_list', { path: 'src' }), 'src');
  assert.equal(target('file_search', { name: '*.ts' }), '*.ts');
  assert.equal(target('file_search', { name: '*.ts', path: 'web' }), '"*.ts" in web');
  assert.equal(target('file_search', {}), 'working folder');
  assert.equal(target('acceptance_write', { items: [{ result: 'a' }] }), '1 item');
  assert.equal(target('acceptance_change', { changes: [{ op: 'a' }, { op: 'b' }] }), '2 acceptance changes');
  assert.equal(target('checklist_write', { items: [{ text: 'a', status: 'done' }, { text: 'b', status: 'pending' }] }), '2 steps');
  assert.equal(target('checklist_write', { items: [{ text: 'a', status: 'done' }] }), '1 step');
  assert.equal(target('task_list', { include_finished: true }), 'all tasks');
  assert.equal(target('curiosity_list', { include_closed: true }), 'all items');
  assert.equal(target('browser_read', { tab: 't3' }), 'tab t3');
  assert.equal(target('browser_close', { tab: 't3' }), 'tab t3');
  assert.equal(target('browser_screenshot', {}), 'current page');
  assert.equal(target('mesh_state_set', { goal: 'Ship upload', now: 'Writing tests' }), 'Writing tests');
  assert.equal(target('mesh_state_set', { goal: 'Ship upload' }), 'Ship upload');
  assert.equal(target('date_calc', { op: 'add', date: '2026-11-15', days: 3, months: -1 }), '2026-11-15 +3 days −1 month');
  assert.equal(target('date_calc', { op: 'convert', datetime: '2026-11-15 09:00', timezone: 'Asia/Tokyo', to_timezone: 'Europe/London' }), '2026-11-15 09:00 Asia/Tokyo → Europe/London');
  assert.equal(target('date_calc', { op: 'now' }), 'now');
});

test('ui/tool-row: 自分の言い方を持つ道具は、それが空でも、ほかの引数を代わりに出さない（決まった言葉を出す）', () => {
  const target = (name: string, args: unknown) => toolRow(name, JSON.stringify(args), null).target;
  assert.equal(target('browser_type', { ref: '', text: 'my secret words' }), 'no details');
  assert.equal(target('shell_run', { command: '', cwd: 'D:/private/folder' }), 'no details');
  assert.equal(target('calculate', { expression: 1 }), 'no details');
});

test('ui/tool-row: MCP の道具（mcp_<サーバー>_<道具>）は「サーバー · 道具」の読める名前、それ以外の知らない道具は _ を空白に', () => {
  assert.equal(toolLabel(mcpToolName('github', 'create_issue')), 'github · create issue');
  assert.equal(toolLabel(mcpToolName('fs2', 'Read-File')), 'fs2 · read file');
  assert.equal(toolLabel('some_tool'), 'some tool');
  assert.equal(toolLabel('mcp_Bad_x'), 'mcp Bad x');
});

test('ui/tool-row: 知らない道具は、説明に使う引数の名前（決まった一覧）の値だけを 1 行で出し、無ければ決まった言葉', () => {
  const target = (args: unknown) => toolRow(mcpToolName('x', 'call'), JSON.stringify(args), null).target;
  assert.equal(target({ count: 2, repo: '', body: 'Line one\n  line two' }), 'Line one line two');
  assert.equal(target({ n: 1 }), 'no details');
  assert.equal(target({ description: 'List files', cmd: 'rm -rf ~' }), 'rm -rf ~', '説明より、実際に動くコマンドを出す');
  for (const secret of [{ pass: 'hunter2', user: 'sam' }, { otp: '839201' }, { key: 'AKIAABCDEFGHIJKLMNOP' }, { pwd: 'x9y8z7', pin: '1234', code: '5678', passcode: '0000' }]) {
    const shown = target(secret);
    assert.equal(shown, 'no details', JSON.stringify(secret));
  }
});

test('ui/tool-row: 知らない道具の対象でも、鍵らしい値は伏せる', () => {
  const masked = toolRow(mcpToolName('x', 'call'), JSON.stringify({ description: 'Authorization: Bearer abcdefghijklmnop1234' }), null).target;
  assert.ok(!masked.includes('abcdefghijklmnop1234'), masked);
  assert.ok(masked.includes('[REDACTED]'), masked);
  assert.ok(!toolRow(mcpToolName('x', 'fetch'), JSON.stringify({ url: 'https://u:pw123@h.test/?token=abc' }), null).target.includes('pw123'));
});

test('ui/tool-row: 対象から制御文字と向きを変える文字を消す', () => {
  assert.equal(toolRow('file_read', JSON.stringify({ path: 'a\u202Efdp.exe' }), null).target, 'afdp.exe');
  assert.equal(toolRow('file_read', JSON.stringify({ path: 'a\u2066b\u2069c\u0007d\u0000e' }), null).target, 'abc d e');
});

test('ui/tool-row: ui.toolLabel の項目は、動詞の 4 種類に入らない組み込みの道具とちょうど同じ', () => {
  const keys = Object.keys(en).filter(key => key.startsWith('ui.toolLabel.')).map(key => key.slice('ui.toolLabel.'.length)).sort();
  const tools = builtinTools().map(tool => tool.name).filter(name => toolVerb(name) === 'tool').sort();
  assert.deepEqual(keys, tools);
});

const LONG = 'word '.repeat(1000);
const LONG_CASES: Array<[string, Record<string, unknown>, RegExp]> = [
  ['file_write', { path: 'docs/notes.md', content: LONG }, /^docs\/notes\.md$/u],
  ['file_edit', { path: 'src/q.ts', old: LONG, new: LONG }, /^src\/q\.ts$/u],
  ['table_write', { path: 'out.csv', rows: Array.from({ length: 400 }, (_, i) => [`row ${i}`, 'value']) }, /^out\.csv$/u],
  ['plan_write', { content: LONG }, /^plan\.md$/u],
  ['checklist_write', { items: Array.from({ length: 30 }, (_, i) => ({ text: `Step ${i} ${'y'.repeat(150)}`, status: 'pending' })) }, /^\d+\+ steps$/u],
  ['checklist_write', { items: [{ text: 'First thing', status: 'in_progress' }, ...Array.from({ length: 30 }, () => ({ text: 'z'.repeat(190), status: 'pending' }))] }, /^First thing$/u],
  ['acceptance_write', { items: Array.from({ length: 40 }, (_, i) => ({ result: `Result ${i} ${'r'.repeat(120)}`, source: 'ai_added', check: 'look' })) }, /^\d+\+ items$/u],
  ['acceptance_change', { changes: Array.from({ length: 40 }, (_, i) => ({ op: 'add', result: `R ${i} ${'r'.repeat(120)}` })) }, /^\d+\+ acceptance changes$/u],
  ['task_complete', { summary: `Done. ${LONG}` }, /^Done\. [a-z ]+…$/u],
  ['shell_run', { command: `echo ${LONG}` }, /^echo [a-z ]+…$/u],
];

test('ui/tool-row: サーバーが途中で切った引数（2,000 字・4,000 字）でも、対象を空にせず、切れた値は「…」で終える', () => {
  for (const limit of [2000, 4000]) {
    for (const [name, args, expected] of LONG_CASES) {
      const input = JSON.stringify(redactJsonValue(args)).slice(0, limit);
      assert.throws(() => JSON.parse(input), SyntaxError, `${name} は切れている`);
      const target = toolRow(name, input, null).target;
      assert.match(target, expected, `${name} ${limit}: ${target}`);
    }
  }
});

test('ui/tool-row: サーバーが縮めた引数（previewJson）の「… N more」の印は数に足し、項目として数えない', () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ result: `Result ${i} ${'r'.repeat(120)}`, source: 'ai_added', check: 'look' }));
  for (const limit of [2000, 4000]) {
    const input = previewJson(redactJsonValue({ items: items(200) }), limit);
    assert.match(JSON.parse(input).items.at(-1), /^… \d+ more$/u, '縮めた印が付いている');
    assert.equal(toolRow('acceptance_write', input, null).target, '200 items');
    const steps = previewJson(redactJsonValue({ items: Array.from({ length: 300 }, (_, i) => ({ text: `Step ${i} ${'y'.repeat(150)}`, status: 'pending' })) }), limit);
    assert.equal(toolRow('checklist_write', steps, null).target, '300 steps');
    const changes = previewJson(redactJsonValue({ changes: Array.from({ length: 250 }, (_, i) => ({ op: 'add', result: `R ${i} ${'r'.repeat(120)}` })) }), limit);
    assert.equal(toolRow('acceptance_change', changes, null).target, '250 acceptance changes');
  }
});

test('ui/tool-row: 切れた引数の値でも鍵らしい値は伏せ、文字の逃がし（\\ と \\u）の途中で切れても壊れない', () => {
  const secret = JSON.stringify({ summary: `Token: Bearer abcdefghijklmnop1234 ${'x'.repeat(3000)}` }).slice(0, 2000);
  const shown = toolRow('task_complete', secret, null).target;
  assert.ok(!shown.includes('abcdefghijklmnop1234') && shown !== '', shown);
  assert.equal(toolRow('task_complete', '{"summary":"ab\\', null).target, 'ab…');
  assert.equal(toolRow('task_complete', '{"summary":"ab\\u00', null).target, 'ab…');
  assert.equal(toolRow('task_complete', '{"summary":"ab\\\\', null).target, 'ab\\…');
  assert.equal(toolRow('file_write', '{"path":"a.md","conte', null).target, 'a.md');
  assert.equal(toolRow('file_write', 'not json', null).target, '');
  assert.equal(toolRow('plan_write', 'not json', null).target, 'plan.md');
  assert.equal(toolRow('question_list', '', null).target, 'this product');
});

test('ui/tool-row: 断られた道具の行では、AI に向けた一文（Think of another way, or ask the user）を出さず、断った理由は残す', () => {
  const denied = toolText('en', 'pipeline.denied', { reasons: 'This is outside the allowed folders: D:/x' });
  const failed = (text: string) => ({ text, isError: true });
  assert.equal(shownOutput(failed(denied)), 'Not run (denied):\n- This is outside the allowed folders: D:/x');
  assert.equal(shownOutput(failed(`${denied}\n[E-12]`)), 'Not run (denied):\n- This is outside the allowed folders: D:/x\n[E-12]', '証拠の番号の行は残す');
  assert.equal(shownOutput(failed(toolText('en', 'pipeline.policy_blocked', { name: 'shell_run' }))), 'The tool "shell_run" is turned off in the settings, so it cannot be used.');
  const output = 'Think of another way, or ask the user was printed by the command\nok';
  assert.equal(shownOutput(failed(output)), output, '終わりでなければ消さない');
  const printed = 'echo done\nThink of another way, or ask the user';
  assert.equal(shownOutput({ text: printed, isError: false }), printed, 'うまくいった出力には手を付けない');
  const big = failed(`${' '.repeat(16_000)}\n`.repeat(4));
  const started = performance.now();
  for (let i = 0; i < 50; i++) shownOutput(big);
  assert.ok(performance.now() - started < 100, '長い出力でも描くたびに遅くならない');
});
