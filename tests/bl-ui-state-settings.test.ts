import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig, parseConfig } from '../src/config/store.ts';
import { applyEdits, diffConfig } from '../web/src/settings/merge.ts';
import type { Config } from '../web/src/settings/model.ts';
import { hookCommandLabel, mergeRawConfig } from '../web/src/ui/settings/commit.ts';

// backlog 354・355（設定画面）: 設定ファイルの直接編集で同じ id を書いたとき、Hooks の行の名前。

const base = (): Config => {
  const config = structuredClone(defaultConfig()) as unknown as Config;
  config.models = [
    { id: 'big', provider: 'anthropic', model: 'claude-big', vision: false },
    { id: 'small', provider: 'anthropic', model: 'claude-small', vision: false },
  ];
  return config;
};
const modelsOf = (config: Config): Array<Record<string, unknown>> => config.models as Array<Record<string, unknown>>;
const refused = (config: Config): boolean => { try { parseConfig(structuredClone(config)); return false; } catch { return true; } };

test('354 設定ファイルの直接編集: 既にある id をもう 1 つ書いたら、黙って 1 つにせず、2 つとも保存の形に残す（サーバーが「ID は重複」と断る）', () => {
  const loaded = base();
  const edited = structuredClone(loaded);
  modelsOf(edited).push({ id: 'big', provider: 'anthropic', model: 'claude-other', vision: false });
  const merged = mergeRawConfig(loaded, edited, loaded);
  assert.deepEqual(merged.conflicts, [], '最新が変わっていなければ衝突ではない');
  assert.equal(modelsOf(merged.config).filter(m => m.id === 'big').length, 2, '重複を 1 つに畳まない');
  assert.equal(modelsOf(merged.config).find(m => m.id === 'big')!.model, 'claude-big', '先にあった項目の中身を、あとの項目で書き換えない');
  assert.equal(refused(merged.config), true, '本物の検査（parseConfig）が断る形のまま送る');
});

test('354 設定ファイルの直接編集: 同じ内容の複製や、新しい id を 2 回書いた場合も畳まず、衝突とも言わない（「ほかで変わった」と偽らない）', () => {
  const loaded = base();
  const copy = structuredClone(loaded);
  modelsOf(copy).push({ ...modelsOf(copy)[0]! });
  const same = mergeRawConfig(loaded, copy, loaded);
  assert.equal(modelsOf(same.config).length, 3, '同じ内容の複製も 1 つに畳まない');
  assert.equal(refused(same.config), true);

  const twice = structuredClone(loaded);
  modelsOf(twice).push({ id: 'fresh', provider: 'anthropic', model: 'a', vision: false }, { id: 'fresh', provider: 'anthropic', model: 'b', vision: false });
  const fresh = mergeRawConfig(loaded, twice, loaded);
  assert.deepEqual(fresh.conflicts, [], '新しい id を 2 回書いても、ほかで変わったという衝突の文にしない');
  assert.equal(modelsOf(fresh.config).filter(m => m.id === 'fresh').length, 2);
  assert.equal(refused(fresh.config), true);
});

test('354 設定ファイルの直接編集: 重複を書いている間に、ほかの場所がその一覧を変えていたら、本当に衝突として返し、何も書かない', () => {
  const loaded = base();
  const edited = structuredClone(loaded);
  modelsOf(edited).push({ id: 'big', provider: 'anthropic', model: 'claude-other', vision: false });
  const latest = structuredClone(loaded);
  modelsOf(latest).push({ id: 'added-elsewhere', provider: 'anthropic', model: 'z', vision: false });
  const merged = mergeRawConfig(loaded, edited, latest);
  assert.deepEqual(merged.conflicts, ['models']);
  assert.equal(merged.config, latest, '衝突のときは最新のまま（何も書かない）');
});

test('354 重複のない普通の編集は今までどおり、項目ごとに最新へ当てる（重複の扱いが、ほかの編集を巻き込まない）', () => {
  const loaded = base();
  const edited = structuredClone(loaded);
  modelsOf(edited)[1]!.model = 'claude-small-2';
  const latest = structuredClone(loaded);
  modelsOf(latest).push({ id: 'added-elsewhere', provider: 'anthropic', model: 'z', vision: false });
  const merged = mergeRawConfig(loaded, edited, latest);
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(modelsOf(merged.config).map(m => [m.id, m.model]), [['big', 'claude-big'], ['small', 'claude-small-2'], ['added-elsewhere', 'z']]);
  const direct = applyEdits(latest, diffConfig(loaded, edited));
  assert.deepEqual(direct.conflicts, []);
});

test('355 Hooks の行の名前: 空白を含む引数は引用符で囲み、「node "my file.js"」と「node my file.js」を見分けられるようにする', () => {
  assert.notEqual(hookCommandLabel(['node', 'my file.js']), hookCommandLabel(['node', 'my', 'file.js']));
  assert.equal(hookCommandLabel(['node', 'my file.js']), 'node "my file.js"');
  assert.equal(hookCommandLabel(['node', 'my', 'file.js']), 'node my file.js');
  assert.equal(hookCommandLabel(['node', 'scripts/check.js', '--fast']), 'node scripts/check.js --fast', '空白の無い引数はそのまま');
});

test('355 Hooks の行の名前: 空の引数と、引用符・タブ・改行を含む引数も見える形にする（区切りを隠さない）', () => {
  assert.equal(hookCommandLabel(['run', '']), 'run ""');
  assert.equal(hookCommandLabel(['run', 'a"b']), 'run "a\\"b"');
  assert.equal(hookCommandLabel(['run', 'a\tb']), 'run "a\tb"');
  assert.notEqual(hookCommandLabel(['run', 'a b', 'c']), hookCommandLabel(['run', 'a', 'b c']));
  assert.equal(hookCommandLabel(['C:\\Program Files\\x.exe']), '"C:\\Program Files\\x.exe"', '円記号は二重にしない');
  assert.equal(hookCommandLabel([]), '');
});
