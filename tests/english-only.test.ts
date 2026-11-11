import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

// 製品のコード（src と web/src）の文字列・テンプレート・正規表現・JSX の文字に、日本語の文字が無いことを毎回の npm test で確かめる。コメントは数えない。
// 日本語の文字は tests/screen-hygiene.test.ts の JAPANESE と同じ（漢字・ひらがな・カタカナ・日本語の句読点と記号・全角形）。
// 全角の記号・全角の空白を見分ける正規表現や、枠の偽装を防ぐ全角の文字は、英語化の対象ではない。このテストが落ちたら、まず下の EXCEPTIONS に当たるかを見る。
// 見張り（shell-lex.ts / mcp/tool.ts / browser/checks.ts）の文字を消して通すことはしない。

const ROOT = join(import.meta.dirname, '..');
const JAPANESE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|[　-〿・＀-￯]/u;

// ずっと許すもの: ファイル → 許す文字列の中身（文字列・正規表現の本文そのもの。複数行の文字列は、日本語の文字を含む行を前後の空白を除いて 1 つずつ）の並び → 理由。
// 見つかった日本語の文字列の集まりが、この並びとちょうど一致すること（増えても、入れ替わっても、消えても落ちる。消えたら一覧から外す）。
// 持ち主が「ここを日本語に」と頼んだ鍵は、その表のファイルにここで 1 行足す（理由に「持ち主が日本語を頼んだ鍵」）。
const EXCEPTIONS: Record<string, { strings: string[]; reason: string }> = {
  'src/tools/hooks/shell-lex.ts': { strings: ['/[\u{FF01}-\u{FF5E}\u{3000}]/u'], reason: 'FULLWIDTH: 引用符の外の全角の文字を見つける（シェルの見張り。安全）' },
  'src/mcp/tool.ts': { strings: ['＜', '＞'], reason: 'neutralizeFence: MCP の答えの中の <<< >>> を全角にして枠の偽装を防ぐ（安全）' },
  'src/tools/browser/checks.ts': { strings: ['/password|passcode|passwd|パスワード|暗証|one[- ]?time|verification code|認証コード|card number|カード番号|cvc|cvv|security code|セキュリティコード/iu'], reason: 'SECRET_NAME: Web ページの日本語のパスワード欄を見分ける（安全）' },
  'src/shared/pdf-text.ts': { strings: ['/[\\s\u{3000}]+$/u'], reason: 'PDF の本文の行末の全角の空白を落とす' },
  'src/engine/tokens.ts': { strings: ['/[\u{3000}-\u{30FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{F900}-\u{FAFF}\u{FF00}-\u{FFEF}\u{AC00}-\u{D7AF}]/u'], reason: 'CJK: トークンの見積もりで日本語の文字を数える' },
  'src/db/migrations.ts': {
    strings: [
      '-- 会話の開始時に作る凍結スナップショット（system の不変部分）。会話中は変えない',
      '-- 検索と表示に使う平文',
      '-- モデルに渡す構造（ツール呼び出しなど）の JSON',
      '-- 伏せ字にした入力',
      '-- 記憶の変更履歴（取り消しの元データ）',
      '-- SOUL.md と USER.md の版（会話の開始時に中身が変わっていたら残す）',
      '-- 会話の古い部分の要約（コンテキストに入りきらなくなったときに作る）',
      "-- 繰り返し（status = 'scheduled' のひな形だけが持つ）",
      '-- これより前には実行しない（予定・休止・再試行の待ち）',
      '-- タスク専用の会話（実行の記録が積み上がる）',
    ],
    reason: '過去の移し替えの SQL の中のコメント（履歴なので書き換えない）',
  },
  'web/src/weekdays.ts': { strings: ['月', '火', '水', '木', '金', '土', '日'], reason: 'API に送る曜日の値（src/tasks/schedule.ts の DAY_MAP と対）' },
  'src/tools/builtin/table-core.ts': { strings: ['\u{FF1D}', '\u{FF0B}', '\u{FF0D}', '\u{FF20}'], reason: 'FORMULA_LEADS: 全角の ＝ ＋ － ＠ で始まるセルも式として無害化する（CSV の式の注入。安全）' },
  'src/engine/chat.ts': { strings: ['\u{3000}'], reason: 'toFullWidth: 子の答えの中の区切りを全角にして、区切りの偽装を防ぐ（空白は全角の空白に。安全）' },
  'src/engine/persona.ts': { strings: ['基本情報', '名前', '話し方', '名前', '呼び方', '^-[ \\t]*(?:${labels})[ \\t]*[:\u{FF1A}][ \\t]*'], reason: '見出しと行の名前の読む側: 持ち主の日本語の SOUL.md / USER.md の節と行（区切りの全角のコロンも）を読んで探す' },
  'src/engine/prompts.ts': { strings: ['/(?:^|\\n)[ \\t]*(?:(?:#{1,6}|[-*+])[ \\t]+)?[*_\u{300C}\u{300E}"\u{201C}\'`]*(?:次の一手|Next steps?)[*_\u{300D}\u{300F}"\u{201D}\'`]*[ \\t]*(?:[:\u{FF1A}][*_\u{300D}\u{300F}"\u{201D}\'`]*|\\r?\\n)([\\s\\S]+)$/iu'], reason: 'NEXT_STEP: モデルが日本語の見出し「次の一手」（と括弧）で書いたまとめも拾う' },
  'src/memory/review.ts': { strings: ['/^(?:変更なし|No changes?)[\u{3002}.!\u{FF01}]?$/iu'], reason: 'isNoProposal: モデルが日本語で書いた「変更なし」（と句読点）も拾う' },
  'src/memory/store.ts': { strings: ['/[\\s\u{3000}]+/u'], reason: 'searchTerms: 記憶の検索の語を全角の空白でも区切る' },
  'src/tasks/schedule.ts': { strings: ['月'], reason: 'DAY_MAP の曜日の値（API の値。cronToFields の既定。画面の weekdays.ts と対）' },
  'src/uploads/store.ts': { strings: ['\u{FF1C}', '\u{FF1E}', '<<<添付ファイル', '<<<添付ファイルここまで>>>'], reason: 'neutralizeMarkers の全角の ＜ ＞（添付の名前と中身の <<< >>> を全角にして枠の印の偽装を防ぐ。安全）と、LEGACY_ATTACHMENT_FRAMES: 前からある発言の日本語の添付の枠を外す（安全: 外さないと添付の中身が利用者の依頼として自動承認の判定役に渡る）' },
};

// 一時の一覧（段階 0 の途中の PR だけ）: まだ英語にしていないファイル → 残りの数（上の例外の文字列を除いた数。このファイルは次の PR で直す）。0-2a-3・0-2a-4・0-2b で減らし、0-2b で空にする。
const PENDING: Record<string, number> = {
  'src/app.ts': 9,
  'src/config/store.ts': 47,
  'src/db/conversations.ts': 2,
  'src/db/database.ts': 1,
  'src/engine/chat.ts': 3,
  'src/engine/health.ts': 2,
  'src/env-file.ts': 10,
  'src/main.ts': 20,
  'src/mcp/manager.ts': 2,
  'src/notify/channels.ts': 2,
  'src/notify/notifications.ts': 1,
  'src/providers/anthropic.ts': 2,
  'src/shared/url.ts': 5,
  'src/tasks/worker.ts': 6,
  'src/tools/builtin/browser.ts': 8,
  'src/tools/builtin/calc.ts': 2,
  'src/tools/builtin/checklist.ts': 1,
  'src/tools/builtin/curiosity.ts': 3,
  'src/tools/builtin/docs.ts': 2,
  'src/tools/builtin/download.ts': 2,
  'src/tools/builtin/file-search.ts': 2,
  'src/tools/builtin/files.ts': 6,
  'src/tools/builtin/image.ts': 2,
  'src/tools/builtin/memory.ts': 10,
  'src/tools/builtin/notify.ts': 1,
  'src/tools/builtin/shell.ts': 8,
  'src/tools/builtin/skills.ts': 4,
  'src/tools/builtin/table-core.ts': 3,
  'src/tools/builtin/tables.ts': 2,
  'src/tools/builtin/tasks.ts': 9,
  'src/tools/builtin/web.ts': 3,
  'src/tools/registry.ts': 2,
  'src/tools/shell/git-env.ts': 1,
  'src/tools/skills/store.ts': 1,
  'src/uploads/store.ts': 1,
  'src/web/auth.ts': 3,
  'src/web/routes-browser.ts': 1,
  'src/web/routes-mcp.ts': 1,
  'src/web/routes-notify.ts': 1,
  'src/web/server-host.ts': 8,
  'src/web/server.ts': 1,
  'src/web/static.ts': 1,
};

const japaneseLines = (text: string) => text.split(/\r?\n/u).filter(line => JAPANESE.test(line)).map(line => line.replace(/^[ \t]+|[ \t]+$/gu, ''));

type Hit = { line: number; text: string };

function japaneseStrings(name: string, code: string): Hit[] {
  const source = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true, name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Hit[] = [];
  const add = (node: ts.Node, text: string, literal = text) => { if (JAPANESE.test(literal)) out.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text }); };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node) || ts.isRegularExpressionLiteral(node)) { add(node, node.text); return; }
    if (ts.isTemplateExpression(node)) {
      const spans = node.templateSpans;
      add(node, node.head.text + spans.map(span => `\${${span.expression.getText(source)}}${span.literal.text}`).join(''), node.head.text + spans.map(span => span.literal.text).join(''));
      for (const span of spans) visit(span.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function walk(dir: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, pattern)); else if (pattern.test(entry.name)) out.push(path);
  }
  return out;
}

test('英語だけの見張り: typescript を読める（構文木で文字列だけを拾うため）', () => {
  assert.equal(typeof ts.createSourceFile, 'function');
  assert.equal(ts.isStringLiteral(ts.factory.createStringLiteral('x')), true);
});

test('英語だけの見張り: 文字列・テンプレート・正規表現・JSX の文字は拾い、コメントは拾わない', () => {
  const texts = (name: string, code: string) => japaneseStrings(name, code).map(hit => hit.text);
  assert.deepEqual(texts('a.ts', "// 日本語のコメント\n/* 説明 */\nconst a = 'ok';"), []);
  assert.deepEqual(texts('a.ts', "const a = '名前';"), ['名前']);
  assert.deepEqual(texts('a.ts', 'const a = `値 ${x} です`;'), ['値 ${x} です']);
  assert.deepEqual(texts('a.ts', 'const a = `x ${f(\'中\')} y`;'), ['中']);
  assert.deepEqual(texts('a.ts', 'const a = /[\u{3000}]/u;'), ['/[\u{3000}]/u']);
  assert.deepEqual(texts('a.ts', "const a = '\\u3000';"), ['\u{3000}']);
  assert.deepEqual(texts('a.tsx', 'const a = <p title="題">こんにちは</p>;'), ['題', 'こんにちは']);
});

test('英語だけの見張り: src と web/src の日本語の文字列は、決めた例外と一時の一覧のものだけ', () => {
  const files = [...walk(join(ROOT, 'src'), /\.ts$/u), ...walk(join(ROOT, 'web', 'src'), /\.tsx?$/u)];
  assert.ok(files.length > 200, `${files.length} ファイルしか読めていない`);
  const found = new Map<string, Hit[]>();
  for (const file of files) {
    const hits = japaneseStrings(file, readFileSync(file, 'utf8'));
    if (hits.length) found.set(relative(ROOT, file).replaceAll('\\', '/'), hits);
  }
  const show = (file: string, hits: Hit[]) => hits.map(hit => `  ${file}:${hit.line}: ${hit.text.slice(0, 100)}`).join('\n');
  const problems: string[] = [];
  for (const [file, hits] of found) {
    const left = [...(EXCEPTIONS[file]?.strings ?? [])];
    const rest: Hit[] = [];
    for (const hit of hits) {
      const trial = [...left];
      const ok = japaneseLines(hit.text).every(line => { const at = trial.indexOf(line); if (at < 0) return false; trial.splice(at, 1); return true; });
      if (ok) left.splice(0, left.length, ...trial); else rest.push(hit);
    }
    if (left.length) problems.push(`${file}: 許した文字列が見つからない（消えたら一覧から外す）: ${JSON.stringify(left)}`);
    const pending = PENDING[file];
    if (pending === undefined) {
      if (rest.length) problems.push(`${file}: 日本語の文字列\n${show(file, rest)}`);
    } else if (rest.length !== pending) {
      problems.push(`${file}: 一時の一覧は ${pending}、例外のほかに見つかったのは ${rest.length}（減ったら一覧の数も減らす）\n${show(file, rest)}`);
    }
  }
  for (const file of [...Object.keys(EXCEPTIONS), ...Object.keys(PENDING)]) if (!found.has(file)) problems.push(`${file}: もう日本語が無い（一覧から外す）`);
  assert.deepEqual(problems, []);
});

test('英語だけの見張り: templates/ の初期ファイル（モデルが読むルールと SOUL / USER / CURIOSITY）に日本語が無い', () => {
  const dir = join(ROOT, 'templates');
  const entries = readdirSync(dir, { withFileTypes: true });
  assert.deepEqual(entries.map(entry => entry.name).sort(), ['CURIOSITY.md', 'SOUL.md', 'USER.md', 'rules.md'], '英語の 4 つだけ（言語ごとのフォルダは無い）');
  for (const entry of entries) {
    const hits = readFileSync(join(dir, entry.name), 'utf8').split(/\r?\n/u).map((line, i) => ({ line: i + 1, text: line })).filter(hit => JAPANESE.test(hit.text));
    assert.deepEqual(hits, [], `templates/${entry.name}`);
  }
});
