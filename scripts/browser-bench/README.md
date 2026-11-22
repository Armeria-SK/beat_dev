# ブラウザの確かめの物差し（browser-rethink P0）

beat が自分で起動した Web アプリをブラウザで確かめるときの、往復の数・トークン・キャッシュ・承認を、直す前と後で同じ形で測るための台本。計画は `plans/beat/steps/browser-rethink/PLAN.md`（P0・Verification の「物差し」）、数字は `plans/beat/steps/browser-rethink/bench.md`。

## 中身
- `app.mjs` — 追加部品なしの小さな Node の Web アプリ（材料の依頼）。`node app.mjs` で `http://localhost:3456`（`PORT` で替えられる）。
  - `/` 入力の流れ: 5 画面（現場 → 材料 → 数量 → 日付 → 確認）。1 画面 1 問で「つぎへ」で進み、URL は変わらない。数量は 0 から始まり `+1` `+10`、日付は「今日」「明日」のボタン。「送る」で「送りました（受付番号 N）」。
  - `/list` 一覧: 行ごとに同じ名前の「詳しく」ボタン。最初から 3 件ある。
  - `/admin` 事務の画面: 暗証番号の欄（`type=password`）でログイン → 行ごとの「発注済みにする」・「ログアウト」。
  - **暗証番号（試しの値）: `2468`**。`app.mjs` の頭と起動の出力にも書いてある。
  - 受け入れ 6 項目の操作が実際に起きたかを、アプリ自身が `.bench/events.jsonl`（`app.mjs` の隣）に 1 行ずつ書く: `submit`（1 件送った）・`list_view`（一覧の画面が、送った行を含めて読み込まれた）・`plus10`・`date_button`・`admin_login`（`ok` つき）・`mark_ordered`・`logout`。
- `run.ts` — 1 回流す。使い捨てのデータと製品を作り、beat を起動し、決まった頼みを送り、終わったら数を集めて beat を止める。
- `collect.ts` — 物差しの会話 1 つの数を DB（読むだけ）とアプリの記録から集める。`run.ts` が呼ぶ。単独でも `node scripts/browser-bench/collect.ts --db <beat.db> --conversation <id> --events <events.jsonl>`。

## 決まった頼み（変えない）
<!-- prompt -->
```text
`node app.mjs` を裏で起動し、受け入れ 6 項目（入力の流れで 1 件送る・一覧に出る・数量の +10・日付のボタン・管理画面で 1 件を発注済みにする・ログアウト）をブラウザで確かめ、項目ごとに通った / 通らないを返して
```
<!-- /prompt -->

## 流し方
1. 枝の作業フォルダ（`tmp/worktrees/<枝>`）で、Anthropic の鍵の入った `.env` を用意する（持ち主が `/env-copy on` のときだけ `node "<root>/.claude/scripts/env-copy.mjs" copy Clive <作業フォルダ>`）。
2. 作業フォルダから 1 回ずつ流す（各 3 回。名前は回ごとに新しく）:
   ```
   node scripts/browser-bench/run.ts --base <workspace>/tmp/browser-rethink --name p0-1
   ```
   `<base>/<name>/` に `data/`（使い捨ての beat のデータ）・`product/`（`app.mjs` を写した git フォルダ）・`beat.log`・`pending.json`・`result.json` ができる。同じ名前のフォルダがあれば流さない。
3. `result.json` の数を `bench.md` に写し、(f) は `finalAnswer`（モデルの項目ごとの答え）と `app`（アプリの記録）を見比べて決める。写したら `<base>/<name>/` を消す。

## 固定する設定（`run.ts` が毎回書く）
- beat の版: その時点の枝（直す前は main）。ポート 4787（4777・4797 は使わない）。毎回新しいデータのフォルダ。
- モデル: `claude-sonnet-5-5`（Anthropic）。effort は書かない（設定の既定）。会話・裏・判定役とも同じモデル。`vision: true`。
- 権限: auto（送るときに `permissionMode: 'auto'` を渡す。渡さないと、計画書の無い製品の会話は計画モードになり、何も動かさずに Build を待つ）。フック・道具の方針は無し。
- ブラウザ: 有効・見せない窓（headless）・`sites` は空・上限は既定。
- 数を乱さないように、物差しの会話の外の自動の実行を止める: `worker.curiosityPerDay: 0`・`memory.review: false`・`scout.cloudRunsPerHour: 0`（製品のフォルダに `app.mjs` があるので、作る前の調べものも自動では始まらない）。
- 流す人は承認待ちの札・質問票に答えない。実行が持ち主の答え待ちで止まったら、そこで終わり。実行が終わって 15 秒動きがなければ終わりと見る。上限 45 分。

## 数えるもの（`result.json`）
物差しの会話の実行だけを数える（`scripts/token-report.ts` の集計を会話で絞ったもの）。
- (a) `a_roundTrips`: モデルの往復（`model_calls` の turn + discarded）
- (b) `b_browserCalls`: ブラウザの道具の呼び出し数（`browser_act` は 1 回、step の数は `b_actSteps`）。並びは `browserSequence`
- (c) `c_input`: 入力の合計（新規 + 読み + 書き）
- (d) `d_cacheWrite`: キャッシュの書き込み
- (e) `e_toolsMisses`: 外れのうち理由が `tools` の数。`e_preloadLoads`: ブラウザ・`pending_withdraw`・`deviation_add`・`image_view` を `tool_search` で読み込んだ回数（`e_otherLoads` はほかの道具の読み込み）
- (f) 確かめられた項目の数 / 6: モデルがブラウザで確かめ、その答え（通った / 通らない）が `app`（アプリの記録）と合う項目だけ。手で決める
- (g) `g_pending`: 持ち主に回った承認（`pending_actions`）の数
- 別の列: `judge`（判定役）・`compactVolume`（要約）
