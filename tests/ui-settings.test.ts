import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { defaultConfig } from '../src/config/store.ts';
import type { ModelView } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import { fieldStep, listAccepts, listWithout, parseRawConfig, planKey, planKeyFor, planSave, readNumber, type FieldDraft } from '../web/src/ui/settings/commit.ts';
import { CATEGORIES, matchCategories } from '../web/src/ui/settings/rows.ts';
import { judgeBackups, keyLine, providerReach, rolesOf, setConversation, setFallback, setJudge } from '../web/src/ui/settings/view.ts';

// 新しい画面の Settings（steps/p1-ui.md「Settings」と PR 1-5b）の、画面を持たない決まり。

test('ui/settings rows: 区分はデザインの 10 から Thinking を除き、Persona と Background を足した 11、並びはデザインの順', () => {
  assert.deepEqual(CATEGORIES.map(c => c.id), ['models', 'skills', 'background', 'folders', 'hooks', 'browser', 'mcp', 'server', 'persona', 'appearance', 'advanced']);
  for (const c of CATEGORIES) {
    assert.ok(typeof en[c.label] === 'string', c.label);
    for (const row of c.rows) assert.ok(typeof en[row] === 'string', row);
  }
});

test('ui/settings rows: 検索は区分の名前と行の題で絞り、空なら全部', () => {
  const text = (key: keyof typeof en) => String(en[key]);
  assert.equal(matchCategories('', text).length, CATEGORIES.length);
  assert.deepEqual(matchCategories('reduce', text), ['appearance']);
  assert.deepEqual(matchCategories('SHELL', text), ['skills']);
  assert.ok(matchCategories('fallback', text).includes('models'));
  assert.deepEqual(matchCategories('zzzz', text), []);
});

test('ui/settings commit: D:\\proj を 1 字ずつ打つあいだは保存せず（D:\\ も）、Enter か離れたときに 1 回だけ D:\\proj を保存する', () => {
  let draft: FieldDraft = { saved: '', text: '' };
  const commits: string[] = [];
  for (const prefix of ['D', 'D:', 'D:\\', 'D:\\p', 'D:\\pr', 'D:\\pro', 'D:\\proj']) {
    const step = fieldStep(draft, { type: 'input', text: prefix });
    draft = step.draft;
    if (step.commit !== null) commits.push(step.commit);
  }
  assert.deepEqual(commits, []);
  const composing = fieldStep(draft, { type: 'key', key: 'Enter', composing: true });
  assert.equal(composing.commit, null, '変換を確定する Enter では保存しない');
  const enter = fieldStep(draft, { type: 'key', key: 'Enter', composing: false });
  assert.equal(enter.commit, 'D:\\proj');
  const blur = fieldStep({ ...enter.draft, saved: 'D:\\proj' }, { type: 'blur' });
  assert.equal(blur.commit, null, '保存した値と同じなら、離れても送らない');
  assert.equal(fieldStep({ saved: '', text: '  D:\\x  ' }, { type: 'blur' }).commit, 'D:\\x');
});

test('ui/settings commit: 受けない値（空にした必須の欄・一覧にもうある項目）は保存せず、欄を保存した値に戻す', () => {
  const required = (value: string) => value !== '';
  assert.deepEqual(fieldStep({ saved: 'gpt-4o', text: '   ' }, { type: 'blur' }, required), { draft: { saved: 'gpt-4o', text: 'gpt-4o' }, commit: null });
  assert.deepEqual(fieldStep({ saved: 'gpt-4o', text: '' }, { type: 'key', key: 'Enter', composing: false }, required), { draft: { saved: 'gpt-4o', text: 'gpt-4o' }, commit: null });
  assert.equal(fieldStep({ saved: 'gpt-4o', text: 'gpt-5' }, { type: 'blur' }, required).commit, 'gpt-5');
  const items = ['node', 'a.js'];
  const fresh = (value: string) => !items.includes(value);
  assert.deepEqual(fieldStep({ saved: '', text: 'node ' }, { type: 'blur' }, fresh), { draft: { saved: '', text: '' }, commit: null });
  assert.equal(fieldStep({ saved: '', text: 'b.js' }, { type: 'blur' }, fresh).commit, 'b.js');
});

test('ui/settings commit: コマンドの引数の一覧は同じ語を何度でも足せ、消すのは押した 1 つだけ', () => {
  const argv = ['node', 'guard.js', '--deny', 'rm'];
  assert.equal(listAccepts(argv, '--deny', true), true, '引数は繰り返してよい');
  assert.equal(listAccepts(argv, '--deny'), false, 'ふつうの一覧は同じ項目を受けない');
  assert.equal(listAccepts(argv, 'curl'), true);
  const twice = [...argv, '--deny', 'curl'];
  assert.deepEqual(listWithout(twice, 4), ['node', 'guard.js', '--deny', 'rm', 'curl'], '2 つ目の --deny だけを消す');
});

test('ui/settings commit: Esc は打った文字を保存した値に戻し、何も保存しない。保存した値が変わると欄も替わる', () => {
  const step = fieldStep({ saved: 'a', text: 'abc' }, { type: 'key', key: 'Escape', composing: false });
  assert.deepEqual(step, { draft: { saved: 'a', text: 'a' }, commit: null });
  assert.deepEqual(fieldStep({ saved: 'a', text: 'ab' }, { type: 'saved', value: 'z' }), { draft: { saved: 'z', text: 'z' }, commit: null });
  assert.equal(fieldStep({ saved: 'a', text: 'ab' }, { type: 'key', key: 'x', composing: false }).commit, null);
});

test('ui/settings commit: 数の欄は範囲と整数を確かめ、空は「任意」のときだけ', () => {
  assert.deepEqual(readNumber('4', { min: 1, max: 4 }), { kind: 'value', value: 4 });
  assert.deepEqual(readNumber('5', { min: 1, max: 4 }), { kind: 'bad' });
  assert.deepEqual(readNumber('0', { min: 1 }), { kind: 'bad' });
  assert.deepEqual(readNumber('1.5', {}), { kind: 'bad' });
  assert.deepEqual(readNumber('x', {}), { kind: 'bad' });
  assert.deepEqual(readNumber(' ', {}), { kind: 'bad' });
  assert.deepEqual(readNumber('', { optional: true }), { kind: 'value', value: undefined });
});

test('ui/settings commit: 範囲が広がる変更は access.ts の確かめを通り、確かめた印が今の広がりと同じときだけ保存する', () => {
  const latest = defaultConfig() as Record<string, any>;
  const addRoot = (c: Record<string, any>) => ({ ...c, tools: { ...c.tools, roots: [...c.tools.roots, { path: 'D:\\proj', mode: 'read' }] } });
  const first = planSave(latest, addRoot, null);
  assert.equal(first.kind, 'confirm');
  if (first.kind !== 'confirm') return;
  assert.deepEqual(first.items.map(i => i.kind), ['root-added']);
  const second = planSave(latest, addRoot, first.key);
  assert.equal(second.kind, 'save');
  if (second.kind === 'save') assert.equal(second.config.tools.roots.at(-1).path, 'D:\\proj');
  const wider = (c: Record<string, any>) => ({ ...addRoot(c), tools: { ...addRoot(c).tools, shell: { ...c.tools.shell, allow: ['node'] } } });
  assert.equal(planSave(latest, wider, first.key).kind, 'confirm', '確かめたあとに広がりが増えたら、もう一度確かめる');
  assert.deepEqual(planSave(latest, c => c, null), { kind: 'same' });
  const narrow = planSave(latest, c => ({ ...c, worker: { ...c.worker, maxParallel: 2 } }), null);
  assert.equal(narrow.kind, 'save', '広がらない変更は確かめなしに保存');
});

test('ui/settings commit: スキルを聞かずに登録する（Ask before registering をオフ）は確かめ、オンに戻すのは確かめない', () => {
  const on = defaultConfig() as Record<string, any>;
  const off = planSave(on, c => ({ ...c, skills: { askBeforeRegister: false } }), null);
  assert.equal(off.kind, 'confirm');
  if (off.kind === 'confirm') assert.deepEqual(off.items.map(i => i.kind), ['skills-auto-register']);
  const back = planSave({ ...on, skills: { askBeforeRegister: false } }, c => { const { skills: _s, ...rest } = c; return rest; }, null);
  assert.equal(back.kind, 'save');
});

test('ui/settings commit: 設定ファイルの直接編集も同じ確かめを通る（通知の送り先を足す・許可フォルダを足す）', () => {
  const latest = defaultConfig() as Record<string, any>;
  const raw = parseRawConfig(JSON.stringify({ ...latest, notify: { ...latest.notify, channels: [{ id: 'hook', kind: 'webhook', urlEnv: 'HOOK_URL' }] } }));
  assert.ok(raw);
  const plan = planSave(latest, () => raw!, null);
  assert.equal(plan.kind, 'confirm');
  if (plan.kind === 'confirm') assert.ok(plan.items.some(i => i.kind === 'notify-channel-added'));
  assert.equal(parseRawConfig('[1]'), null);
  assert.equal(parseRawConfig('{'), null);
});

test('ui/settings commit: 鍵をこの PC の外へ送るときだけ確かめる', () => {
  const remote = planKey({ id: 'openai', kind: 'openai_compatible', baseUrl: 'https://api.openai.com/v1' }, null);
  assert.equal(remote.kind, 'confirm');
  if (remote.kind === 'confirm') {
    assert.deepEqual(remote.items, [{ kind: 'provider-key-send', id: 'openai', url: 'https://api.openai.com/v1' }]);
    assert.equal(planKey({ id: 'openai', kind: 'openai_compatible', baseUrl: 'https://api.openai.com/v1' }, remote.key).kind, 'send');
  }
  assert.equal(planKey({ id: 'local', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:8000/v1' }, null).kind, 'send');
  assert.equal(planKey({ id: 'anthropic', kind: 'anthropic' }, null).kind, 'send');
  assert.equal(planKey(undefined, null).kind, 'none');
});

test('ui/settings commit: 鍵を送る確かめは、送る直前に読み直した設定の送り先で数える（画面が持っている古い送り先では数えない）', () => {
  const latest = { providers: [
    { id: 'local', kind: 'openai_compatible', baseUrl: 'https://api.example.com/v1' },
    { id: 'home', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:8000/v1' },
  ] };
  const moved = planKeyFor(latest, 'local', null);
  assert.equal(moved.kind, 'confirm', '画面では 127.0.0.1 に見えていても、今の設定が外なら確かめる');
  if (moved.kind === 'confirm') {
    assert.deepEqual(moved.items, [{ kind: 'provider-key-send', id: 'local', url: 'https://api.example.com/v1' }]);
    assert.equal(planKeyFor(latest, 'local', moved.key).kind, 'send');
    const again = { providers: [{ id: 'local', kind: 'openai_compatible', baseUrl: 'https://other.example.net/v1' }] };
    assert.equal(planKeyFor(again, 'local', moved.key).kind, 'confirm', '確かめのあいだに送り先がまた変わったら、もう一度確かめる');
  }
  assert.equal(planKeyFor(latest, 'home', null).kind, 'send');
  assert.equal(planKeyFor(latest, 'gone', null).kind, 'none', '消えた提供元には送らない');
  assert.equal(planKeyFor({}, 'local', null).kind, 'none');

  const screen = readFileSync(new URL('../web/src/ui/settings/agent.tsx', import.meta.url), 'utf8');
  assert.ok(screen.includes('planKeyFor((await api.settings()).config, id, confirmed)'));
  assert.ok(!screen.includes('planKey(provider'));
});

const probe = (status: string) => ({ modelId: 'm', status, server: '', required: 0, message: '', checkedAt: 1 });
const model = (id: string, provider: string, status: string | null): ModelView =>
  ({ id, label: id, provider, model: id, minContext: 1, maxOutputTokens: 1, inChat: true, probe: status ? probe(status) : null });

test('ui/settings view: 提供元の届き方は Reachable / Offline / Rejected（確かめていなければ出さない）', () => {
  assert.equal(providerReach('p', [model('a', 'p', 'ok'), model('b', 'p', 'unreachable')]), 'ok');
  assert.equal(providerReach('p', [model('a', 'p', 'unreachable')]), 'warn');
  assert.equal(providerReach('p', [model('a', 'p', 'no_api_key'), model('b', 'p', 'unreachable')]), 'danger');
  assert.equal(providerReach('p', [model('a', 'p', 'too_small')]), 'ok');
  assert.equal(providerReach('p', [model('a', 'p', null), model('b', 'q', 'ok')]), null);
});

test('ui/settings view: 鍵の状態の行は、鍵の文字を持たない（入っているか・OS か・無いか）', () => {
  assert.equal(keyLine({ set: true, last4: 'abcd' }, false), 'set');
  assert.equal(keyLine({ set: true, source: 'os' }, false), 'os');
  assert.equal(keyLine({ set: false }, false), 'none');
  assert.equal(keyLine(null, false), 'loading');
  assert.equal(keyLine('failed', false), 'failed');
  assert.equal(keyLine({ set: true }, true), 'unsafe');
});

test('ui/settings view: 役割（会話・予備・裏）は routing の並びのまま読み書きする', () => {
  const config = { routing: { chat: ['a', 'b', 'c'], background: ['b'] } };
  assert.deepEqual(rolesOf(config), { conversation: 'a', judge: '', fallback: ['b', 'c'], background: ['b'] });
  assert.deepEqual(setConversation(config, 'c').routing.chat, ['c', 'a', 'b']);
  assert.deepEqual(setFallback(config, ['c']).routing.chat, ['a', 'c']);
  assert.deepEqual(rolesOf({ routing: { chat: [], background: [] } }), { conversation: null, judge: '', fallback: [], background: [] });
});

test('ui/settings view: 設定ファイルで routing.judge に 2 つ以上書いてあるとき、先頭のあとの判定役も画面に出す（backlog 522）', () => {
  assert.deepEqual(judgeBackups({ routing: { chat: ['a'], background: [], judge: ['b', 'c', 'd'] } }), ['c', 'd']);
  assert.deepEqual(judgeBackups({ routing: { chat: ['a'], background: [], judge: ['b'] } }), []);
  assert.deepEqual(judgeBackups({ routing: { chat: ['a'], background: [] } }), []);
  assert.deepEqual(judgeBackups({}), []);
  assert.equal(en['ui.set.models.judgeBackups']('Local, Cloud'), 'Then, in this order (set in the config file): Local, Cloud');
});

test('ui/settings view: 判定役は routing.judge の先頭。既定（空）は「会話と同じ」で、選び直すと先頭だけが替わり、ファイルで書いた続きの順は残り（前の先頭は残さない）、「会話と同じ」に戻すと項目ごと消える', () => {
  const config = { routing: { chat: ['a', 'b'], background: [], judge: ['b', 'c'] } };
  assert.equal(rolesOf(config).judge, 'b');
  assert.deepEqual(setJudge(config, 'a').routing.judge, ['a', 'c'], '前の判定役を隠れた予備にしない');
  assert.deepEqual(setJudge(config, 'c').routing.judge, ['c'], '選んだものは重ねない');
  assert.deepEqual(setJudge(config, 'b').routing.judge, ['b', 'c']);
  assert.deepEqual(setJudge({ routing: { chat: ['a'], background: [] } }, 'a').routing.judge, ['a']);
  const cloud = setJudge({ routing: { chat: ['local', 'cloud'], background: [] } }, 'cloud');
  assert.deepEqual(setJudge(cloud, 'local').routing.judge, ['local'], '2 回選び直したら、画面に見えている 1 つだけ');
  assert.deepEqual(setJudge(setJudge(config, 'a'), 'b').routing.judge, ['b', 'c']);
  const same = setJudge(config, '');
  assert.equal('judge' in same.routing, false);
  assert.deepEqual(same.routing.chat, ['a', 'b'], 'ほかの役割は変えない');
  assert.equal(rolesOf(same).judge, '');
});

test('ui/settings: 設定を書く口（saveSettings・resetSettings）を呼ぶのは、決まった画面だけ（行ごとの確かめを通る所）', () => {
  const root = new URL('../web/src/', import.meta.url);
  const callers = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map(file => file.replace(/\\/gu, '/'))
    .filter(file => /\.tsx?$/u.test(file))
    .filter(file => /\b(?:saveSettings|resetSettings)\b|\/api\/settings\b/u.test(readFileSync(new URL(file, root), 'utf8')))
    .sort();
  assert.deepEqual(callers, ['api.ts', 'ui/Onboarding.tsx', 'ui/settings/Settings.tsx', 'ui/settings/customize.tsx']);
});
