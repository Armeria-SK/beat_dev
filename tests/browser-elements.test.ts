import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { BrowserFailure } from '../src/tools/browser/driver.ts';
import { formatElements, markShown, newRefBook, randomRefStart, readElements, REF_MAX, retiredRef, shownRef, type RefBook } from '../src/tools/browser/elements.ts';
import { browserClick } from '../src/tools/builtin/browser.ts';

// T-05: 触れるものの番号。手本は、固定版の playwright-core（本物の Chrome）が出した ai の形の ariaSnapshot（各行に Playwright の印 [ref=…]）

const fixture = (name: string) => readFileSync(new URL(`./fixtures/aria-snapshot-${name}.txt`, import.meta.url), 'utf8');
const URL_FORM = 'https://example.com/page';
const ai = (...lines: string[]): string => lines.join('\n');
type Table = ReturnType<typeof readElements>;
const refsOf = (table: Table, name: string): string[] => table.items.filter(e => e.name === name).map(e => e.ref);
const allRefs = (table: Table): string[] => table.items.map(e => e.ref);

test('手本（フォーム）: 番号を振る役割で、Playwright の印がある要素だけに、出てきた順に振る', () => {
  const table = readElements(fixture('ai-form'), URL_FORM);
  assert.deepEqual(table.items.map(e => [e.ref, e.role, e.name, e.pwRef]), [
    ['e1', 'link', 'ログイン', 'e4'], ['e2', 'link', 'Home', 'e6'], ['e3', 'link', 'Home', 'e7'], ['e4', 'button', '無効', 'e8'],
    ['e5', 'textbox', '検索', 'e9'], ['e6', 'textbox', 'パスワード', 'e10'], ['e7', 'checkbox', '覚える', 'e12'], ['e8', 'combobox', '言語', 'e13'],
    ['e9', 'button', '送信', 'e14'], ['e10', 'tab', 'T1', 'e20'],
  ], '<select> の option は Playwright が印を付けないので番号なし。iframe の中も番号なし');
  assert.equal(table.omitted, 0);
  assert.ok(!table.items.some(e => ['heading', 'paragraph', 'navigation', 'list', 'listitem', 'text', 'tablist', 'generic'].includes(e.role)));
});

test('状態（disabled / checked / selected）を持つ。焦点・カーソルの印（[active]・[cursor=pointer]）は状態に入れない', () => {
  const table = readElements(fixture('ai-form'), URL_FORM);
  const by = (name: string) => table.items.find(e => e.name === name)!;
  assert.deepEqual(by('無効').states, ['disabled']);
  assert.deepEqual(by('覚える').states, ['checked']);
  assert.deepEqual(by('T1').states, ['selected']);
  assert.deepEqual(by('ログイン').states, []);
});

test('リンクの href は、相対なら元の URL で絶対にし、pageUrl を通るものだけ出す', () => {
  const table = readElements(fixture('ai-article'), 'https://news.example.org/a/b');
  const link = (name: string) => table.items.find(e => e.name === name)!;
  assert.equal(link('危険なリンク').href, undefined);
  assert.equal(link('内向きのリンク').href, undefined);
  assert.equal(link('普通のリンク').href, 'https://example.org/ok?a=1');
  assert.equal(link('次へ >>> 進む').href, 'https://news.example.org/next');
  assert.equal(link('連絡').href, undefined, 'mailto: は出さない');
  assert.equal(link('山田').href, 'https://news.example.org/p/1');
  assert.equal(link('Example News').href, 'https://news.example.org/', '画像だけのリンクは、画像の名前で振る');
});

test('手本（記事）: 印のある役割（searchbox / menuitem 系 / spinbutton / switch / radio / listbox / option）に振る', () => {
  const table = readElements(fixture('ai-article'), 'https://news.example.org/a/b');
  const roles = new Set(table.items.map(e => e.role));
  for (const role of ['link', 'button', 'searchbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'spinbutton', 'switch', 'radio', 'listbox', 'option']) assert.ok(roles.has(role), role);
  assert.ok(!roles.has('img') && !roles.has('heading') && !roles.has('cell') && !roles.has('row'));
  assert.ok(!table.items.some(e => e.name === '音量'), '印の無い slider（見えない）には振らない');
});

test('名前の引用符（\\"）を元に戻す。行全体が一重引用の行（名前に「: 」「#」「{}」を含む）も読み、\'\' を \' に戻す', () => {
  const table = readElements(ai(
    '- button "say \\"hi\\" \\\\ ok" [ref=e1]',
    '- \'button "Order #1001: pay" [ref=e2]\'',
    '- \'link "Go: \\"q\\" \'\'x\'\' #1" [ref=e3] [cursor=pointer]\':',
    '  - /url: /y',
    '- \'button "{x}" [ref=e4]\'',
  ), URL_FORM);
  assert.deepEqual(table.items.map(e => [e.name, e.pwRef]), [['say "hi" \\ ok', 'e1'], ['Order #1001: pay', 'e2'], ['Go: "q" \'x\' #1', 'e3'], ['{x}', 'e4']]);
  assert.equal(table.items[2]!.href, 'https://example.com/y', '引用の行の下の /url: も読む');
});

test('名前の無いもの・印の無いものには番号を振らない（引けない）', () => {
  const table = readElements(ai('- button [ref=e1]', '- link [ref=e2]:', '  - /url: /x', '- button "OK" [ref=e3]', '- button "印なし"'), URL_FORM);
  assert.deepEqual(table.items.map(e => [e.ref, e.name]), [['e1', 'OK']]);
});

test('名前が子から来る要素（ai の形では親の行に名前が無い）は、下の行の名前と文から名前を作って振る。入力欄の値は名前に入れない', () => {
  const table = readElements(ai(
    '- link [ref=e2] [cursor=pointer]:', '  - /url: /home', '  - img "Logo" [ref=e3]',
    '- button [ref=e4]:', '  - img "Close" [ref=e5]',
    '- button [ref=e6]:', '  - img "Trash" [ref=e7]', '  - text: Delete',
    '- link [ref=e8]:', '  - /url: /m', '  - strong: Bold', '  - emphasis: mixed',
    '- link [ref=e9]:', '  - /url: /card', '  - heading "Card title" [level=3] [ref=e10]:', '    - text: ignored below a name', '  - paragraph: Card body',
    '- tab [ref=e11]:', '  - img "Settings" [ref=e12]',
    '- button [ref=e13]:', '  - textbox "Qty" [ref=e14]: secret value', '  - text: Apply',
  ), URL_FORM);
  assert.deepEqual(table.items.map(e => [e.ref, e.role, e.name]), [
    ['e1', 'link', 'Logo'], ['e2', 'button', 'Close'], ['e3', 'button', 'Trash Delete'], ['e4', 'link', 'Bold mixed'],
    ['e5', 'link', 'Card title Card body'], ['e6', 'tab', 'Settings'], ['e7', 'button', 'Apply'], ['e8', 'textbox', 'Qty'],
  ]);
  assert.equal(table.items[0]!.href, 'https://example.com/home');
});

test('子から作る名前は 900 字まで。切ったあとの中身の変化も、全体のまとめで手がかりに入る。値の YAML の引用は外す', () => {
  const long = (tail: string): string => ai('- link [ref=e1]:', '  - /url: /card', ...Array.from({ length: 3000 }, (_, i) => `  - paragraph [ref=p${i}]: 長い説明 ${i}`), `  - paragraph [ref=pz]: ${tail}`, '- button "Next" [ref=e2]');
  const book = newRefBook();
  const first = readElements(long('A'), URL_FORM, book);
  const card = first.items.find(e => e.role === 'link')!;
  assert.equal([...card.name].length, 900);
  assert.ok(first.items.some(e => e.name === 'Next'), '長い名前のあとの要素も見える');
  const again = readElements(long('B'), URL_FORM, book).items.find(e => e.role === 'link')!;
  assert.equal(again.name, card.name, '見える名前は同じ');
  assert.notEqual(again.ref, card.ref, '切った後ろの中身が変わると、新しい番号');
  const quoted = readElements(ai('- link [ref=e7]:', '  - /url: /p', '  - text: Product 1', '  - generic: "\\"9.99\\""', '  - generic: \'it\'\'s\''), URL_FORM).items[0]!;
  assert.equal(quoted.name, 'Product 1 "9.99" it\'s');
});

test('名前を子から作った要素も、名前が手がかりに入る（子の名前が変われば番号が変わる）', () => {
  const book = newRefBook();
  const [before] = readElements(ai('- button [ref=e4]:', '  - img "Close" [ref=e5]'), URL_FORM, book).items;
  const [after] = readElements(ai('- button [ref=e4]:', '  - img "Open" [ref=e5]'), URL_FORM, book).items;
  assert.equal(before!.name, 'Close');
  assert.equal(after!.name, 'Open');
  assert.notEqual(after!.ref, before!.ref);
  assert.equal(retiredRef(book, before!.ref), true);
});

test('組の最初の要素の窓は入れ物の 8 行前（か入れ物の親の頭）から: 1 行目の見出しだけが変わると、1 行目の番号が使えなくなる', () => {
  const card = (heading: string, n: number): string[] => [
    `  - heading "${heading}" [level=3] [ref=h${n}]`,
    ...Array.from({ length: 9 }, (_, i) => `  - paragraph [ref=p${n}x${i}]: detail ${i}`),
    `  - button "Delete" [ref=b${n}]`,
  ];
  const page = (first: string): string => ai('- generic [ref=g]:', ...card(first, 1), ...card('Order #1002', 2));
  const book = newRefBook();
  const [one, two] = refsOf(readElements(page('Order #1001'), URL_ROWS, book), 'Delete');
  const after = refsOf(readElements(page('Order #1005'), URL_ROWS, book), 'Delete');
  assert.equal(retiredRef(book, one!), true, '1 行目の番号は使えない');
  assert.notEqual(after[0], one);
  assert.equal(after[1], two, '2 行目の窓（1 行目の入れ物の後ろから）は同じ');
  // 最後の要素も同じ形（入れ物のあと 8 行か、入れ物の親の終わりまで）
  const tail = (last: string): string => ai('- generic [ref=g]:', ...card('Order #1001', 1), ...card('Order #1002', 2), ...Array.from({ length: 9 }, (_, i) => `  - paragraph [ref=t${i}]: tail ${i}`), `  - paragraph [ref=tz]: ${last}`);
  const book2 = newRefBook();
  const [, lastBefore] = refsOf(readElements(tail('end A'), URL_ROWS, book2), 'Delete');
  readElements(tail('end B'), URL_ROWS, book2);
  assert.equal(retiredRef(book2, lastBefore!), true, '最後の要素のあとの、入れ物の親の中の行が変わると使えない');
});

test('同じ印が 2 回出る表（本来は無い）は、その印に番号を振らない', () => {
  const table = readElements(ai('- button "A" [ref=e1]', '- button "B" [ref=e1]', '- button "C" [ref=e2]'), URL_FORM);
  assert.deepEqual(table.items.map(e => e.name), ['C']);
});

test('番号を振るのは見せる 300 個だけ。超えた数を数え、後ろには番号を振らない（続きの数も進めない）', () => {
  const lines = Array.from({ length: 350 }, (_, i) => `- button "b${i % 2}" [ref=e${i + 10}]`).join('\n');
  const book = newRefBook();
  const table = readElements(lines, URL_FORM, book);
  assert.equal(table.items.length, 300);
  assert.equal(table.omitted, 50);
  assert.equal(table.items[299]!.ref, 'e300');
  assert.equal(book.counter.next, 301, '見せない 50 個には番号を振らない');
  const text = formatElements(table, 'en');
  assert.equal(text.split('\n').length, 301);
  assert.match(text, /\(50 more elements are omitted\)/u);
  assert.ok(!text.includes('e301 '));
});

test('show の fits: 収まらない行のところで止め、そこから後ろには新しい番号を振らない。前に見せた番号は、見せなくても中身が同じなら残る', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `- button "x${i}" [ref=e${i + 1}]`).join('\n');
  const book = newRefBook();
  const all = readElements(lines, URL_FORM, book);
  assert.equal(all.items.length, 10);
  let room = 3;
  const few = readElements(lines, URL_FORM, book, 0, { kind: 'show', fits: () => room-- > 0 });
  assert.deepEqual(few.items.map(e => e.ref), ['e1', 'e2', 'e3']);
  assert.equal(few.omitted, 7);
  const check = readElements(lines, URL_FORM, book, 0, { kind: 'check' });
  assert.deepEqual(check.items.map(e => e.ref), all.items.map(e => e.ref), '見せなかった行の前の番号も、中身が同じなら使える');
  const fresh = newRefBook();
  room = 2;
  const cut = readElements(lines, URL_FORM, fresh, 0, { kind: 'show', fits: () => room-- > 0 });
  assert.deepEqual(cut.items.map(e => e.ref), ['e1', 'e2']);
  assert.equal(fresh.counter.next, 3, '収まらない行には番号を振らない');
});

test('check: 押す前の取り直しは、新しい番号を振らない（前の番号のうち同じ要素・中身のものだけ）', () => {
  const book = newRefBook();
  readElements(ai('- button "A" [ref=a1]', '- button "B" [ref=b1]'), URL_FORM, book);
  const next = book.counter.next;
  const check = readElements(ai('- button "A" [ref=a1]', '- button "B2" [ref=b1]', '- button "C" [ref=c1]'), URL_FORM, book, 0, { kind: 'check' });
  assert.deepEqual(check.items.map(e => [e.ref, e.name]), [['e1', 'A']]);
  assert.equal(book.counter.next, next, '新しい番号を振らない');
  assert.equal(retiredRef(book, 'e2'), true, '名前の変わった要素の番号は使えない');
});

test('iframe の中は、番号を振らない（どのホストの枠か分からないので止める）。印の頭（f1e2）の形では決めず、木の中で iframe の下かで見る', () => {
  const snapshot = ai('- button "外" [ref=f1e1]', '- iframe [ref=f1e2]:', '  - button "枠の中" [ref=f2e2]', '  - link "枠のリンク" [ref=e9]:', '    - /url: /x', '- button "外の次" [ref=f1e5]');
  const table = readElements(snapshot, URL_FORM);
  assert.deepEqual(table.items.map(e => [e.name, e.pwRef]), [['外', 'f1e1'], ['外の次', 'f1e5']]);
});

test('一覧の文字: 番号・役割・名前・状態・href（Playwright の印は見せない）', () => {
  const table = readElements(fixture('ai-form'), URL_FORM);
  const lines = formatElements(table, 'en').split('\n');
  assert.equal(lines[0], 'e1 link "ログイン" → https://example.com/login');
  assert.ok(lines.includes('e4 button "無効" [disabled]'));
  assert.ok(lines.includes('e5 textbox "検索"'));
  assert.ok(!formatElements(table, 'en').includes('ref='));
  assert.equal(formatElements(readElements(fixture('empty'), URL_FORM), 'en'), '(There is nothing to touch)');
});

test('長い名前は表示だけ切る（改行は空白にする）。名前は元のまま持つ', () => {
  const name = `${'あ'.repeat(300)}\\nX`;
  const table = readElements(`- button "${name}" [ref=e1]\n`, URL_FORM);
  assert.equal(table.items[0]!.name.length, 302);
  const line = formatElements(table, 'en');
  assert.ok(line.length < 200 && !line.includes('\n'));
});

test('表は、読んだときの URL を持つ（遷移したら捨てる判定に使う）', () => {
  assert.equal(readElements(fixture('ai-form'), URL_FORM).url, URL_FORM);
});

// ── P3a: 番号を要素そのもの（Playwright の印）に結び、要素ごとに中身（手がかり）を確かめる ──

const URL_ROWS = 'http://localhost:3457/rows';
// 行ごとに同じ名前の「Delete」が並ぶ表（本物の ai の形: row・cell は名前を持たず、文は cell の名前）。ids: 行ごとの [行, 文のセル, 押す部品のセル, ボタン] の印
const HEAD = ['- navigation [ref=h1]:', '  - link "Rows" [ref=h2] [cursor=pointer]:', '    - /url: /rows', '- heading "Rows" [level=1] [ref=h3]', '- button "Sort" [ref=h4]'];
interface Row { id: string; text: string }
const table = (rows: readonly Row[], head: readonly string[] = HEAD): string => ai(...head, '- table [ref=t1]:', '  - rowgroup [ref=t2]:',
  ...rows.flatMap(r => [`    - row [ref=${r.id}r]:`, `      - cell "${r.text}" [ref=${r.id}c]`, `      - cell [ref=${r.id}d]:`, `        - button "Delete" [ref=${r.id}b]`]));
const R1 = { id: 'a', text: 'Order 1' };
const R2 = { id: 'b', text: 'Order 2' };
const R3 = { id: 'c', text: 'Order 3' };
const read = (book: RefBook, snapshot: string, document = 0) => readElements(snapshot, URL_ROWS, book, document);

test('P3a: 同じ文書で読み直しても番号が同じ（手本のフォームも、行の一覧も）', () => {
  const book = newRefBook();
  const first = readElements(fixture('ai-form'), URL_FORM, book);
  assert.deepEqual(allRefs(readElements(fixture('ai-form'), URL_FORM, book)), allRefs(first));
  const rows = newRefBook();
  const a = read(rows, table([R1, R2, R3]));
  assert.deepEqual(allRefs(read(rows, table([R1, R2, R3]))), allRefs(a));
  assert.deepEqual(refsOf(a, 'Delete'), ['e3', 'e4', 'e5']);
});

test('P3a: 前に別の要素が増えても、ほかの番号は変わらない（増えた要素は新しい番号）', () => {
  // 増える所は、組の最初の要素の入れ物の 8 行前より前（その窓の中なら、最初の行は新しい番号になる。下の試験）
  const filler = Array.from({ length: 8 }, (_, i) => `- paragraph [ref=p${i}]: note ${i}`);
  const book = newRefBook();
  const before = read(book, table([R1, R2, R3], [...filler, ...HEAD]));
  const added = read(book, table([R1, R2, R3], ['- button "Close notice" [ref=n1]', ...filler, ...HEAD]));
  const others = (t: Table) => t.items.filter(e => e.name !== 'Close notice').map(e => [e.name, e.ref]);
  assert.deepEqual(others(added), others(before));
  assert.deepEqual(refsOf(added, 'Close notice'), ['e6']);
});

test('P3a: 3 行の「Delete」の 2 行目を消すと、2 行目の番号だけ使えなくなり、1・3 行目は同じ（番号は要素ごと）', () => {
  const book = newRefBook();
  const [one, two, three] = refsOf(read(book, table([R1, R2, R3])), 'Delete');
  const after = refsOf(read(book, table([R1, R3])), 'Delete');
  assert.deepEqual(after, [one, three]);
  assert.equal(retiredRef(book, two!), true);
  assert.equal(retiredRef(book, one!), false);
});

test('P3a: 要素はそのままで行の文だけが入れ替わる（鍵の無い一覧の作り直し。印は同じ）と、両方の行の番号が使えなくなる', () => {
  const book = newRefBook();
  const before = refsOf(read(book, table([R1, R2])), 'Delete');
  const after = refsOf(read(book, table([{ id: 'a', text: 'Order 2' }, { id: 'b', text: 'Order 1' }])), 'Delete');
  assert.equal(after.length, 2);
  assert.ok(after.every(ref => !before.includes(ref)), `${before} → ${after}`);
  for (const ref of before) assert.equal(retiredRef(book, ref), true);
});

test('P3a: 一重引用の行（名前に「: 」「#」を含む文のセル）の入れ替えでも、番号が使えなくなる', () => {
  const quoted = (a: string, b: string): string => ai('- table [ref=t1]:', '  - rowgroup [ref=t2]:',
    '    - row [ref=r1]:', `      - 'cell "${a}" [ref=c1]'`, '      - cell [ref=d1]:', '        - button "Delete" [ref=b1]',
    '    - row [ref=r2]:', `      - 'cell "${b}" [ref=c2]'`, '      - cell [ref=d2]:', '        - button "Delete" [ref=b2]');
  const book = newRefBook();
  const before = refsOf(read(book, quoted('Order #1001: paid', 'Order #1002: open')), 'Delete');
  const after = refsOf(read(book, quoted('Order #1002: open', 'Order #1001: paid')), 'Delete');
  assert.ok(after.every(ref => !before.includes(ref)), `${before} → ${after}`);
});

test('P3a: div だけのカード 2 枚（見出しと 9 行が同じ形）の中身が入れ替わると、両方の番号が使えなくなる（入れ物の下の全部の行を見る）', () => {
  const card = (n: number, title: string): string[] => [`- generic [ref=g${n}]:`, `  - heading "${title}" [level=3] [ref=h${n}]`,
    ...Array.from({ length: 9 }, (_, i) => `  - paragraph [ref=p${n}${i}]: line ${i}`), `  - button "Add to cart" [ref=b${n}]`];
  const book = newRefBook();
  const before = refsOf(read(book, ai(...card(1, 'Chair'), ...card(2, 'Knife'))), 'Add to cart');
  const after = refsOf(read(book, ai(...card(1, 'Knife'), ...card(2, 'Chair'))), 'Add to cart');
  assert.ok(after.every(ref => !before.includes(ref)), `${before} → ${after}`);
  // 変わらなければ同じ番号
  assert.deepEqual(refsOf(read(book, ai(...card(1, 'Knife'), ...card(2, 'Chair'))), 'Add to cart'), after);
});

test('P3a: 入れ物の無い平らな一覧（文とボタンが並ぶだけ）で文が入れ替わると、両方の番号が使えなくなる（あいだの行を見る）', () => {
  const flat = (a: string, b: string): string => ai('- list [ref=l1]:', `  - text: ${a}`, '  - button "Delete" [ref=b1]', `  - text: ${b}`, '  - button "Delete" [ref=b2]');
  const book = newRefBook();
  const before = refsOf(read(book, flat('Alice', 'Bob')), 'Delete');
  const after = refsOf(read(book, flat('Bob', 'Alice')), 'Delete');
  assert.ok(after.every(ref => !before.includes(ref)), `${before} → ${after}`);
  // ボタンが先・文があと（最後の要素のあとの行も見る）
  const after2 = (a: string, b: string): string => ai('- list [ref=l1]:', '  - checkbox "Done" [ref=c1]', `  - text: ${a}`, '  - checkbox "Done" [ref=c2]', `  - text: ${b}`);
  const done = newRefBook();
  const old = refsOf(read(done, after2('Buy milk', 'Pay rent')), 'Done');
  const now = refsOf(read(done, after2('Buy milk', 'Delete account')), 'Done');
  assert.equal(now[0], old[0], '1 つ目のあとの行（Buy milk）は同じ');
  assert.notEqual(now[1], old[1]);
});

test('P3a（残る形として書く）: 動いている表示（時計）が組の入れ物の中にあると、その組は読むたびに番号が使えなくなる。名前が 1 つだけの要素は押せる', () => {
  const page = (time: string): string => ai('- button "Stop" [ref=s1]', '- listitem [ref=i1]:', `  - text: ${time}`, '  - button "Snooze" [ref=b1]', '- listitem [ref=i2]:', '  - text: later', '  - button "Snooze" [ref=b2]');
  const book = newRefBook();
  const first = read(book, page('12:00:01'));
  const second = read(book, page('12:00:02'));
  assert.notEqual(refsOf(second, 'Snooze')[0], refsOf(first, 'Snooze')[0]);
  assert.deepEqual(refsOf(second, 'Stop'), refsOf(first, 'Stop'));
});

test('P3a: 行の入力欄に打っただけなら、番号は同じ（入力欄の値は手がかりに入れない）', () => {
  const rows = (a: string, b: string): string => ai('- table [ref=t1]:', '  - rowgroup [ref=t2]:',
    '    - row [ref=r1]:', '      - cell "Item 1" [ref=c1]', '      - cell [ref=d1]:', `        - textbox "Qty" [ref=x1]: "${a}"`, '      - cell [ref=e1]:', '        - button "Delete" [ref=b1]',
    '    - row [ref=r2]:', '      - cell "Item 2" [ref=c2]', '      - cell [ref=d2]:', `        - textbox "Qty" [ref=x2]: "${b}"`, '      - cell [ref=e2]:', '        - button "Delete" [ref=b2]');
  const book = newRefBook();
  const before = read(book, rows('3', '5'));
  assert.deepEqual(allRefs(read(book, rows('30', '5'))), allRefs(before));
  const field = newRefBook();
  const a = read(field, '- textbox "名前" [ref=x1]: 山');
  assert.deepEqual(allRefs(read(field, '- textbox "名前" [ref=x1]: 山田')), allRefs(a), '名前が 1 つだけの入力欄も');
});

test('P3a（R1-1）: 入れ物の中身（値を除く）が同じ要素がある組だけ、入力欄の値も手がかりに入れる（ページ送りで新しい番号。打っても新しい番号）', () => {
  const only = (values: readonly string[]): string => ai('- table [ref=t1]:', '  - rowgroup [ref=t2]:', ...values.flatMap((v, i) => [
    `    - row [ref=r${i}]:`, `      - cell [ref=c${i}]:`, `        - textbox [ref=x${i}]: "${v}"`, `      - cell [ref=d${i}]:`, `        - button "Delete" [ref=b${i}]`]));
  const book = newRefBook();
  const before = refsOf(read(book, only(['1', '2'])), 'Delete');
  const paged = refsOf(read(book, only(['3', '4'])), 'Delete');
  assert.ok(paged.every(ref => !before.includes(ref)), `${before} → ${paged}`);
  const typed = refsOf(read(book, only(['3', '5'])), 'Delete');
  assert.equal(typed[0], paged[0], '値が変わらない行は同じ');
  assert.notEqual(typed[1], paged[1], '値で見分ける組は、打つと新しい番号（安全の側）');
  const sorted = newRefBook();
  const three = refsOf(read(sorted, only(['1', '2', '3'])), 'Delete');
  const reversed = refsOf(read(sorted, only(['3', '2', '1'])), 'Delete');
  assert.ok(reversed[0] !== three[0] && reversed[2] !== three[2]);
});

test('P3a: 同じ名前のリンクの行き先・状態（[checked]）が入れ替わったら、その要素の番号は使えなくなる', () => {
  const links = (a: string, b: string): string => ai(`- link "Open" [ref=l1]:`, `  - /url: ${a}`, '- link "Open" [ref=l2]:', `  - /url: ${b}`);
  const book = newRefBook();
  const old = refsOf(read(book, links('/r/1', '/r/2')), 'Open');
  const now = refsOf(read(book, links('/r/2', '/r/1')), 'Open');
  assert.ok(now.every(ref => !old.includes(ref)));
  const list = (first: boolean): string => ai('- list [ref=l0]:', '  - listitem [ref=i1]:', `    - checkbox "Done"${first ? ' [checked]' : ''} [ref=c1]`, '    - button "Delete" [ref=b1]',
    '  - listitem [ref=i2]:', `    - checkbox "Done"${first ? '' : ' [checked]'} [ref=c2]`, '    - button "Delete" [ref=b2]');
  const states = newRefBook();
  const a = read(states, list(true));
  const b = read(states, list(false));
  for (const name of ['Done', 'Delete']) assert.ok(refsOf(b, name).every(ref => !refsOf(a, name).includes(ref)), name);
});

test('P3a: 焦点・カーソルの印（[active]・[cursor=pointer]）が変わっても番号は同じ', () => {
  const book = newRefBook();
  const a = read(book, ai('- generic [active] [ref=g1]:', '  - button "Go" [ref=b1]', '  - button "Go" [ref=b2] [cursor=pointer]'));
  const b = read(book, ai('- generic [ref=g1]:', '  - button "Go" [active] [ref=b1] [cursor=pointer]', '  - button "Go" [ref=b2]'));
  assert.deepEqual(allRefs(b), allRefs(a));
});

test('P3a: 同じ URL でも新しい文書（再読み込み・POST の結果。文書の代が進む）なら、番号は全部使えなくなる', () => {
  const book = newRefBook();
  const before = read(book, table([R1, R2]), 1);
  const after = read(book, table([R1, R2]), 2);
  assert.ok(allRefs(after).every(ref => !allRefs(before).includes(ref)));
  for (const ref of allRefs(before)) assert.equal(retiredRef(book, ref), true);
});

test('P3a: 要素が作り直される（同じ役割・名前で印が新しい）と、その要素の番号は使えなくなる', () => {
  const book = newRefBook();
  const before = read(book, ai('- button "Pay" [ref=e5]'));
  const after = read(book, ai('- button "Pay" [ref=e9]'));
  assert.notEqual(after.items[0]!.ref, before.items[0]!.ref);
  assert.equal(retiredRef(book, before.items[0]!.ref), true);
});

test('P3a: 読めない行は番号を振らず、その行の文の変化で近くの組の番号が使えなくなる', () => {
  const page = (odd: string): string => ai('- list [ref=l1]:', '  - button "Pick" [ref=b1]', `  - '${odd}`, '  - button "Pick" [ref=b2]');
  const book = newRefBook();
  const before = read(book, page('broken quote A'));
  assert.equal(before.items.length, 2);
  const after = read(book, page('broken quote B'));
  assert.ok(refsOf(after, 'Pick').every(ref => !refsOf(before, 'Pick').includes(ref)));
});

test('P3a: 見せた番号を覚える（見せていない番号は押せない。使えなくなった番号は見せたものから外す）', () => {
  const book = newRefBook();
  const first = read(book, ai('- button "A" [ref=a]', '- button "B" [ref=b]'));
  assert.equal(shownRef(book, 'e1'), false);
  markShown(book, first.items.slice(0, 1));
  assert.equal(shownRef(book, 'e1'), true);
  assert.equal(shownRef(book, 'e2'), false);
  read(book, ai('- button "B" [ref=b]'));
  assert.equal(shownRef(book, 'e1'), false);
});

test('P3a: 消えた要素の番号は使い回さない（同じ名前の要素が戻っても新しい番号）', () => {
  const book = newRefBook();
  assert.deepEqual(allRefs(read(book, ai('- button "A" [ref=a]', '- button "B" [ref=b]', '- button "C" [ref=c]'))), ['e1', 'e2', 'e3']);
  assert.deepEqual(allRefs(read(book, ai('- button "A" [ref=a]', '- button "C" [ref=c]'))), ['e1', 'e3']);
  assert.equal(retiredRef(book, 'e2'), true);
  assert.deepEqual(allRefs(read(book, ai('- button "A" [ref=a]', '- button "B" [ref=b2]', '- button "C" [ref=c]'))), ['e1', 'e4', 'e3']);
});

test('P3a: URL が変わると表の番号は全部使えなくなるが、数は続きから', () => {
  const book = newRefBook();
  const two = ai('- button "A" [ref=a]', '- button "B" [ref=b]');
  assert.deepEqual(allRefs(readElements(two, 'https://example.com/a', book)), ['e1', 'e2']);
  assert.deepEqual(allRefs(readElements(two, 'https://example.com/b', book)), ['e3', 'e4']);
  assert.ok(retiredRef(book, 'e1') && retiredRef(book, 'e2'));
  assert.deepEqual(allRefs(readElements(two, 'https://example.com/a', book)), ['e5', 'e6'], '元の URL に戻っても振り直さない');
});

test('P3a: 続きの数をタブで共通にすると、番号はタブをまたいで重ならない', () => {
  const counter = { next: 1 };
  const a = readElements(fixture('ai-form'), URL_FORM, newRefBook(counter));
  const b = readElements(fixture('ai-form'), URL_FORM, newRefBook(counter));
  assert.equal(new Set([...allRefs(a), ...allRefs(b)]).size, a.items.length + b.items.length);
  assert.equal(b.items[0]!.ref, `e${a.items.length + 1}`);
});

test('P3a: 番号は 6 桁（e999999）まで。振り直さず、使い切ったら決まった文で断る', () => {
  const book = newRefBook({ next: REF_MAX - 1 });
  assert.deepEqual(allRefs(readElements(ai('- button "A" [ref=a]', '- button "B" [ref=b]'), URL_FORM, book)), ['e999998', 'e999999']);
  assert.throws(() => readElements(ai('- button "A" [ref=a]', '- button "B" [ref=b]', '- button "C" [ref=c]'), URL_FORM, book), (thrown: unknown) => {
    assert.ok(thrown instanceof BrowserFailure);
    assert.equal(thrown.code, 'ref_limit');
    assert.match(thrown.text('en'), /used up its element numbers \(up to e999999\)/u);
    return true;
  });
  assert.equal(book.counter.next, REF_MAX + 1);
  assert.equal(Value.Check(browserClick.input, { ref: 'e999999' }), true);
  assert.equal(Value.Check(browserClick.input, { ref: 'e1000000' }), false);
});

test('P3a: beat の起動ごとの番号の始まりは 1〜9,000（使い切るまで 990,000 個以上残る）', () => {
  for (let i = 0; i < 200; i++) {
    const start = randomRefStart();
    assert.ok(Number.isInteger(start) && start >= 1 && start <= 9_000, String(start));
    assert.ok(REF_MAX - start + 1 >= 990_000);
  }
});

test('P3a: 速さ: 同じ名前のボタン 3,000 個の一覧 2 つ（ai の形・約 540 KB）で、1 回の読みが 500 ms 未満', () => {
  const list = (n: number): string[] => [`- list [ref=l${n}]:`, ...Array.from({ length: 3000 }, (_, i) => [
    `  - listitem [ref=i${n}x${i}]:`, `    - text: 品物 ${n}-${i} のくわしい説明`, `    - button "Add to cart" [ref=b${n}x${i}] [cursor=pointer]`]).flat()];
  const snapshot = ai(...list(1), ...list(2));
  assert.ok(snapshot.length > 450_000, `${snapshot.length}`);
  const book = newRefBook();
  const started = performance.now();
  const first = read(book, snapshot);
  const again = read(book, snapshot);
  const took = (performance.now() - started) / 2;
  assert.equal(first.items.length, 300, '見せるのは 300 個まで');
  assert.deepEqual(allRefs(again), allRefs(first));
  assert.ok(took < 500, `${Math.round(took)} ms`);
});

test('P3a: 速さ: 1 MB の長い名前の行の中に同じ名前のボタンが 2,000 個あっても、500 ms 未満（行のまとめは 1 行に 1 回だけ作る）', () => {
  const buttons = Array.from({ length: 2000 }, (_, i) => `  - button "Pick" [ref=b${i}]`);
  const snapshot = ai(`- row "${'長い名前 '.repeat(200_000)}" [ref=r1]:`, ...buttons);
  assert.ok(snapshot.length > 1_000_000, `${snapshot.length}`);
  const started = performance.now();
  const t = read(newRefBook(), snapshot);
  const took = performance.now() - started;
  assert.equal(refsOf(t, 'Pick').length, 300, '見せるのは 300 個まで（手がかりは組の 2,000 個全部で作る）');
  assert.ok(took < 500, `${Math.round(took)} ms`);
});
