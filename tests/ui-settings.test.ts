import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig } from '../src/config/store.ts';
import type { ModelView } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import { COMMIT_ON, fieldStep, parseRawConfig, planKey, planSave, readNumber, type FieldDraft } from '../web/src/ui/settings/commit.ts';
import { CATEGORIES, FILE_ONLY, LATER_HIDDEN, matchCategories, placeOf } from '../web/src/ui/settings/rows.ts';
import { keyLine, providerReach, rolesOf, setConversation, setFallback, setJudge } from '../web/src/ui/settings/view.ts';

// 新しい画面の Settings（steps/p1-ui.md「Settings」と PR 1-5b）の、画面を持たない決まり。

function leaves(value: unknown, path: string[] = []): string[] {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0) {
    return Object.entries(value).flatMap(([key, inner]) => leaves(inner, [...path, key]));
  }
  return [path.join('.')];
}

test('ui/settings rows: 今の設定の形のどの項目も、区分か「設定ファイルだけ」のどちらかに入る', () => {
  const config = { ...defaultConfig(), skills: { askBeforeRegister: true } };
  const homeless = leaves(config).filter(path => placeOf(path) === null);
  assert.deepEqual(homeless, []);
});

test('ui/settings rows: worker の 4 項目は Background、答え 8 の 5 項目（静かな時間帯は 2 つの鍵）は設定ファイルだけ', () => {
  for (const key of ['enabled', 'maxRunsPerHour', 'maxParallel', 'remindAfterHours']) assert.equal(placeOf(`worker.${key}`), 'background', key);
  assert.deepEqual([...LATER_HIDDEN], ['worker.autonomy', 'worker.idleMinutes', 'worker.quietStart', 'worker.quietEnd', 'worker.selfTasksNeedApproval', 'worker.curiosityPerDay']);
  for (const path of LATER_HIDDEN) assert.equal(placeOf(path), 'file', path);
  assert.equal(placeOf('notify.channels'), 'file', '通知の送り先は画面に出さない（future.md）');
  assert.equal(placeOf('profile.shape'), 'file', '姿の形は答え 4 でなくした');
  assert.equal(placeOf('profile.color'), 'persona');
  assert.equal(placeOf('skills.askBeforeRegister'), 'skills');
  assert.equal(placeOf('tools.shell.allow'), 'skills');
  assert.equal(placeOf('tools.shell.envAllow'), 'file');
  assert.equal(placeOf('tools.browser.limits.maxTabs'), 'browser');
  assert.equal(placeOf('tools.roots'), 'folders');
});

test('ui/settings rows: 区分はデザインの 10 から Thinking を除き、Persona と Background を足した 11、並びはデザインの順', () => {
  assert.deepEqual(CATEGORIES.map(c => c.id), ['models', 'skills', 'background', 'folders', 'hooks', 'browser', 'mcp', 'server', 'persona', 'appearance', 'advanced']);
  for (const c of CATEGORIES) {
    assert.ok(typeof en[c.label] === 'string', c.label);
    for (const row of c.rows) assert.ok(typeof en[row] === 'string', row);
  }
  assert.ok(!FILE_ONLY.some(path => CATEGORIES.some(c => c.paths.includes(path))));
});

test('ui/settings rows: 検索は区分の名前と行の題で絞り、空なら全部', () => {
  const text = (key: keyof typeof en) => String(en[key]);
  assert.equal(matchCategories('', text).length, CATEGORIES.length);
  assert.deepEqual(matchCategories('reduce', text), ['appearance']);
  assert.deepEqual(matchCategories('SHELL', text), ['skills']);
  assert.ok(matchCategories('fallback', text).includes('models'));
  assert.deepEqual(matchCategories('zzzz', text), []);
});

test('ui/settings commit: 文字を打つ欄（パス・コマンド・一覧・URL・数）は離れたときだけ、切り替えと選択は押したときに保存', () => {
  for (const control of ['text', 'path', 'command', 'list', 'url', 'number', 'secret'] as const) assert.equal(COMMIT_ON[control], 'blur', control);
  for (const control of ['switch', 'seg', 'select', 'tile', 'button'] as const) assert.equal(COMMIT_ON[control], 'press', control);
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

test('ui/settings view: 判定役は routing.judge の先頭。既定（空）は「会話と同じ」で、選び直すと先頭に来て、ファイルで書いた続きの順は残り、「会話と同じ」に戻すと項目ごと消える', () => {
  const config = { routing: { chat: ['a', 'b'], background: [], judge: ['b', 'c'] } };
  assert.equal(rolesOf(config).judge, 'b');
  assert.deepEqual(setJudge(config, 'a').routing.judge, ['a', 'b', 'c']);
  assert.deepEqual(setJudge(config, 'c').routing.judge, ['c', 'b'], '選んだものは重ねない');
  assert.deepEqual(setJudge({ routing: { chat: ['a'], background: [] } }, 'a').routing.judge, ['a']);
  const same = setJudge(config, '');
  assert.equal('judge' in same.routing, false);
  assert.deepEqual(same.routing.chat, ['a', 'b'], 'ほかの役割は変えない');
  assert.equal(rolesOf(same).judge, '');
});
