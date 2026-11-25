import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractToolCalls, looksLikeTextToolCall, streamEnd, textToolCallStart } from '../src/engine/toolcall-parse.ts';

const names = new Set(['file_write', 'shell_run']);

test('予備パーサー: Qwen / Hermes の <tool_call>', () => {
  const r = extractToolCalls('書きます。\n<tool_call>\n{"name": "file_write", "arguments": {"path": "a.md", "content": "x"}}\n</tool_call>', names);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0]!.arguments, { path: 'a.md', content: 'x' });
  assert.equal(r.text, '書きます。');
});

test('予備パーサー: Mistral の [TOOL_CALLS]、コードブロック、本文全体の JSON、arguments が文字列の場合', () => {
  assert.equal(extractToolCalls('[TOOL_CALLS] [{"name": "shell_run", "arguments": {"command": "ls"}}]', names).calls[0]!.name, 'shell_run');
  assert.equal(extractToolCalls('```json\n{"name": "shell_run", "parameters": {"command": "ls"}}\n```', names).calls.length, 1);
  assert.equal(extractToolCalls('{"name": "shell_run", "arguments": "{\\"command\\": \\"ls\\"}"}', names).calls[0]!.arguments instanceof Object, true);
  const broken = extractToolCalls('<tool_call>{"name": "shell_run", "arguments": "{bad"}</tool_call>', names);
  assert.equal(broken.calls[0]!.arguments, undefined, '壊れた引数は undefined にして、パイプラインで直させる');
});

test('予備パーサー: 知らないツール名や普通の JSON は拾わない', () => {
  assert.equal(extractToolCalls('<tool_call>{"name": "rm_rf", "arguments": {}}</tool_call>', names).calls.length, 0);
  assert.equal(extractToolCalls('設定はこうです: {"name": "beat", "age": 1}', names).calls.length, 0);
  assert.equal(looksLikeTextToolCall('普通の返事'), false);
  assert.equal(looksLikeTextToolCall('<tool_call>{}</tool_call>'), true);
});

test('textToolCallStart: 本文のツール呼び出しの始まり（引数より前）の位置。印の無い本文は -1。1 文字ずつ足しても、引数が出る前に見つかる', () => {
  assert.equal(textToolCallStart('普通の返事'), -1);
  assert.equal(textToolCallStart('設定はこうです: {"name": "beat", "age": 1}'), -1);
  assert.equal(textToolCallStart('書きます。<tool_call>{"name": "file_write"}'), 5);
  assert.equal(textToolCallStart('[TOOL_CALLS] [{"name": "shell_run", "arguments": {}}]'), 0);
  assert.equal(textToolCallStart('先に {"name": "shell_run", "arguments": {"command": "ls"}}'), 3, '印のない形（本文全体の JSON・コードブロック）は、名前の前の { から');
  assert.equal(textToolCallStart('```json\n{"name": "shell_run", "parameters": {"command": "ls"}}\n```'), 8);
  for (const text of ['<tool_call>{"name":"file_write","arguments":{"content":"SECRET"}}', '[TOOL_CALLS][{"name":"file_write","arguments":{"content":"SECRET"}}]', '{"name":"file_write","arguments":{"content":"SECRET"}}']) {
    for (let length = 1; length <= text.length; length += 1) {
      const start = textToolCallStart(text.slice(0, length));
      if (start !== -1) assert.ok(start <= text.indexOf('SECRET'), `${text.slice(0, length)}`);
      if (length <= text.indexOf('SECRET')) continue;
      assert.ok(start !== -1, `引数が 1 文字でも出るときには、始まりが見えている: ${text.slice(0, length)}`);
    }
  }
});

// 引数を先に書く・args という欄・名前と arguments のあいだに別の欄・\u で書いた欄の名前・1 つの囲みの配列、のあとに普通の呼び出しが続く返事。
// 引数の文字を 1 文字でも画面へ流した呼び出しは、実行してはならない（引数は、流すのをやめた位置より後ろにだけある）
const SECRET = 'Zz9-check-PASS';
const TWO = new Set(['browser_type', 'browser_read']);
const READ = '{"name":"browser_read","arguments":{}}';
const BS = String.fromCharCode(92);
const escaped = (word: string): string => [...word].map(char => `${BS}u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
const fenced = (body: string): string => `まず\n\`\`\`json\n${body}\n\`\`\`\n次に\n\`\`\`json\n${READ}\n\`\`\``;
const SHAPES: Record<string, string> = {
  'arguments before name': fenced(`{"arguments":{"ref":"e2","password":"${SECRET}"},"name":"browser_type"}`),
  'parameters before name': fenced(`{"parameters":{"ref":"e2","password":"${SECRET}"},"name":"browser_type"}`),
  'args key': fenced(`{"name":"browser_type","args":{"ref":"e2","password":"${SECRET}"}}`),
  'extra key between name and arguments': fenced(`{"name":"browser_type","id":"c1","arguments":{"ref":"e2","password":"${SECRET}"}}`),
  'parameters after name, with a key before (control)': fenced(`{"id":"c1","name":"browser_type","parameters":{"ref":"e2","password":"${SECRET}"}}`),
  'key written with a unicode escape': fenced(`{"name":"browser_type","argu\\u006dents":{"ref":"e2","password":"${SECRET}"}}`),
  'every letter of parameters written with a unicode escape': fenced(`{"name":"browser_type","${escaped('parameters')}":{"ref":"e2","password":"${SECRET}"}}`),
  'one fence holding an array': `\`\`\`json\n[{"arguments":{"ref":"e2","password":"${SECRET}"},"name":"browser_type"},${READ}]\n\`\`\``,
  'function wrapper, arguments first': fenced(`{"function":{"arguments":{"ref":"e2","password":"${SECRET}"},"name":"browser_type"}}`),
  'tag form (control)': `<tool_call>{"arguments":{"ref":"e2","password":"${SECRET}"},"name":"browser_type"}</tool_call>`,
  'bracket form (control)': `[TOOL_CALLS] [{"arguments":{"ref":"e2","password":"${SECRET}"},"name":"browser_type"}]`,
  'name then arguments (control)': fenced(`{"name":"browser_type","arguments":{"ref":"e2","password":"${SECRET}"}}`),
};

// 返事を chunks に分けて 1 つずつ足し、streamEnd が許した分だけ流したときに、流れた文字
function streamed(reply: string, chunks: readonly string[]): string {
  let text = '';
  let shown = 0;
  for (const chunk of chunks) { text += chunk; shown = streamEnd(text, shown); }
  return text.slice(0, shown);
}
const splitEvery = (reply: string, size: number): string[] => reply.match(new RegExp(`[\\s\\S]{1,${size}}`, 'gu')) ?? [];

for (const [name, reply] of Object.entries(SHAPES)) {
  test(`引数は流さない（${name}）: どう区切って流しても、引数の文字は 1 文字も流れない。呼び出しは今までどおり拾う`, () => {
    const probes: string[] = [];
    for (let size = 1; size <= 12; size += 1) probes.push(streamed(reply, splitEvery(reply, size)));
    for (let cut = 1; cut < reply.length; cut += 1) probes.push(streamed(reply, [reply.slice(0, cut), reply.slice(cut)]));
    probes.push(streamed(reply, [reply]));
    for (const shown of probes) assert.ok(!shown.includes(SECRET.slice(0, 4)) && !shown.includes('password'), shown);
    const typed = extractToolCalls(reply, TWO).calls.find(call => call.name === 'browser_type');
    assert.ok(typed, '呼び出しは拾われる（流していないので、実行してよい）');
    assert.equal((typed.arguments as { password?: string }).password, SECRET);
  });
}

test('引数の欄の名前が無い返事（ふつうの文・コードの囲み・名前だけの JSON）は、今までどおり最後まで流す', () => {
  for (const reply of ['普通の返事です。\n```ts\nconst a = 1;\n```\nおわり', '例: {"name": "beat", "age": 1}', '```json\n{"title":"x","items":[1,2,3]}\n```\n', 'a "name" b : c', `例: {"Caf${BS}u00e9": 1}`, `{"${'a'.repeat(70)}${BS}u0041": 1}`, `{"x": "${escaped('arguments')}"}`]) {
    for (const size of [1, 5, reply.length]) assert.equal(streamed(reply, splitEvery(reply, size)), reply);
  }
});
