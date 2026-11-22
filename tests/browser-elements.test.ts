import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { BrowserFailure } from '../src/tools/browser/driver.ts';
import { formatElements, newRefBook, readElements, REF_MAX, retiredRef } from '../src/tools/browser/elements.ts';
import { browserClick } from '../src/tools/builtin/browser.ts';

// T-05: 触れるものの番号。手本は、固定版の playwright-core（本物のブラウザ）が出した ariaSnapshot

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

test('表は 2,000 個まで持ち、見せるのは 300 個まで。超えた数を数える。nth と count は切った分も数える', () => {
  const lines = Array.from({ length: 350 }, (_, i) => `- button "b${i % 2}"`).join('\n');
  const table = readElements(lines, URL_FORM);
  assert.equal(table.items.length, 350);
  assert.equal(table.omitted, 0);
  assert.equal(table.items[299]!.ref, 'e300');
  assert.equal(table.items[349]!.ref, 'e350', '見せない 300 個より後ろにも番号がある');
  assert.equal(table.items[0]!.count, 175);
  assert.equal(table.items[298]!.nth, 149);
  const text = formatElements(table, 'en');
  assert.equal(text.split('\n').length, 301);
  assert.match(text, /\(50 more elements are omitted\)/u);
  assert.ok(!text.includes('e301 '));
  const big = readElements(Array.from({ length: 2100 }, (_, i) => `- button "x${i}"`).join('\n'), URL_FORM);
  assert.equal(big.items.length, 2000);
  assert.equal(big.omitted, 100);
  assert.match(formatElements(big, 'en'), /\(1800 more elements are omitted\)/u);
});

test('iframe の中は、番号を振らない（どのホストの枠か分からないので止める）', () => {
  const snapshot = ['- button "外"', '- iframe:', '  - button "枠の中"', '  - link "枠のリンク":', '    - /url: /x', '- button "外の次"'].join('\n');
  const table = readElements(snapshot, URL_FORM);
  assert.deepEqual(table.items.map(e => e.name), ['外', '外の次']);
});

test('一覧の文字: 番号・役割・名前・状態・href', () => {
  const table = readElements(fixture('form'), URL_FORM);
  const lines = formatElements(table, 'en').split('\n');
  assert.equal(lines[0], 'e1 link "ログイン" → https://example.com/login');
  assert.ok(lines.includes('e4 button "無効" [disabled]'));
  assert.ok(lines.includes('e5 textbox "検索"'));
  assert.equal(formatElements(readElements(fixture('empty'), URL_FORM), 'en'), '(There is nothing to touch)');
});

test('長い名前は表示だけ切る（改行は空白にする）。探し直しには元の名前を使う', () => {
  const name = `${'あ'.repeat(300)}\\nX`;
  const table = readElements(`- button "${name}"\n`, URL_FORM);
  assert.equal(table.items[0]!.name.length, 302);
  const line = formatElements(table, 'en');
  assert.ok(line.length < 200 && !line.includes('\n'));
});

test('表は、読んだときの URL を持つ（遷移したら捨てる判定に使う）', () => {
  const table = readElements(fixture('form'), URL_FORM);
  assert.equal(table.url, URL_FORM);
});

// ── P3a: 番号を変えない・変わったら使えなくする（組としるし） ──

const URL_ROWS = 'http://localhost:3457/rows';
// 本物の ariaSnapshot の形（scripts/browser-bench/live.mjs の /rows）。行ごとに同じ名前の「削除」が並ぶ
const HEAD = ['- navigation:', '  - link "行の一覧":', '    - /url: /rows', '  - link "多い画面":', '    - /url: /many', '- heading "行の一覧" [level=1]', '- paragraph:', '  - button "並べ替え"', '  - button "つぎのページ"'];
const rowsPage = (names: readonly string[], head: readonly string[] = HEAD): string => [...head, '- table:', '  - rowgroup:',
  ...names.flatMap(n => [`    - row "${n} 削除":`, `      - cell "${n}"`, '      - cell "削除":', '        - button "削除"']), '- status '].join('\n');
type Table = ReturnType<typeof readElements>;
const refsOf = (table: Table, name: string): string[] => table.items.filter(e => e.name === name).map(e => e.ref);
const allRefs = (table: Table): string[] => table.items.map(e => e.ref);
const THREE = ['材料 1', '材料 2', '材料 3'];

test('P3a: 同じ URL で読み直しても番号が同じ（手本のフォームも、行の一覧も）', () => {
  const book = newRefBook();
  const first = readElements(fixture('form'), URL_FORM, book);
  const again = readElements(fixture('form'), URL_FORM, book);
  assert.deepEqual(allRefs(again), allRefs(first));
  const rows = newRefBook();
  const a = readElements(rowsPage(THREE), URL_ROWS, rows);
  const b = readElements(rowsPage(THREE), URL_ROWS, rows);
  assert.deepEqual(allRefs(b), allRefs(a), '変わらない一覧 → 同じ番号');
  assert.deepEqual(refsOf(b, '削除'), ['e5', 'e6', 'e7']);
});

test('P3a: 前に別の名前の要素が 1 つ増えても、後ろの番号は変わらない（増えた要素は新しい番号）', () => {
  const book = newRefBook();
  const before = readElements(rowsPage(THREE), URL_ROWS, book);
  const added = readElements(rowsPage(THREE, ['- button "お知らせを閉じる"', ...HEAD]), URL_ROWS, book);
  const others = (table: Table) => table.items.filter(e => e.name !== 'お知らせを閉じる').map(e => [e.name, e.ref]);
  assert.deepEqual(others(added), others(before));
  assert.deepEqual(refsOf(added, 'お知らせを閉じる'), ['e8'], '増えた要素は続きの番号');
  assert.equal(added.items[0]!.name, 'お知らせを閉じる', '前に増えた');
});

test('P3a: 消えた要素の番号は使い回さない（同じ名前の要素が戻っても新しい番号）', () => {
  const book = newRefBook();
  const before = readElements('- button "A"\n- button "B"\n- button "C"', URL_FORM, book);
  assert.deepEqual(allRefs(before), ['e1', 'e2', 'e3']);
  const gone = readElements('- button "A"\n- button "C"', URL_FORM, book);
  assert.deepEqual(allRefs(gone), ['e1', 'e3']);
  assert.deepEqual(retiredRef(book, 'e2'), { role: 'button', name: 'B' });
  const back = readElements('- button "A"\n- button "B"\n- button "C"', URL_FORM, book);
  assert.deepEqual(allRefs(back), ['e1', 'e4', 'e3']);
});

test('P3a: URL が変わると表の番号は全部使えなくなるが、数は続きから', () => {
  const book = newRefBook();
  assert.deepEqual(allRefs(readElements('- button "A"\n- button "B"', 'https://example.com/a', book)), ['e1', 'e2']);
  assert.deepEqual(allRefs(readElements('- button "A"\n- button "B"', 'https://example.com/b', book)), ['e3', 'e4']);
  assert.ok(retiredRef(book, 'e1') && retiredRef(book, 'e2'));
  assert.deepEqual(allRefs(readElements('- button "A"\n- button "B"', 'https://example.com/a', book)), ['e5', 'e6'], '元の URL に戻っても振り直さない');
});

test('P3a: 続きの数をタブで共通にすると、番号はタブをまたいで重ならない', () => {
  const counter = { next: 1 };
  const t1 = newRefBook(counter);
  const t2 = newRefBook(counter);
  const a = readElements(fixture('form'), URL_FORM, t1);
  const b = readElements(fixture('form'), URL_FORM, t2);
  assert.equal(new Set([...allRefs(a), ...allRefs(b)]).size, a.items.length + b.items.length);
  assert.equal(b.items[0]!.ref, `e${a.items.length + 1}`);
});

test('P3a: 番号は 6 桁（e999999）まで。振り直さず、使い切ったら決まった文で断る', () => {
  const book = newRefBook({ next: REF_MAX - 1 });
  assert.deepEqual(allRefs(readElements('- button "A"\n- button "B"', URL_FORM, book)), ['e999998', 'e999999']);
  assert.throws(() => readElements('- button "A"\n- button "B"\n- button "C"', URL_FORM, book), (thrown: unknown) => {
    assert.ok(thrown instanceof BrowserFailure);
    assert.equal(thrown.code, 'ref_limit');
    assert.match(thrown.text('en'), /used up its element numbers \(up to e999999\)/u);
    return true;
  });
  assert.equal(book.counter.next, REF_MAX + 1);
  assert.equal(Value.Check(browserClick.input, { ref: 'e999999' }), true);
  assert.equal(Value.Check(browserClick.input, { ref: 'e1000000' }), false);
});

// 同じ名前の「削除」が 3 行。古い番号が別の行に当たらないこと
test('P3a: 同じ名前の「削除」が並ぶ組は、1 行消えると組ごと新しい番号になる（古い番号は使えない）', () => {
  const book = newRefBook();
  const before = refsOf(readElements(rowsPage(THREE), URL_ROWS, book), '削除');
  const after = refsOf(readElements(rowsPage(['材料 1', '材料 3']), URL_ROWS, book), '削除');
  assert.equal(after.length, 2);
  assert.ok(after.every(ref => !before.includes(ref)), `${before} → ${after}`);
  for (const ref of before) assert.deepEqual(retiredRef(book, ref), { role: 'button', name: '削除' });
});

test('P3a: 同じ数のまま並べ替えると、組ごと新しい番号になる', () => {
  const book = newRefBook();
  const before = refsOf(readElements(rowsPage(THREE), URL_ROWS, book), '削除');
  const after = refsOf(readElements(rowsPage([...THREE].reverse()), URL_ROWS, book), '削除');
  assert.equal(after.length, 3);
  assert.ok(after.every(ref => !before.includes(ref)), `${before} → ${after}`);
});

test('P3a: 同じ数のままページを送ると、組ごと新しい番号になる', () => {
  const book = newRefBook();
  const before = refsOf(readElements(rowsPage(THREE), URL_ROWS, book), '削除');
  const after = refsOf(readElements(rowsPage(['材料 4', '材料 5', '材料 6']), URL_ROWS, book), '削除');
  assert.ok(after.every(ref => !before.includes(ref)), `${before} → ${after}`);
});

test('P3a: 1 行の文が変わると、組ごと新しい番号になる', () => {
  const book = newRefBook();
  const before = refsOf(readElements(rowsPage(THREE), URL_ROWS, book), '削除');
  const after = refsOf(readElements(rowsPage(['材料 1', '材料 2（在庫なし）', '材料 3']), URL_ROWS, book), '削除');
  assert.ok(after.every(ref => !before.includes(ref)), `${before} → ${after}`);
});

// 本物の ariaSnapshot は、行・セルの名前に中の入力欄の値を含む（row "材料 1 3 削除"、cell "3"）
const inputRows = (values: readonly string[]): string => ['- table:', '  - rowgroup:', ...values.flatMap((v, i) => [
  `    - row "材料 ${i + 1} ${v} 削除":`, `      - cell "材料 ${i + 1}"`, `      - cell "${v}":`, `        - textbox "数量": "${v}"`, '      - cell "削除":', '        - button "削除"',
])].join('\n');

test('P3a: 行の入力欄に打っただけなら、番号は同じ（入力欄の値と、値を含む行の名前は手がかりに入れない）', () => {
  const book = newRefBook();
  const before = readElements(inputRows(['3', '5', '8']), URL_ROWS, book);
  const typed = readElements(inputRows(['30', '5', '8']), URL_ROWS, book);
  assert.deepEqual(allRefs(typed), allRefs(before));
  // 名前が 1 つだけの入力欄も、値が変わっても同じ番号
  const field = newRefBook();
  const a = readElements('- textbox "名前": 山', URL_FORM, field);
  assert.deepEqual(allRefs(readElements('- textbox "名前": 山田', URL_FORM, field)), allRefs(a));
});

test('P3a（見分けない、を書いておく）: 周りの行まで同じ 2 行の入れ替えは見分けられず、番号は同じ', () => {
  // モデルに見せた手がかり（名前と周りの行）でも見分けられないもの。押す前の探し直し（数・見える・有効）は今どおり
  const book = newRefBook();
  const before = refsOf(readElements(rowsPage(['材料 1', '同じ', '同じ']), URL_ROWS, book), '削除');
  const after = refsOf(readElements(rowsPage(['材料 1', '同じ', '同じ']), URL_ROWS, book), '削除');
  assert.deepEqual(after, before);
});

test('P3a（残る穴 R1-1 を書いておく）: 行を見分ける手がかりが入力欄の値だけの一覧は、同じ数のままのページ送りを見分けない', () => {
  const only = (values: readonly string[]): string => ['- table:', '  - rowgroup:', ...values.flatMap(v => [`    - row "${v} 削除":`, `      - cell "${v}":`, `        - textbox: "${v}"`, '      - cell "削除":', '        - button "削除"'])].join('\n');
  const book = newRefBook();
  const before = refsOf(readElements(only(['1', '2']), URL_ROWS, book), '削除');
  assert.deepEqual(refsOf(readElements(only(['3', '4']), URL_ROWS, book), '削除'), before);
});

test('P3a: 名前が 1 つだけの要素は、同じ URL のまま周りが変わっても同じ番号（R1-2）', () => {
  const book = newRefBook();
  const before = readElements(rowsPage(THREE), URL_ROWS, book);
  const after = readElements(rowsPage(['材料 7', '材料 8', '材料 9']), URL_ROWS, book);
  assert.deepEqual(refsOf(after, '並べ替え'), refsOf(before, '並べ替え'));
  assert.deepEqual(refsOf(after, 'つぎのページ'), refsOf(before, 'つぎのページ'));
});
