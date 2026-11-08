import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { ElementState, PageHandle } from '../src/tools/browser/driver.ts';
import { formatElements, readElements, relocate } from '../src/tools/browser/elements.ts';

// T-05: 触れるものの番号。手本は、固定版の playwright-core（本物の Edge）が出した ariaSnapshot

const fixture = (name: string) => readFileSync(new URL(`./fixtures/aria-snapshot-${name}.txt`, import.meta.url), 'utf8');
const URL_FORM = 'https://example.com/page';

test('手本（フォーム）: 番号を振る役割だけに、出てきた順に振る', () => {
  const table = readElements(fixture('form'), URL_FORM);
  assert.deepEqual(table.items.map(e => [e.ref, e.role, e.name]), [
    ['e1', 'link', 'ログイン'], ['e2', 'link', 'Home'], ['e3', 'link', 'Home'], ['e4', 'button', '無効'],
    ['e5', 'textbox', '検索'], ['e6', 'textbox', 'パスワード'], ['e7', 'checkbox', '覚える'], ['e8', 'combobox', '言語'],
    ['e9', 'option', '日本語'], ['e10', 'option', 'English'], ['e11', 'button', '送信'], ['e12', 'tab', 'T1'],
  ]);
  assert.equal(table.omitted, 0);
  // 見出し・段落・リスト・text には振らない
  assert.ok(!table.items.some(e => ['heading', 'paragraph', 'navigation', 'list', 'listitem', 'text', 'tablist'].includes(e.role)));
});

test('同じ役割・同じ名前は、nth と count で区別する', () => {
  const table = readElements(fixture('form'), URL_FORM);
  const homes = table.items.filter(e => e.name === 'Home');
  assert.deepEqual(homes.map(e => [e.nth, e.count]), [[0, 2], [1, 2]]);
  assert.deepEqual(table.items.find(e => e.name === 'ログイン') && [table.items[0]!.nth, table.items[0]!.count], [0, 1]);
});

test('状態（disabled / checked / selected）を持つ', () => {
  const table = readElements(fixture('form'), URL_FORM);
  const by = (name: string) => table.items.find(e => e.name === name)!;
  assert.deepEqual(by('無効').states, ['disabled']);
  assert.deepEqual(by('覚える').states, ['checked']);
  assert.deepEqual(by('日本語').states, ['selected']);
  assert.deepEqual(by('送信').states, []);
});

test('リンクの href は、相対なら元の URL で絶対にし、pageUrl を通るものだけ出す', () => {
  const table = readElements(fixture('article'), 'https://news.example.org/a/b');
  const link = (name: string) => table.items.find(e => e.name === name)!;
  assert.equal(link('危険なリンク').href, undefined);
  assert.equal(link('内向きのリンク').href, undefined);
  assert.equal(link('普通のリンク').href, 'https://example.org/ok?a=1');
  assert.equal(link('次へ >>> 進む').href, 'https://news.example.org/next');
  assert.equal(link('連絡').href, undefined, 'mailto: は出さない');
  assert.equal(link('Example News').href, 'https://news.example.org/');
});

test('手本（記事）: すべての役割（searchbox / menuitem 系 / slider / spinbutton / switch / radio / listbox / option）に振る', () => {
  const table = readElements(fixture('article'), 'https://news.example.org/a/b');
  const roles = new Set(table.items.map(e => e.role));
  for (const role of ['link', 'button', 'searchbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'slider', 'spinbutton', 'switch', 'radio', 'listbox', 'option']) assert.ok(roles.has(role), role);
  assert.ok(!roles.has('img') && !roles.has('heading') && !roles.has('cell') && !roles.has('row'));
});

test('名前の引用符（\\"）を元に戻す', () => {
  const table = readElements('- button "say \\"hi\\" \\\\ ok"\n', URL_FORM);
  assert.equal(table.items[0]!.name, 'say "hi" \\ ok');
});

test('名前の無いものには番号を振らない（探し直せない）', () => {
  const table = readElements('- button\n- link:\n  - /url: /x\n- button "OK"\n', URL_FORM);
  assert.deepEqual(table.items.map(e => [e.ref, e.name]), [['e1', 'OK']]);
});

test('300 個までに切り、超えた数を omitted に数える。nth と count は切った分も数える', () => {
  const lines = Array.from({ length: 350 }, (_, i) => `- button "b${i % 2}"`).join('\n');
  const table = readElements(lines, URL_FORM);
  assert.equal(table.items.length, 300);
  assert.equal(table.omitted, 50);
  assert.equal(table.items[299]!.ref, 'e300');
  assert.equal(table.items[0]!.count, 175);
  assert.equal(table.items[298]!.nth, 149);
  const text = formatElements(table, 'ja');
  assert.match(text, /ほか 50 個/u);
  assert.match(formatElements(table, 'en'), /50 more/u);
});

test('iframe の中は、番号を振らない（どのホストの枠か分からないので止める）', () => {
  const snapshot = ['- button "外"', '- iframe:', '  - button "枠の中"', '  - link "枠のリンク":', '    - /url: /x', '- button "外の次"'].join('\n');
  const table = readElements(snapshot, URL_FORM);
  assert.deepEqual(table.items.map(e => e.name), ['外', '外の次']);
});

test('一覧の文字: 番号・役割・名前・状態・href', () => {
  const table = readElements(fixture('form'), URL_FORM);
  const lines = formatElements(table, 'ja').split('\n');
  assert.equal(lines[0], 'e1 link "ログイン" → https://example.com/login');
  assert.ok(lines.includes('e4 button "無効" [disabled]'));
  assert.ok(lines.includes('e5 textbox "検索"'));
  assert.equal(formatElements(readElements(fixture('empty'), URL_FORM), 'ja'), '（触れるものはありません）');
});

test('長い名前は表示だけ切る（改行は空白にする）。探し直しには元の名前を使う', () => {
  const name = `${'あ'.repeat(300)}\\nX`;
  const table = readElements(`- button "${name}"\n`, URL_FORM);
  assert.equal(table.items[0]!.name.length, 302);
  const line = formatElements(table, 'ja');
  assert.ok(line.length < 200 && !line.includes('\n'));
});

function fakePage(rows: Array<{ role: string; name: string; state?: ElementState }>): PageHandle {
  const matching = (role: string, name: string) => rows.filter(r => r.role === role && r.name === name);
  return {
    countRole: async (role: string, name: string) => matching(role, name).length,
    stateOf: async (role: string, name: string, nth: number) => matching(role, name)[nth] === undefined ? undefined : (matching(role, name)[nth]!.state ?? { visible: true, enabled: true }),
  } as unknown as PageHandle;
}

test('探し直し: 数が同じなら見つかり、見える・有効かも返る', async () => {
  const table = readElements(fixture('form'), URL_FORM);
  const rows = table.items.map(e => ({ role: e.role, name: e.name, ...(e.name === '無効' ? { state: { visible: true, enabled: false } } : {}) }));
  const page = fakePage(rows);
  assert.deepEqual(await relocate(page, table.items[0]!), { ok: true, state: { visible: true, enabled: true } });
  assert.deepEqual(await relocate(page, table.items[3]!), { ok: true, state: { visible: true, enabled: false } });
});

test('探し直し: 数が変わったら「ページが変わった」（実行しない）', async () => {
  const table = readElements(fixture('form'), URL_FORM);
  const home = table.items[1]!;
  assert.deepEqual(await relocate(fakePage([{ role: 'link', name: 'Home' }]), home), { ok: false, reason: 'changed' });
  assert.deepEqual(await relocate(fakePage([{ role: 'link', name: 'Home' }, { role: 'link', name: 'Home' }, { role: 'link', name: 'Home' }]), home), { ok: false, reason: 'changed' });
  assert.deepEqual(await relocate(fakePage([]), home), { ok: false, reason: 'changed' });
});

test('表は、読んだときの URL を持つ（遷移したら捨てる判定に使う）', () => {
  const table = readElements(fixture('form'), URL_FORM);
  assert.equal(table.url, URL_FORM);
});
