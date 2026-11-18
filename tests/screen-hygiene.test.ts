import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// 画面（web/src）の片付けの見張り。辞書の外に日本語の文字が残っていないこと、辞書に使われない項目が溜まっていないことを、毎回の npm test で確かめる。

const WEB = join(import.meta.dirname, '..', 'web', 'src');

function walk(dir: string, skip: (name: string) => boolean = () => false): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (!skip(entry.name)) out.push(...walk(path, skip)); } else if (/\.(?:tsx?|svg)$/u.test(entry.name)) out.push(path);
  }
  return out;
}

// 漢字・ひらがな・カタカナに加えて、日本語の句読点と記号（、。「」（）など = U+3000〜303F と、中黒 U+30FB）と全角形（！？：など = U+FF00〜FFEF）。
// 中黒と全角の記号は、文字の種類としては Han / Hiragana / Katakana に入らないので、別に数える。
const JAPANESE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|[　-〿・＀-￯]/u;

// コメントを外した行（行の途中の // と /* */ と JSX のコメント）。文字列の中の // は URL なので残す。
function codeLines(text: string): Array<{ no: number; code: string }> {
  const out: Array<{ no: number; code: string }> = [];
  let inBlock = false;
  text.split(/\r?\n/u).forEach((line, index) => {
    let code = line;
    if (inBlock) {
      const end = code.indexOf('*/');
      if (end < 0) return;
      code = code.slice(end + 2);
      inBlock = false;
    }
    code = code.replace(/\{\/\*.*?\*\/\}/gu, '').replace(/\/\*.*?\*\//gu, '');
    const start = code.indexOf('/*');
    if (start >= 0) { inBlock = true; code = code.slice(0, start); }
    code = code.replace(/(^|[^:'"`])\/\/.*$/u, '$1');
    out.push({ no: index + 1, code });
  });
  return out;
}

test('画面は英語だけ: web/src のどこにも（辞書 en.ts も含めて）日本語の文字が無い（API に送る曜日の値・説明の日本語の表 ja.ts とサーバーの文の日本語の表 ja-server・言語の選びの「日本語」だけ除く）', () => {
  const files = walk(WEB);
  assert.ok(files.some(file => /[\\/]i18n[\\/]en\.ts$/u.test(file)), '辞書 en.ts を読めていない');
  assert.ok(files.length > 50, `${files.length} ファイルしか読めていない`);
  const hits: string[] = [];
  for (const file of files) {
    // 説明の言語が日本語のときの表（beat i18n）。鍵は explain.ts の一覧の中だけで、tests/i18n-explain.test.ts が見張る
    if (/[\\/]i18n[\\/](?:ja\.ts$|ja-server[\\/])/u.test(file)) continue;
    for (const { no, code } of codeLines(readFileSync(file, 'utf8'))) {
      if (!JAPANESE.test(code)) continue;
      // 曜日の値（月〜日）は、サーバーの src/tasks/schedule.ts の DAY_MAP と対で API に送る値で、表示の文字ではない
      if (file.endsWith('weekdays.ts') && /^\s*\{ value: '[月火水木金土日]', label: 'weekday\.\w+' \},?\s*$/u.test(code)) continue;
      // 言語の選び（Settings › Appearance）は、各言語をその言語の文字で出す
      if (file.endsWith('state.ts') && /^export const LANG_NAME: Record<Lang, string> = \{ en: 'English', ja: '日本語' \};$/u.test(code)) continue;
      hits.push(`${file.slice(WEB.length + 1)}:${no}: ${code.trim().slice(0, 100)}`);
    }
  }
  assert.deepEqual(hits, []);
});

// キー名の組み立て（`chat.kind.${x}` など）で、前半だけが分かるキーの前半。ここに書いたものだけが、「その前半で始まるキーを全部使っている」と数えられる。
// 足すときは、組み立てる側（値の種類が決まっているところ）を確かめて、ここに理由を書く。クラス名の組み立て（`pane${x}` など）は、キーに「.」が続かないので数えない。
const DYNAMIC_PREFIXES: Record<string, string> = {
  'notifications.kind.': 'ui/settings/access-text.tsx: 通知の種類の名前（NOTIFICATION_KINDS の値）',
  'settings.mcp.problem.': 'ui/settings/mcp.tsx: 追加フォームの誤り（addProblem の値）の文',
  'settings.mcp.state.': 'ui/settings/mcp.tsx: サーバーの状態（connecting / ready / failed / off）の名前',
  'settings.mcp.toolState.': 'ui/settings/mcp.tsx: 道具の状態（registered / off / changed ほか）の名前',
  'ui.toolLabel.': 'ui/tool-row.ts: ToolRow の動詞の欄に出す道具の短い名前（組み込みの道具の名前。無い道具は名前を読める形にする）',
};

// 前半が同じキーのうち、組み立てて使うものが決まっているときの、そのキー（ここに無い同じ前半のキーは、キー全体が文字列で出てこなければ、使われていないとみなす）。
const DYNAMIC_ONLY: Record<string, readonly string[]> = {};
const builtDynamically = (key: string): boolean => Object.keys(DYNAMIC_PREFIXES).some(prefix => key.startsWith(prefix) && (DYNAMIC_ONLY[prefix]?.includes(key) ?? true));

test('辞書に、使われない項目が無い（キー全体が文字列で出てくるか、書き留めた「前半だけ組み立てるキー」の下にある）', () => {
  const dictionary = readFileSync(join(WEB, 'i18n', 'en.ts'), 'utf8');
  const keys = [...dictionary.matchAll(/^ {2}'([^']+)':/gmu)].map(m => m[1]!);
  assert.ok(keys.length > 800, `${keys.length} 件しか読めていない`);
  const literals = new Set<string>();
  const templateHeads = new Set<string>();
  const literal = /(["'`])((?:\\.|(?!\1)[^\\])*?)\1/gu;
  const addFrom = (text: string): void => {
    for (const m of text.matchAll(literal)) {
      const value = m[2]!;
      if (m[1] === '`' && value.includes('${')) {
        templateHeads.add(value.slice(0, value.indexOf('${')));
        for (const inner of value.matchAll(/\$\{([^}]*)\}/gu)) addFrom(inner[1]!);
      } else literals.add(value);
    }
  };
  for (const file of walk(WEB)) {
    // 辞書と、鍵を並べるだけの説明の一覧・日本語の表は、使っている所に数えない
    if (/[\\/]i18n[\\/](?:(?:en|ja|explain)\.ts$|ja-server[\\/])/u.test(file)) continue;
    addFrom(readFileSync(file, 'utf8'));
  }
  // 「.」で終わる前半は、キーの組み立てかもしれないので、書き留めてあるものだけを認める（書き留めていない新しいものが出たら、ここで落ちる）
  // （辞書のキーが 1 つも続かない前半 — 設定の項目の名前 `models.${id}` や、サーバーのコードの表 `engine.${key}` — は、辞書の話ではないので数えない）
  const dotHeads = [...templateHeads].filter(head => /^[a-zA-Z][\w.]*\.$/u.test(head) && keys.some(key => key.startsWith(head)));
  const unlisted = dotHeads.filter(head => !(head in DYNAMIC_PREFIXES));
  assert.deepEqual(unlisted, [], '前半だけで組み立てるキーが増えた。値の種類を確かめて、DYNAMIC_PREFIXES に理由つきで足す');
  const stale = Object.keys(DYNAMIC_PREFIXES).filter(prefix => !dotHeads.includes(prefix) || !keys.some(key => key.startsWith(prefix)));
  assert.deepEqual(stale, [], '書き留めた前半が、もう使われていない・もう辞書に無い');
  const unused = keys.filter(key => !literals.has(key) && !builtDynamically(key));
  assert.deepEqual(unused, []);
});
