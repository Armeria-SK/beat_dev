import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PERMISSION_MODES } from '../src/shared/permission-mode.ts';
import { en } from '../web/src/i18n/en.ts';
import { MODE_HINT, MODE_LABEL } from '../web/src/ui/composer-state.ts';

// 入力欄の権限モード（Normal / Plan。値は auto / plan）の名前と、ボタンの title に出す説明の文

const CJK = /[　-ヿ㐀-䶿一-鿿＀-￯]/u;

test('権限モードの画面の文: 2 つのモードそれぞれの名前と説明が英語の辞書にあり、日本語が混ざらない。auto の名前は Design の Normal', () => {
  assert.deepEqual(PERMISSION_MODES.map(mode => en[MODE_LABEL[mode]]), ['Normal', 'Plan']);
  for (const mode of PERMISSION_MODES) {
    for (const key of [MODE_LABEL[mode], MODE_HINT[mode]] as const) {
      assert.ok(key in en, key);
      assert.doesNotMatch(en[key] as string, CJK, key);
    }
  }
  const composer = readFileSync(new URL('../web/src/ui/Composer.tsx', import.meta.url), 'utf8');
  assert.match(composer, /className="bt-seg__opt" title=\{t\(MODE_HINT\[value\]\)\}/u, '説明は、入力欄のモードのボタンの title に出す');
});

test('計画の説明は、Web の読み取りが外へ文字を出しうることを隠さない', () => {
  assert.match(en['mode.planDesc'], /reading the web/u);
  assert.match(en['mode.planDesc'], /text in a URL can leave this PC/u);
  assert.match(en['mode.planDesc'], /URL/u);
});

test('Normal の説明は短い 1 行で、判定役が見ること・送る・消す・判定役が通せないものは Pending で聞くことを書き、前の承認の言い回しを残さない', () => {
  const desc = en['mode.autoDesc'];
  assert.doesNotMatch(desc, /\n/u);
  assert.ok(desc.length <= 140, `${desc.length} 文字`);
  assert.match(desc, /judge/u);
  assert.match(desc, /sending out/u);
  assert.match(desc, /deleting/u);
  assert.match(desc, /Pending/u);
  assert.doesNotMatch(desc, /Allow in this chat|approval|asked of you every time/u);
});

test('README の自動承認の説明は、いま効く範囲を書く', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const line = readme.split(/\r?\n/u).find(l => l.startsWith('- **自動承認**'));
  assert.ok(line, 'README に自動承認の説明がある');
  assert.doesNotMatch(line, /サービスの操作|リモートの設定|開くと理由/u);
  assert.match(line, /tools\.outsideRoots/u);
  assert.match(line, /よそから来た文を読んだあとの確かめ/u);
  assert.match(line, /何と答えても必ずあなたに聞く/u);
  assert.match(line, /この会話では許可/u);
  assert.doesNotMatch(line, /一度でも Web・添付|判断のモデルを使わず、毎回あなたに確かめる/u, 'よそから来た文を読んだ会話は判断のモデルを使わない、という古い決まりを書かない');
  assert.match(line, /自動承認の残る危険/u);
  assert.match(line, /`Clear-Content`（「このファイルを空にする」と名指しするので消す扱い。`>` や `sed -i` で空にする書き方は上書き）/u, 'Clear-Content は消す、リダイレクトや sed で空にするのは上書き、と書く');
  assert.match(line, /`web_fetch` `web_search`/u, '残る危険: Web の読み取りは読んだあとも確かめなしで動き、URL で少し外へ出せる');
  assert.match(line, /`package\.json`/u, '残る危険: 判断のモデルがだまされると、あとで動くファイルも書き換えられる');
});

test('README と画面の文に、分かりにくい言い回し「外から読んだ」「外を読んだ扱い」「外から来た」「外の内容を読んだ」が残っていない（「よそから来た文を読んだ」と言う）', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.doesNotMatch(readme, /外から読んだ|外を読んだ扱い|外から来た|外の内容を読んだ/u);
  for (const [name, table] of [['en', en]] as const) {
    for (const [key, value] of Object.entries(table)) {
      if (typeof value !== 'string') continue;
      assert.doesNotMatch(value, /外から読んだ|外を読んだ扱い|外から来た|外の内容を読んだ|outside content/iu, `${name} ${key}`);
    }
  }
});
