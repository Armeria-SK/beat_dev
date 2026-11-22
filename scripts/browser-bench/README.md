# ブラウザの確かめの物差し（browser-rethink P0）

beat が自分で起動した Web アプリをブラウザで確かめるときの、往復の数・トークン・キャッシュ・承認を、直す前と後で同じ形で測るための台本。計画は `plans/beat/steps/browser-rethink/PLAN.md`（P0・Verification の「物差し」）、数字は `plans/beat/steps/browser-rethink/bench.md`。

## 中身
- `app.mjs` — 物差しのアプリ（材料の依頼）。追加部品なしの小さな Node の Web アプリ。`node app.mjs` で `http://localhost:3456`（`PORT` で替えられる）。**画面と流れは変えない**（変えると前後の数が比べられない。段ごとの実機の確かめに要る画面は `live.mjs` に足す）。
  - `/` 入力の流れ: 5 画面（現場 → 材料 → 数量 → 日付 → 確認）。1 画面 1 問で「つぎへ」で進み、URL は変わらない。数量は 0 から始まり `+1` `+10`、日付は「今日」「明日」のボタン。「送る」で「送りました（受付番号 N）」。
  - `/list` 一覧: 行ごとに同じ名前の「詳しく」ボタン。最初から 3 件ある。
  - `/admin` 事務の画面: 暗証番号の欄（`type=password`）でログイン → 行ごとの「発注済みにする」・「ログアウト」。
  - **暗証番号（試しの値）: `2468`**。`app.mjs` の頭と起動の出力にも書いてある。
  - 受け入れ 6 項目の操作が実際に起きたかを、アプリ自身が `.bench/events.jsonl`（`app.mjs` の隣）に 1 行ずつ書く: `submit`（1 件送った）・`list_view`（一覧の画面が、送った行を含めて読み込まれた）・`plus10`・`date_button`・`admin_login`（`ok` つき）・`mark_ordered`・`logout`。各行に、頼みがどこから来たか（`src`: ブラウザが付ける `sec-fetch-mode`・`sec-fetch-site` があり、user-agent が `Mozilla/` で始まれば `browser`、ほかは `other`。`ua`・`fetchMode`・`fetchSite` も残す）。
- `live.mjs` — 段ごとの実機の確かめ用の別のアプリ（`node live.mjs` で `http://localhost:3457`）。物差しの数には使わない。`/rows`（同じ名前の「削除」が行ごとに並ぶ一覧。「並べ替え」「つぎのページ」も同じ URL のまま。P3a）・`/many`（触れるものが 350 個。P4）・`/select`（`<select>`。P6）。
- `run.ts` — 1 回流す。使い捨てのデータと製品を作り、beat を起動し、決まった頼みを送り、終わったら数を集めて beat を止める。
- `collect.ts` — 物差しの会話 1 つの数を DB（読むだけ）とアプリの記録から集める。`run.ts` が呼ぶ。単独でも `node scripts/browser-bench/collect.ts --db <beat.db> --conversation <id> --events <events.jsonl>`。

## 決まった頼み（変えない）
<!-- prompt -->
```text
`node app.mjs` を裏で起動し、受け入れ 6 項目（入力の流れで 1 件送る・一覧に出る・数量の +10・日付のボタン・管理画面で 1 件を発注済みにする・ログアウト）をブラウザで確かめ、項目ごとに通った / 通らないを返して
```
<!-- /prompt -->
`result.json` の `promptSha256` がこの文の SHA-256（前後の空白を除いたもの）。回ごとに同じであること。

## 流し方
1. 枝の作業フォルダ（`tmp/worktrees/<枝>`）で、Anthropic の鍵の入った `.env` を用意する（持ち主が `/env-copy on` のときだけ `node "<root>/.claude/scripts/env-copy.mjs" copy Clive <作業フォルダ>`）。
2. 作業フォルダから 1 回ずつ流す（各 3 回。名前は回ごとに新しく）:
   ```
   node scripts/browser-bench/run.ts --base <workspace>/tmp/browser-rethink --name p0-1
   ```
   `<base>/<name>/` に `data/`（使い捨ての beat のデータ）・`product/`（`app.mjs` を写した git フォルダ）・`beat.log`・`pending.json`・`result.json` ができる。
3. `result.json` の数を `bench.md` に写し、(f) は下の決まりで決める。写したら `<base>/<name>/` を消す。`<base>/.bench-last-call` は**3 回目のあと（その組の終わり）にだけ**消す（途中で消すと、次の回が冷やすための待ちを飛ばす）。

`run.ts` が断る・止めるもの:
- `--base` が作業場所の `tmp/` の下でない（`tmp/worktrees/` の下・リンクで外へ出る所も断る。製品の `data/` には置けない）。
- `--port` が 4777・4797・1024 未満、`--minutes` が 1〜180 の数でない。
- **起動の前に、`--port` か 3456 で何かが待ち受けている**（残っている beat に頼みを送ったり、アプリが 3456 を取れなかったりしないように）。冷やすための待ちのあと、フォルダを作る直前にもう一度確かめる。起動を待つあいだも、自分の beat の記録（`beat.log`）に `beat started: <origin>/` が出るまでは、答えたサーバーを自分の beat と見ない。
- 同じ名前のフォルダがある。
- 終わったあとに `--port` か 3456 がまだ待ち受けている（`beatStopped` / `appStopped` が false）なら、終了コード 1。実行が `finished` でない（時間切れ・失敗）ときも 1。

## 固定する設定（`run.ts` が毎回書く）
- beat の版: その時点の枝（直す前は main）。`result.json` に `beatHead`（HEAD のコミット）と `beatDirty`（作業フォルダに未コミットの変更があるか）。ポート 4787。毎回新しいデータのフォルダ。
- モデル: `claude-sonnet-5-5`（Anthropic）。effort は書かない（設定の既定）。会話・裏・判定役とも同じモデル。`vision: true`。
- 権限: auto（送るときに `permissionMode: 'auto'` を渡す。渡さないと、計画書の無い製品の会話は計画モードになり、何も動かさずに Build を待つ）。フック・道具の方針は無し。
- ブラウザ: 有効・見せない窓（headless）・`sites` は空・上限は既定。
- 数を乱さないように、物差しの会話の外の自動の実行を止める: `worker.curiosityPerDay: 0`・`memory.review: false`・`scout.cloudRunsPerHour: 0`（製品のフォルダに `app.mjs` があるので、作る前の調べものも自動では始まらない）。
- **毎回キャッシュの冷えた状態から始める**: 前の回の最後のモデルの呼び出しの終わり（`<base>/.bench-last-call`）から 6 分たつまで、`run.ts` が待ってから起動する（Anthropic のキャッシュは 5 分で切れる。続けて流すと、前の回が置いた道具と system の頭を次の回が読み、(d) が小さく出る）。`secondsSincePreviousRun` に空いた秒数（その base で最初の回は null。その前の 6 分にほかの物差しを流していないことを流す人が確かめる）。1 回目の呼び出しの読み・書きは `firstCall` に出る（冷えていれば読みは 0 か、beat の外の同じ頭だけ）。
- 流す人は承認待ちの札・質問票に答えない。実行が持ち主の答え待ちで止まったら、そこで終わり。5 秒おきに会話を見て、3 回続けて動いている実行が無ければ終わりと見る（最後の実行の終わりから 10〜15 秒）。上限は既定 45 分。

## 数えるもの（`result.json`）
**本体** = 会話がこの会話そのものの実行。子の担当（`parent_run_id` でたどれる実行）は本体に足さず `children`（実行の数・量・ブラウザの呼び出し）に出す。目標は本体の数で見る。
- (a) `a_roundTrips`: 本体のモデルの往復（`model_calls` の turn + discarded）
- (b) `b_browserCalls`: 本体のブラウザの道具の呼び出し数（`browser_act` は 1 回）。`b_actSteps` は `browser_act` の step の数で、DB の会話の発言の道具の入力（切っていない形）から数える（`tool_calls.input` は見せる用に切ってあるので使わない）。並びは `browserSequence`
- (c) `c_input`: 本体の入力の合計（新規 + 読み + 書き）
- (d) `d_cacheWrite`: 本体のキャッシュの書き込み
- (e) `e_toolsMisses`: 本体の外れのうち理由が `tools` の数。`e_preloadLoads`: ブラウザ・`pending_withdraw`・`deviation_add`・`image_view` を `tool_search` で読み込んだ回数（`e_otherLoads` はほかの道具の読み込み）。`toolSearchCalls`（呼び出しの数）と `toolSearchResults`（読めた結果の数）が合わないとき・`parseErrors` が 0 でないときは、(e) を 0 と書かずに確かめ直す
- (f) 確かめられた項目の数 / 6（手で決める）: 項目ごとに、**アプリの記録にその操作の `src: browser` の行があり、その時刻（`at`）が本体のブラウザの道具の呼び出しの間（`tool_calls.created_at` から `duration_ms` のあと 2 秒まで）に入っている**（`result.json` の `app`。`other` から来た行は `app.notBrowser`、呼び出しの外の行は `app.outsideBrowserCalls` に数が出るだけで、項目にならない。`src` の決まりは `app.mjs` に書いてあって測られるモデルにも読めるので、時刻でも絞る）**かつ、モデルがその項目を「通った」と言った**ものだけ数える。モデルが言うのは、最後の答え（`finalAnswer`）か、実行が質問票（`ask_owner`）で止まったときはそれまでの発言のうち、その項目を名指して確かめた結果を言ったもの（「+10 で 15 になりました」など。どれを使ったかを `bench.md` に書く）。モデルが `.bench/events.jsonl` を読んで言っただけのもの・curl や node の頼みで起きた操作は数えない
- (g) `g_pending`: 持ち主に回った承認（`pending_actions`）の数。質問票は `askOwner` に別に出る
- 別の列: `judge`（本体の判定役）・`compactVolume`（本体の要約）・`children`・`tasks`（この会話から作られたタスク〔Build を含む〕の数と `task_create` の呼び出し。0 でなければ `bench.md` に書く）
