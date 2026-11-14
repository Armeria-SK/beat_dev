import assert from 'node:assert/strict';
import { test } from 'node:test';
import { en } from '../web/src/i18n/en.ts';
import { copyText } from '../web/src/clipboard.ts';
import {
  addModel, addProvider, addTag, addToRoute, closeAction, countChanges, isEnvName, isSection, keyUsage, moveInRoute, newAnthropicProvider, parseNumber, parseProblem, problemsOf, providerInUse, pruned,
  keyEnvPatch, keyEnvProblem, kindPatch, sharedKeyWith,
  removeFromRoute, removeModel, removeProvider, renameModel, renameProvider, SECTION_GROUPS, SECTION_IDS, sectionChanged, sectionSlice, secondsOf, uniqueId,
  updateAt, updateIn, updateListItem, type Config,
} from '../web/src/settings/model.ts';
import { editsToKeep, restoreKept } from '../web/src/settings/keep.ts';
import { applyEdits, diffConfig } from '../web/src/settings/merge.ts';
import { differs, errorFor } from '../web/src/settings/types.ts';

function sample(): Config {
  return {
    language: undefined,
    timezone: 'Asia/Tokyo',
    server: { port: 4780, origins: ['http://a.ts.net'], tailscaleLogins: [] },
    providers: [
      { id: 'local', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1234/v1', apiKeyEnv: 'LOCAL_KEY', maxParallel: 1, timeoutMs: 600000 },
      { id: 'claude', kind: 'anthropic', maxParallel: 2, timeoutMs: 120000 },
    ],
    models: [
      { id: 'big', provider: 'local', model: 'qwen', contextLength: 32768, minContext: 8192, maxOutputTokens: 4096, vision: false },
      { id: 'sonnet', provider: 'claude', model: 'claude-sonnet', minContext: 8192, maxOutputTokens: 4096, vision: true },
    ],
    routing: { chat: ['big', 'sonnet'], background: ['big'], retriesPerModel: 1 },
    tools: { deny: ['.env'], shell: { enabled: true, allow: ['git status'] } },
    worker: { enabled: false, autonomy: false },
    memory: { userMaxChars: 1500, notesMaxChars: 2500 },
    profile: { name: 'beat', shape: 'orb', color: '#C9A227', motion: 'auto' },
  };
}

test('設定の節: 13 つ・4 グループで、名前と説明が en にある', () => {
  assert.equal(SECTION_GROUPS.length, 4);
  assert.deepEqual([...SECTION_IDS], ['models', 'providers', 'keys', 'tools', 'notify', 'mcp', 'browser', 'worker', 'memory', 'about', 'look', 'server', 'file']);
  assert.equal(new Set(SECTION_IDS).size, SECTION_IDS.length);
  for (const group of SECTION_GROUPS) {
    for (const key of [group.label, ...group.items.flatMap(i => [i.label, i.desc])]) {
      assert.ok(en[key].length > 0, key);
    }
  }
  assert.equal(isSection('tools'), true);
  assert.equal(isSection('nope'), false);
  assert.equal(isSection(null), false);
});

test('辞書: 設定の画面の文字は en にある', () => {
  const keys = Object.keys(en).filter(k => /^(settings|probe)\./u.test(k));
  assert.ok(keys.length >= 50, `${keys.length} 件しか読めていない`);
  assert.equal(Object.keys(en).includes('settings.language.hint'), false, '仮の注意書きは外した');
});

test('変更の数: 何も変えていなければ 0、項目ごとに 1 件', () => {
  const saved = sample();
  assert.equal(countChanges(saved, structuredClone(saved)), 0);
  const one = structuredClone(saved);
  one.memory.userMaxChars = 2000;
  assert.equal(countChanges(saved, one), 1);
  const two = structuredClone(one);
  two.profile.color = '#112233';
  assert.equal(countChanges(saved, two), 2);
});

test('変更の数: 並び（文字列の一覧）は 1 件、models / providers は id で突き合わせる', () => {
  const saved = sample();
  const reordered = structuredClone(saved);
  reordered.routing.chat = ['sonnet', 'big'];
  assert.equal(countChanges(saved, reordered), 1, '順番を替えただけなら 1 件');

  const edited = structuredClone(saved);
  edited.models[0].contextLength = 65536;
  edited.models[0].vision = true;
  assert.equal(countChanges(saved, edited), 2);

  const added = addModel(saved).config;
  assert.equal(countChanges(saved, added), 1, '追加は 1 件');
  assert.equal(countChanges(saved, removeModel(saved, 'sonnet')), 2, '削除は 1 件 + 順番から外れた分（チャットの順番）で 1 件');

  const swapped = structuredClone(saved);
  swapped.models.reverse();
  assert.equal(countChanges(saved, swapped), 0, 'models の並びは id で見るので、並べ替えだけは変更に数えない');
});

test('language は画面では触らない: サーバーの設定に language があっても無くても「見た目」の節の変更にならない', () => {
  const saved = sample();
  const draft = { ...saved, language: 'en' };
  assert.equal(sectionChanged(saved, draft, 'look'), false);
  assert.equal(sectionChanged(saved, draft, 'models'), false);
});

test('節の変更の印: 触った節だけに付く', () => {
  const saved = sample();
  const draft = updateAt(saved, 'worker', { enabled: true });
  const marks = SECTION_IDS.filter(id => sectionChanged(saved, draft, id));
  assert.deepEqual(marks, ['worker']);
  const route = moveInRoute(saved, 'chat', 0, 1);
  assert.deepEqual(SECTION_IDS.filter(id => sectionChanged(saved, route, id)), ['models']);
  const key = updateListItem(saved, 'providers', 'local', { apiKeyEnv: 'OTHER' });
  assert.deepEqual(SECTION_IDS.filter(id => sectionChanged(saved, key, id)), ['providers'], '鍵の節は設定に持ち物を持たないので、変更の印は付かない');
});

test('問題の読み取り: 形の検査の /models/0/contextLength は、位置を id に置き換えて節と行を指す', () => {
  const config = sample();
  const problem = parseProblem('/models/0/contextLength: Expected number to be greater or equal to 1024', config);
  assert.equal(problem.path, 'models.big.contextLength');
  assert.equal(problem.section, 'models');
  assert.equal(problem.modelId, 'big');
  assert.equal(problem.message, 'Expected number to be greater or equal to 1024');
  const provider = parseProblem('/providers/1/timeoutMs: Expected integer', config);
  assert.equal(provider.path, 'providers.claude.timeoutMs');
  assert.equal(provider.section, 'providers');
  assert.equal(provider.providerId, 'claude');
});

test('問題の読み取り: 内容の検査（models.<id>: …・routing.chat: …）と、読めないもの', () => {
  const config = sample();
  assert.deepEqual(
    { ...parseProblem('models.big: contextLength is below minContext: it can never be used', config) },
    { text: 'models.big: contextLength is below minContext: it can never be used', path: 'models.big', message: 'contextLength is below minContext: it can never be used', section: 'models', modelId: 'big' },
  );
  const route = parseProblem('routing.chat: model "ghost" is not defined', config);
  assert.equal(route.section, 'models');
  assert.equal(route.modelId, undefined);
  const url = parseProblem('providers.local.baseUrl: must be http(s)', config);
  assert.equal(url.section, 'providers');
  assert.equal(url.providerId, 'local');
  assert.equal(parseProblem('server.origins: no trailing slash', config).section, 'server');
  assert.equal(parseProblem('/profile/color: Expected string to match pattern', config).section, 'look');
  assert.equal(parseProblem('/tools/shell/timeoutSec: Expected number', config).path, 'tools.shell.timeoutSec');
  assert.equal(parseProblem('/worker/maxRunsPerHour: x', config).section, 'worker');
  assert.equal(parseProblem('/memory/userMaxChars: x', config).section, 'memory');
  assert.equal(parseProblem('/language: Expected union value', config).section, null, '画面に language の欄は無いので、どの節にも結ばない');
  const odd = parseProblem('the file could not be written', config);
  assert.equal(odd.section, null);
  assert.equal(odd.path, '');
  assert.equal(odd.message, 'the file could not be written');
  assert.equal(parseProblem('/models/9/id: x', config).path, 'models.9.id', '範囲外の位置は、そのまま残す');
});

test('設定の書き換え: 元の設定は変えず、空欄（undefined）のキーは外す', () => {
  const config = sample();
  const frozen = structuredClone(config);
  const next = updateListItem(config, 'models', 'big', { contextLength: undefined, label: 'Big' });
  assert.deepEqual(config, frozen);
  assert.equal('contextLength' in next.models[0], false);
  assert.equal(next.models[0].label, 'Big');
  assert.equal(next.models[1], config.models[1], '触っていない項目は同じもの');
  assert.deepEqual(pruned({ a: 1, b: undefined }), { a: 1 });
  assert.deepEqual(updateAt(config, 'worker', { enabled: true }).worker, { enabled: true, autonomy: false });
  assert.deepEqual(updateIn(config, 'tools', 'shell', { enabled: false }).tools.shell, { enabled: false, allow: ['git status'] });
  assert.deepEqual(updateIn({}, 'tools', 'shell', { enabled: true }).tools, { shell: { enabled: true } });
});

test('モデル・プロバイダの追加と削除', () => {
  const config = sample();
  assert.equal(uniqueId('x', []), 'x');
  assert.equal(uniqueId('x', ['x', 'x-2']), 'x-3');
  const first = addModel(config);
  const second = addModel(first.config);
  assert.deepEqual([first.id, second.id], ['new-model', 'new-model-2']);
  assert.equal(first.config.models.at(-1).provider, 'local', '最初のプロバイダを使う');
  const providerFirst = addProvider(config);
  assert.equal(providerFirst.id, 'new-provider');
  assert.equal(addProvider(providerFirst.config).id, 'new-provider-2');

  const without = removeModel(config, 'big');
  assert.deepEqual(without.models.map((m: { id: string }) => m.id), ['sonnet']);
  assert.deepEqual(without.routing, { chat: ['sonnet'], background: [], retriesPerModel: 1 });

  assert.equal(providerInUse(config, 'local'), true);
  assert.equal(providerInUse(providerFirst.config, 'new-provider'), false);
  assert.deepEqual(removeProvider(providerFirst.config, 'new-provider').providers.map((p: { id: string }) => p.id), ['local', 'claude']);
});

test('順番（チャット・裏方）: 入れ替え・足す・外す', () => {
  const config = sample();
  assert.deepEqual(moveInRoute(config, 'chat', 0, 1).routing.chat, ['sonnet', 'big']);
  assert.deepEqual(moveInRoute(config, 'chat', 1, -1).routing.chat, ['sonnet', 'big']);
  assert.equal(moveInRoute(config, 'chat', 0, -1), config, '先頭を上へは何も起きない');
  assert.equal(moveInRoute(config, 'chat', 1, 1), config, '末尾を下へは何も起きない');
  assert.equal(moveInRoute(config, 'chat', 5, -1), config);
  assert.deepEqual(addToRoute(config, 'background', 'sonnet').routing.background, ['big', 'sonnet']);
  assert.equal(addToRoute(config, 'background', 'big'), config, '重複は足さない');
  assert.deepEqual(removeFromRoute(config, 'chat', 'big').routing.chat, ['sonnet']);
  assert.deepEqual(config.routing.chat, ['big', 'sonnet'], '元は変わらない');
});

test('数の欄と、タグの欄', () => {
  assert.equal(parseNumber(''), undefined);
  assert.equal(parseNumber('   '), undefined);
  assert.equal(parseNumber(' 12 '), 12);
  assert.equal(parseNumber('-3.5'), -3.5);
  assert.equal(parseNumber('1e3'), 1000);
  assert.equal(parseNumber('abc'), null);
  assert.equal(parseNumber('Infinity'), null);
  assert.deepEqual(addTag(['a'], ' b '), ['a', 'b']);
  assert.deepEqual(addTag(['a'], 'a'), ['a']);
  assert.deepEqual(addTag(['a'], '   '), ['a']);
  assert.equal(secondsOf(600000), 600);
  assert.equal(secondsOf(1500), 2);
  assert.equal(secondsOf(undefined), undefined);
});

test('API キーの環境変数: プロバイダの apiKeyEnv と、Anthropic の既定、重複のまとめ', () => {
  assert.deepEqual(keyUsage(sample()), [
    { name: 'LOCAL_KEY', providers: ['local'] },
    { name: 'ANTHROPIC_API_KEY', providers: ['claude'] },
  ]);
  const shared = { providers: [
    { id: 'a', kind: 'openai_compatible', apiKeyEnv: 'K' }, { id: 'b', kind: 'openai_compatible', apiKeyEnv: 'K' }, { id: 'c', kind: 'ollama' },
    { id: 'd', kind: 'anthropic', apiKeyEnv: 'MINE' },
  ] };
  assert.deepEqual(keyUsage(shared), [{ name: 'K', providers: ['a', 'b'] }, { name: 'MINE', providers: ['d'] }]);
  assert.equal(isEnvName('OPENAI_API_KEY'), true);
  for (const bad of ['', 'lower', '1ABC', 'A-B', 'A B', 'A'.repeat(65)]) assert.equal(isEnvName(bad), false, bad);
});

test('ID の付け替え: 順番とモデルのプロバイダも合わせる', () => {
  const config = sample();
  const model = renameModel(config, 'big', 'large');
  assert.deepEqual(model.models.map((m: { id: string }) => m.id), ['large', 'sonnet']);
  assert.deepEqual(model.routing.chat, ['large', 'sonnet']);
  assert.deepEqual(model.routing.background, ['large']);
  assert.equal(renameModel(config, 'big', ''), config);
  assert.equal(renameModel(config, 'big', 'big'), config);
  const provider = renameProvider(config, 'local', 'lm');
  assert.deepEqual(provider.providers.map((p: { id: string }) => p.id), ['lm', 'claude']);
  assert.equal(provider.models[0].provider, 'lm');
  assert.equal(provider.models[1].provider, 'claude');
  assert.equal(renameProvider(config, 'local', ''), config);
});

test('行の印: 問題の文と、変更の有無', () => {
  const config = sample();
  const problems = [parseProblem('/models/0/contextLength: too small', config)];
  assert.equal(errorFor(problems, 'models.big.contextLength'), 'too small');
  assert.equal(errorFor(problems, 'models.big.label'), undefined);
  const draft = updateListItem(config, 'models', 'big', { contextLength: 100000 });
  assert.equal(differs(config, draft, c => c.models[0].contextLength), true);
  assert.equal(differs(config, draft, c => c.models[0].model), false);
  assert.equal(differs(config, draft, c => c.nothing.here), false, '読めない場所は変更なし');
  assert.equal(differs(config, config, c => undefined), false);
});

test('コピー: clipboard が使えればそれで、使えない・断られたときは選択してコピーに切り替え、できたかどうかを返す', async () => {
  const written: string[] = [];
  const fallback: string[] = [];
  const selectionCopy = (text: string) => { fallback.push(text); return true; };
  assert.equal(await copyText('a', { clipboard: { writeText: async (v: string) => { written.push(v); } }, selectionCopy }), true);
  assert.deepEqual([written, fallback], [['a'], []], 'clipboard が使えれば切り替えない');
  assert.equal(await copyText('b', { clipboard: { writeText: async () => { throw new Error('denied'); } }, selectionCopy }), true);
  assert.deepEqual(fallback, ['b'], '断られたら切り替える');
  assert.equal(await copyText('c', { clipboard: undefined, selectionCopy }), true);
  assert.deepEqual(fallback, ['b', 'c'], 'http の画面など clipboard が無いときも切り替える');
  assert.equal(await copyText('d', { clipboard: undefined, selectionCopy: () => false }), false, 'どちらもできなければ false（コピーしたと言わない）');
  assert.equal(await copyText('e', { clipboard: { writeText: async () => { throw new Error('denied'); } }, selectionCopy: () => false }), false);
});

test('closeAction: 設定のモーダルを閉じるとき、保存していない変更があれば確かめ、保存している最中は待つ', () => {
  assert.equal(closeAction({ dirty: 0, busy: false }), 'close', '変更が無ければそのまま閉じる');
  assert.equal(closeAction({ dirty: 3, busy: false }), 'confirm', '変更があれば、捨てる前に確かめる');
  assert.equal(closeAction({ dirty: 0, busy: true }), 'wait', '保存している最中は閉じない');
  assert.equal(closeAction({ dirty: 2, busy: true }), 'wait');
});


test('editsToKeep: 保存していない編集があるときだけ、残すものを返す', () => {
  const saved = sample();
  const draft = { ...sample(), timezone: 'UTC' };
  assert.equal(editsToKeep(saved, sample()), null, '変更が無ければ残さない');
  assert.equal(editsToKeep(null, draft), null, 'まだ読み込めていないときは残さない');
  assert.equal(editsToKeep(saved, null), null);
  assert.deepEqual(editsToKeep(saved, draft), { saved, draft });
});

test('restoreKept: 残していた編集を最新の設定へ当て直し、ほかの場所が先に変えた別の値は最新のまま見せる', () => {
  const saved = sample();
  const draft = { ...sample(), timezone: 'UTC' };
  const kept = { saved, draft };
  const latest = { ...sample(), worker: { enabled: true, autonomy: false } };
  const restored = restoreKept(kept, latest);
  assert.equal(restored.restored, true);
  assert.equal(restored.draft.timezone, 'UTC', '自分の編集は戻る');
  assert.equal((restored.draft.worker as { enabled: boolean }).enabled, true, 'ほかの場所が変えた値は最新のまま');
  assert.equal(restored.saved, latest, '比べる元は最新の設定');
  assert.equal(countChanges(restored.saved, restored.draft), 1, '保存していない変更は自分の 1 件だけ');
});

test('restoreKept: 同じ値をほかの場所も先に変えていたら編集は残さず、ぶつかるときは残していた画面のまま返して保存の合流に衝突を知らせさせる', () => {
  const saved = sample();
  const kept = { saved, draft: { ...sample(), timezone: 'UTC' } };
  const same = restoreKept(kept, { ...sample(), timezone: 'UTC' });
  assert.equal(same.restored, false, '最新がすでに同じ値なら、残す編集は無い');
  assert.equal(countChanges(same.saved, same.draft), 0);
  const conflicting = restoreKept(kept, { ...sample(), timezone: 'Europe/London' });
  assert.equal(conflicting.restored, true);
  assert.equal(conflicting.saved, saved, '衝突のときは元の比べる元を残す');
  assert.equal(conflicting.draft, kept.draft);
  assert.equal(diffConfig(conflicting.saved, conflicting.draft).length, 1);
  assert.equal(applyEdits({ ...sample(), timezone: 'Europe/London' }, diffConfig(conflicting.saved, conflicting.draft)).conflicts.length, 1, '保存すれば衝突として知らされる');
  const latest = sample();
  const none = restoreKept(null, latest);
  assert.deepEqual({ restored: none.restored, same: none.draft === latest && none.saved === latest }, { restored: false, same: true });
  assert.equal(restoreKept({ saved, draft: sample() }, latest).restored, false, '変更の無い残りは使わない');
});


test('モデルを足したとき、チャットも裏方も空の順番には、今の候補（設定のモデル全部）に新しいモデルを足して入れる', () => {
  const empty = { ...sample(), models: [], routing: { chat: [], background: [], retriesPerModel: 1 } };
  const first = addModel(empty);
  assert.deepEqual(first.config.routing, { chat: ['new-model'], background: ['new-model'], retriesPerModel: 1 }, '最初のモデルは、チャットにも裏方にも入る');
  const second = addModel(first.config);
  assert.deepEqual(second.config.routing.chat, ['new-model'], '順番がもうあれば、2 つ目からは自分で入れる');
  assert.deepEqual(second.config.routing.background, ['new-model']);

  const hollow = { ...sample(), routing: { chat: [], background: [], retriesPerModel: 1 } };
  const added = addModel(hollow);
  assert.deepEqual(added.config.routing.chat, ['big', 'sonnet', 'new-model'], '今まで候補だったモデルを外さない');
  assert.deepEqual(added.config.routing.background, ['big', 'sonnet', 'new-model']);

  const oneEmpty = { ...sample(), routing: { chat: ['big'], background: [], retriesPerModel: 1 } };
  assert.deepEqual(addModel(oneEmpty).config.routing, oneEmpty.routing, '片方でも順番があるときは触らない（裏方が空ならチャットの順番を使う）');
  assert.deepEqual(addModel(sample()).config.routing, sample().routing, '順番があるときは触らない');
});

test('保存の問題: issues があれば文を読み取らずに、そのまま行と節に結ぶ。古い応答・壊れた応答は今までの読み取りに戻る', () => {
  const config = sample();
  const body = {
    problems: ['/nothing/useful: ???'],
    issues: [
      { path: 'models.big.contextLength', message: 'too small' },
      { path: 'providers.local.baseUrl', message: 'bad url' },
      { path: 'routing.chat', message: 'missing' },
      { path: 'tools.shell.allow', message: 'cannot write' },
      { path: 'server.origins', message: 'not an origin' },
      { path: 'weird.place', message: 'unknown root' },
    ],
  };
  const problems = problemsOf(body, 'failed', config);
  assert.deepEqual(problems.map(p => [p.path, p.message, p.section, p.modelId, p.providerId]), [
    ['models.big.contextLength', 'too small', 'models', 'big', undefined],
    ['providers.local.baseUrl', 'bad url', 'providers', undefined, 'local'],
    ['routing.chat', 'missing', 'models', undefined, undefined],
    ['tools.shell.allow', 'cannot write', 'tools', undefined, undefined],
    ['server.origins', 'not an origin', 'server', undefined, undefined],
    ['weird.place', 'unknown root', null, undefined, undefined],
  ], '文（problems）は読まない');
  assert.equal(errorFor(problems, 'models.big.contextLength'), 'too small');
  assert.equal(new Set(problems.map(p => p.text)).size, problems.length, '行の key に使う text が重ならない');

  const dotted = { ...config, models: [{ ...config.models[0], id: 'gpt-4.1' }, ...config.models.slice(1)] };
  const withDot = problemsOf({ issues: [{ path: 'models.gpt-4.1.contextLength', message: 'x' }, { path: 'models.gpt-4.1.id', message: 'dup' }] }, 'failed', dotted);
  assert.deepEqual(withDot.map(p => [p.path, p.modelId]), [['models.gpt-4.1.contextLength', 'gpt-4.1'], ['models.gpt-4.1.id', 'gpt-4.1']], 'ID に点があっても、モデルを取り違えない');

  const old = { problems: ['/models/0/contextLength: too small', 'routing.chat: モデル「x」がありません'] };
  assert.deepEqual(problemsOf(old, 'failed', config), old.problems.map(text => parseProblem(text, config)), '古いサーバーの応答は文を読む');
  for (const broken of [{ problems: ['models.big: 文'], issues: [] }, { problems: ['models.big: 文'], issues: [{ path: 3, message: 'x' }] }, { problems: ['models.big: 文'], issues: 'none' }, { problems: ['models.big: 文'], issues: [null] }]) {
    assert.deepEqual(problemsOf(broken, 'failed', config), [parseProblem('models.big: 文', config)], JSON.stringify(broken.issues));
  }
  assert.deepEqual(problemsOf({ message: 'x' }, 'ただの失敗', config), [parseProblem('ただの失敗', config)], 'どちらも無ければ、渡された文');
  assert.deepEqual(problemsOf(undefined, 'ただの失敗', config), [parseProblem('ただの失敗', config)]);
});

// T-42: ブラウザの節
test('節「ブラウザ」: 「振る舞い」で MCP の次にあり、設定の tools.browser だけを持つ', () => {
  const behavior = SECTION_GROUPS.find(g => g.label === 'settings.group.behavior')!;
  const ids = behavior.items.map(i => i.id);
  assert.equal(ids[ids.indexOf('mcp') + 1], 'browser');
  assert.ok(SECTION_IDS.includes('browser'));
  assert.equal(isSection('browser'), true);
  const saved = sample();
  saved.tools.browser = { enabled: false, sites: [], limits: { maxTabs: 3 } };
  assert.deepEqual(sectionSlice(saved, 'browser'), saved.tools.browser);
  const draft = structuredClone(saved);
  draft.tools.browser.enabled = true;
  assert.deepEqual(SECTION_IDS.filter(id => sectionChanged(saved, draft, id)), ['browser'], 'ブラウザの変更の印は「ブラウザ」だけに付く（「道具」には付かない）');
  const shell = structuredClone(saved);
  shell.tools.deny = ['.env', 'x'];
  assert.deepEqual(SECTION_IDS.filter(id => sectionChanged(saved, shell, id)), ['tools']);
  const problem = parseProblem('/tools/browser/limits/maxTabs: Expected number to be less or equal to 8', saved);
  assert.equal(problem.section, 'browser');
  assert.equal(parseProblem('/tools/deny/0: x', saved).section, 'tools');
});

test('Anthropic を足す: 1 つ目は ANTHROPIC_API_KEY、2 つ目からはほかと重ならない自分の鍵の名前を持つ', () => {
  const none = { ...sample(), providers: [sample().providers[0]] };
  assert.deepEqual(newAnthropicProvider(none), { id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', maxParallel: 2, timeoutMs: 600_000 });

  const one = { ...sample(), providers: [...sample().providers, { id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', maxParallel: 2, timeoutMs: 600_000 }] };
  const second = newAnthropicProvider(one);
  assert.equal(second.id, 'anthropic-2');
  assert.equal(second.apiKeyEnv, 'BEAT_ANTHROPIC_2_API_KEY');
  assert.ok(isEnvName(second.apiKeyEnv as string));
  const next = { ...one, providers: [...one.providers, second] };
  assert.deepEqual(sharedKeyWith(next, 'anthropic-2'), []);
  assert.deepEqual(sharedKeyWith(next, 'anthropic'), ['claude']);

  const third = newAnthropicProvider({ ...next, providers: [...next.providers, { id: 'x', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'BEAT_ANTHROPIC_3_API_KEY', maxParallel: 1, timeoutMs: 1000 }] });
  assert.equal(third.id, 'anthropic-3');
  assert.equal(third.apiKeyEnv, 'BEAT_ANTHROPIC_3_API_KEY_2');
});

test('種類を Anthropic に変える: 鍵の名前が無く、ANTHROPIC_API_KEY をほかの提供元が使っていれば、自分の鍵の名前を持たせる（鍵を共有しない）', () => {
  const base = { ...sample(), providers: [
    { id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', maxParallel: 2, timeoutMs: 600_000 },
    { id: 'local', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:8000/v1', maxParallel: 1, timeoutMs: 600_000 },
    { id: 'named', kind: 'openai_compatible', baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'EXAMPLE_API_KEY', maxParallel: 1, timeoutMs: 600_000 },
  ] };
  assert.deepEqual(kindPatch(base, 'local', 'anthropic'), { kind: 'anthropic', apiKeyEnv: 'BEAT_LOCAL_API_KEY' });
  const changed = updateListItem(base, 'providers', 'local', kindPatch(base, 'local', 'anthropic'));
  assert.deepEqual(sharedKeyWith(changed, 'local'), []);
  assert.deepEqual(sharedKeyWith(changed, 'anthropic'), []);

  assert.deepEqual(kindPatch(base, 'named', 'anthropic'), { kind: 'anthropic' }, '書いてある鍵の名前はそのまま');
  assert.deepEqual(kindPatch(base, 'anthropic', 'openai_compatible'), { kind: 'openai_compatible' });
  assert.deepEqual(kindPatch(base, 'anthropic', 'anthropic'), { kind: 'anthropic' }, '1 つ目の Anthropic は ANTHROPIC_API_KEY のまま');

  const implicit = { ...base, providers: [{ id: 'claude', kind: 'anthropic', maxParallel: 2, timeoutMs: 600_000 }, base.providers[1]!] };
  assert.deepEqual(kindPatch(implicit, 'local', 'anthropic'), { kind: 'anthropic', apiKeyEnv: 'BEAT_LOCAL_API_KEY' }, '書いていない Anthropic の既定の名前とも重ねない');

  const alone = { ...base, providers: [base.providers[1]!] };
  assert.deepEqual(kindPatch(alone, 'local', 'anthropic'), { kind: 'anthropic' }, 'ほかに使う提供元が無ければ ANTHROPIC_API_KEY でよい');
});

test('Key variable の欄: 環境変数の名前だけを設定に入れる。鍵を貼ったものは断り、空は外す', () => {
  assert.deepEqual(keyEnvPatch('MY_API_KEY'), { apiKeyEnv: 'MY_API_KEY' });
  assert.deepEqual(keyEnvPatch(''), { apiKeyEnv: undefined });
  assert.equal(keyEnvPatch('sk-ant-test-0000000000000000'), null);
  assert.equal(keyEnvPatch('my_api_key'), null);
});

test('Key variable の欄: 大文字と数字だけの鍵らしい文字列は、名前の形に合っていても設定に入れない（鍵を持つ名前だけ通す）', () => {
  assert.equal(keyEnvPatch('ABCD1234EFGH5678IJKL9012MNOP3456'), null);
  assert.equal(keyEnvProblem('ABCD1234EFGH5678IJKL9012MNOP3456'), 'unsafe');
  assert.equal(keyEnvPatch('PATH'), null);
  assert.equal(keyEnvProblem('sk-ant-test-0000000000000000'), 'pattern');
  assert.equal(keyEnvProblem('MY_API_KEY'), null);
  assert.equal(keyEnvProblem('OPENROUTER_TOKEN'), null);
  assert.equal(keyEnvProblem(''), null);
  assert.match(en['ui.set.provider.envUnsafe'] as string, /KEY, TOKEN, SECRET, PASSWORD or CREDENTIAL/u);
});
