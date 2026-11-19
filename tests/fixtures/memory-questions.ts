// beat 10-4b の問い（scripts/memory-probe.ts）。試しの製品「bento」の作り物の記憶と、それを使う問い。持ち主の記憶の中身は使わない。
// 名前は題から作られる（src/memory/files.ts の slug）ので、name は題に合わせる。印（marker）は記憶の本文にしか無い言葉。答えか道具の入力に印が出れば「本文を使った」と数える

export type MemoryQuestionKind = 'direct' | 'indirect' | 'control' | 'write';

export interface MemoryQuestion {
  id: string;
  kind: MemoryQuestionKind;
  text: string;
  note?: string;
  marker?: RegExp;
}

export const PROBE_PRODUCT = 'bento';

export const PROBE_NOTES: ReadonlyArray<{ name: string; title: string; content: string }> = [
  { name: 'test-commands', title: 'Test commands', content: 'Run `npm run verify:bento`, not `npm test`. It starts the fake kitchen server first. Checked by running it on 2026-11-02.' },
  { name: 'release-steps', title: 'Release steps', content: 'Tag the release as `bento-r<N>` (N counts up from 1), deploy to staging, then to production.' },
  { name: 'ui-pull-requests', title: 'UI pull requests', content: 'Every pull request that changes a screen includes a screenshot at 390px width. The owner asked for this.' },
  { name: 'kitchen-api-limit', title: 'Kitchen API limit', content: 'The kitchen API accepts at most 17 requests per minute. Send orders in groups of 5.' },
  { name: 'branch-names', title: 'Branch names', content: 'Name branches `kitchen/<topic>`, for example `kitchen/fix-total`.' },
  { name: 'db-backup', title: 'DB backup', content: 'Before writing a migration, copy `orders.db` to `orders.db.bak-<date>`.' },
  { name: 'staging-host', title: 'Staging host', content: 'Staging runs on port 8457 on the office server.' },
];

export const MEMORY_QUESTIONS: readonly MemoryQuestion[] = [
  { id: 'D1', kind: 'direct', text: 'この製品のテストは、どのコマンドで流す？', note: 'test-commands', marker: /verify:bento/u },
  { id: 'D2', kind: 'direct', text: 'この製品のリリースのタグは、どんな形で付ける？', note: 'release-steps', marker: /bento-r/u },
  { id: 'D3', kind: 'direct', text: 'キッチンの API は 1 分に何回まで呼べる？', note: 'kitchen-api-limit', marker: /17/u },
  { id: 'D4', kind: 'direct', text: 'この製品のブランチの名前の付け方を教えて。', note: 'branch-names', marker: /kitchen\//u },
  { id: 'D5', kind: 'direct', text: 'この製品のステージングは何番のポートで動いている？', note: 'staging-host', marker: /8457/u },
  { id: 'I1', kind: 'indirect', text: '注文の合計の計算を直したとする。直ったことを確かめる手順を、コマンドも入れて教えて。', note: 'test-commands', marker: /verify:bento/u },
  { id: 'I2', kind: 'indirect', text: '注文の表に列を足す移し替えを書きたい。書き始める前にやっておくことはある？', note: 'db-backup', marker: /\.bak-/u },
  { id: 'I3', kind: 'indirect', text: 'メニューの画面の見た目を変えた。プルリクエストに何を付ければいい？', note: 'ui-pull-requests', marker: /390/u },
  { id: 'I4', kind: 'indirect', text: 'クーポンの不具合を直す作業を始める。ブランチの名前の案を 1 つ出して。', note: 'branch-names', marker: /kitchen\//u },
  { id: 'I5', kind: 'indirect', text: 'キッチンに 40 件の注文をまとめて送るコードを書く。気をつけることは？', note: 'kitchen-api-limit', marker: /17|groups of 5|5 件/u },
  { id: 'C1', kind: 'control', text: 'JavaScript の Array.prototype.map は何を返す？ 一言で。' },
  { id: 'C2', kind: 'control', text: 'HTTP の 404 はどういう意味？ 一言で。' },
  { id: 'C3', kind: 'control', text: '「おはよう」を英語にして。' },
  { id: 'C4', kind: 'control', text: '2 の 10 乗はいくつ？' },
  { id: 'W1', kind: 'write', text: 'この製品では、画像は必ず WebP で保存する決まりにする。覚えておいて。' },
  { id: 'W2', kind: 'write', text: 'この製品では、ログの時刻はいつも UTC で書く。覚えておいて。' },
  { id: 'W3', kind: 'write', text: 'この製品の問い合わせには 2 営業日以内に返事をする決まり。覚えておいて。' },
];

// 合格の線（PLAN.md 10-4b、持ち主の Q-M10-4）
export const PASS_LINES = { direct: 4, indirect: 3, write: 2 } as const;
