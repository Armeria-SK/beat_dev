// 会話のモデルに毎回伝える tail の節 `build`（beat self-fix S1）: この会話の計画から作った Build の様子。
// 書くのは、決まった英語の文と id・数字だけ。タスクの題・本文・待ちの文・裏の命令文は 1 字も入れない（外から来た文を tail に持ち込まないため）。
// ほかを import しない純粋な関数。build-in-chat-2 の PR2 が入ったら、この節は PR2 の buildGuide に置き換え、このファイルごと消す。

export interface BuildLine {
  id: string;
  status: 'ready' | 'running' | 'waiting';
  // この会話の実行が止めたタスクか（止めた直後は、ワーカーが実行待ちに戻すまで running のこともある）
  pausedNow: boolean;
  // 開いている承認待ちの番号（waiting のとき）
  pending: readonly number[];
}

const HEADING = "Build of this conversation's plan:";
const FOOTER = "The Build carries out this plan. Do not run the plan's steps yourself here (no file changes or commands for them). To pass extra instructions to the Build, use task_update with a note; the Build reads it from its next round.";

function stateOf(build: BuildLine): string {
  if (build.status === 'waiting') return build.pending.length ? `waiting for the owner's approval: ${build.pending.map(id => `#${id}`).join(', ')}` : "waiting for the owner's answer";
  if (build.pausedNow) return 'paused for this reply; queued again 2 minutes after the pause';
  return build.status === 'running' ? 'running' : 'queued';
}

// 開いている Build（呼ぶ側が新しい順に絞ったもの）の節。無ければ空文字（節を送らない）
export function buildSection(builds: readonly BuildLine[]): string {
  if (!builds.length) return '';
  return [HEADING, ...builds.map(build => `- [${build.id.slice(0, 8)}] ${stateOf(build)}`), FOOTER].join('\n');
}
