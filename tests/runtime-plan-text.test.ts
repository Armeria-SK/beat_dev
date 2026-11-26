import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { planBlocksOf } from '../src/engine/runtime-plan-blocks.ts';
import { PLAN_BUTTON, runtimeRequirementsText } from '../src/engine/workspace.ts';
import type { AppPaths } from '../src/paths.ts';
import { tempDir } from './helpers.ts';

// AR-9b: 計画の道具を MCP で渡せない実行役（Codex）の返事から塊を取り出す読み方と、実行役向けの計画モードの指示の組み立て

const PLAN = '# Plan\n\n- step one\n- step two';
const ITEMS = { items: [{ result: 'It works', source: 'ai_added', check: 'look' }] };

test('返事の中の計画の塊は、言語の印があってもなくても取り出し、前後の改行だけを外す。塊が無い文は何も取り出さない', () => {
  assert.deepEqual(planBlocksOf('Here is my thinking.\nNo blocks at all.'), []);
  assert.deepEqual(planBlocksOf(`Done.\n<beat-plan language="ja">\n${PLAN}\n</beat-plan>\nBye`), [{ tool: 'plan_write', input: { content: PLAN, language: 'ja' } }]);
  assert.deepEqual(planBlocksOf(`<beat-plan>\n${PLAN}\n</beat-plan>`), [{ tool: 'plan_write', input: { content: PLAN } }]);
  assert.deepEqual(planBlocksOf(`<beat-plan language="zh-Hant">${PLAN}</beat-plan>`), [{ tool: 'plan_write', input: { content: PLAN, language: 'zh-Hant' } }]);
});

test('同じ塊が複数あれば、いちばん後ろのもの（言い直したもの）を使う。計画・受け入れ・変更の順に、あるものだけを返す', () => {
  const text = `<beat-plan language="en">\n# old\n</beat-plan>\n<beat-plan language="en">\n${PLAN}\n</beat-plan>\n<beat-acceptance>{"items":[]}</beat-acceptance>\n<beat-acceptance>${JSON.stringify(ITEMS)}</beat-acceptance>\n<beat-acceptance-change>${JSON.stringify({ changes: [{ op: 'remove', id: 'A-1' }] })}</beat-acceptance-change>`;
  assert.deepEqual(planBlocksOf(text), [
    { tool: 'plan_write', input: { content: PLAN, language: 'en' } },
    { tool: 'acceptance_write', input: ITEMS },
    { tool: 'acceptance_change', input: { changes: [{ op: 'remove', id: 'A-1' }] } },
  ]);
  assert.deepEqual(planBlocksOf(`<beat-acceptance-change>${JSON.stringify({ changes: [] })}</beat-acceptance-change>`).map(block => block.tool), ['acceptance_change']);
});

test('JSON の塊は ``` の囲いを外して読む。読めない・オブジェクトでない・空の計画は、書かずに理由つきの結果にする', () => {
  assert.deepEqual(planBlocksOf(`<beat-acceptance>\n\`\`\`json\n${JSON.stringify(ITEMS)}\n\`\`\`\n</beat-acceptance>`), [{ tool: 'acceptance_write', input: ITEMS }]);
  const broken = planBlocksOf('<beat-acceptance>{items: nope</beat-acceptance><beat-acceptance-change>[1, 2]</beat-acceptance-change><beat-plan>\n  \n</beat-plan>');
  assert.deepEqual(broken.map(block => [block.tool, 'error' in block]), [['plan_write', true], ['acceptance_write', true], ['acceptance_change', true]]);
  assert.match((broken[2] as { error: string }).error, /not a JSON object/u);
  assert.match((broken[0] as { error: string }).error, /plan is empty/u);
});

test('言語の印に余計な文字が混ざった開きの印は塊として読まない（印の中へ別の欄を差し込めない）', () => {
  assert.deepEqual(planBlocksOf('<beat-plan language="ja" onload="x">\n# p\n</beat-plan>'), []);
  assert.deepEqual(planBlocksOf('<beat-plan language="ja\\"><x>">\n# p\n</beat-plan>'), []);
  assert.deepEqual(planBlocksOf('<beat-plan language="not a tag!">\n# p\n</beat-plan>'), []);
});

function templates(t: Parameters<typeof tempDir>[0]) {
  const root = tempDir(t);
  const git = join(root, 'git-product');
  const plain = join(root, 'plain-product');
  mkdirSync(join(git, '.git'), { recursive: true });
  mkdirSync(plain, { recursive: true });
  return { git, plain, paths: { templates: join(process.cwd(), 'templates') } as AppPaths };
}

test('実行役向けの計画モードの指示: Claude Code 向けは MCP の道具の名前、Codex 向けは塊の書き方だけを含み、印の行・ボタンの置き換え前の文字は残らない', t => {
  const { git, plain, paths } = templates(t);
  const tools = runtimeRequirementsText(paths, git, 'tools');
  const text = runtimeRequirementsText(paths, git, 'text');
  assert.match(tools, /mcp__beat__plan_write/u);
  assert.doesNotMatch(tools, /<beat-plan|<beat-acceptance/u);
  assert.match(text, /<beat-plan language="en">/u);
  assert.match(text, /<beat-acceptance-change>/u);
  assert.doesNotMatch(text, /mcp__beat__/u);
  for (const body of [tools, text]) {
    assert.doesNotMatch(body, /<!--|\{build_button\}|ask_owner/u, 'no marker, no unreplaced name, no tool the runtime does not have');
    assert.match(body, /^# Plan mode/u);
    assert.match(body, new RegExp(`"${PLAN_BUTTON.git}"`, 'u'));
    assert.doesNotMatch(body, /\r/u);
  }
  assert.match(runtimeRequirementsText(paths, plain, 'tools'), new RegExp(`"${PLAN_BUTTON.other}"`, 'u'), 'a folder without git has the other button name');
});

test('持ち主向けの文書の言語が決まっていれば先頭の 1 行で言う。決まっていない・テンプレートが無いときは足さない・空にする', t => {
  const { git, paths } = templates(t);
  const said = runtimeRequirementsText(paths, git, 'tools', 'ja');
  assert.match(said, /^Owner-facing documents of this product \(plan, acceptance items, deviation notes\) are written in ja\.\n\n# Plan mode/u);
  for (const none of [undefined, null, '']) assert.match(runtimeRequirementsText(paths, git, 'tools', none), /^# Plan mode/u);
  assert.equal(runtimeRequirementsText({ templates: join(tempDir(t), 'nothing-here') } as AppPaths, git, 'tools', 'ja'), '');
});
