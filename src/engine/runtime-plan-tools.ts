// 外の実行役の計画モードの会話に渡す、beat 自身の計画の道具（AR-9b）。実行役が呼んだら、beat の道具の登録にある plan_write・acceptance_write・acceptance_change を、API のモデルの計画モードと同じ道（runToolCall）で動かす。
// 計画を書くのは beat 自身の道具なので、秘密の確かめ・長さ・見えない文字・書いた人と「外を読んだ」の印・控え・plan.changed の出来事は、そのまま効く。実行役にファイル・コマンドの許可は足さない。
// 実行役の実行は常に「外から読んだ」扱い（beat には、実行役が何を読んだか見えない）なので、書いた計画・一覧にも外を読んだ印が付く。
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/schema.ts';
import type { Conversations } from '../db/conversations.ts';
import type { AppPaths } from '../paths.ts';
import { rootsLister, runProject } from '../projects/run.ts';
import type { ProjectStore } from '../projects/store.ts';
import type { AcceptanceStore } from '../projects/acceptance.ts';
import type { BeatPlanTools } from '../runtimes/types.ts';
import type { PermissionMode } from '../shared/permission-mode.ts';
import type { ApprovalBroker } from '../tools/approvals.ts';
import type { PendingStore } from '../pending/store.ts';
import { buildPolicy, defaultWorkspace } from '../tools/policy.ts';
import { runToolCall } from '../tools/pipeline.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolContext } from '../tools/types.ts';
import type { RunBus } from './bus.ts';

// 実行役に見せる道具と、呼んでよい道具の名前。見せるのは、受け入れの一覧が固定の前は acceptance_write、固定のあとは acceptance_change の片方だけ。
// 呼べる名前は 3 つとも（Codex の文の塊は、どちらの塊が来ても、パイプラインが「いまの状態に合わない」と断る）
export const PLAN_TOOL_NAMES = ['plan_write', 'acceptance_write', 'acceptance_change'] as const;

export interface RuntimePlanToolsDeps {
  tools: { registry: ToolRegistry; approvals: ApprovalBroker; pending?: PendingStore | undefined };
  config: () => AppConfig;
  paths: AppPaths;
  conversations: Conversations;
  projects?: ProjectStore | undefined;
  acceptance?: AcceptanceStore | undefined;
  bus: RunBus;
  log?: ((line: string) => void) | undefined;
  services: () => ToolContext['services'];
  modeOf: (conversationId: string) => PermissionMode;
}

export interface RuntimePlanToolsInput { runId: string; conversationId: string; projectId: string | null; signal: AbortSignal }

export function runtimePlanTools(deps: RuntimePlanToolsDeps, input: RuntimePlanToolsInput): BeatPlanTools | undefined {
  const project = runProject(deps.projects, input.projectId);
  if (!project?.root) return undefined;
  const root = project.root;
  const config = deps.config();
  const frozen = Boolean(deps.acceptance?.latest(project.id));
  const offered = ['plan_write', frozen ? 'acceptance_change' : 'acceptance_write'].flatMap(name => {
    const tool = deps.tools.registry.get(name);
    return tool ? [{ name, description: tool.describe ? tool.describe(config) : tool.description }] : [];
  });
  if (offered.length === 0) return undefined;
  const names: ReadonlySet<string> = new Set(PLAN_TOOL_NAMES);
  const productRoots = rootsLister(deps.projects);
  const policy = buildPolicy(config, deps.paths, { root }, productRoots());
  const ctx: ToolContext = {
    runId: input.runId, conversationId: input.conversationId, kind: 'chat', signal: input.signal, config, paths: deps.paths, policy, workspace: root,
    home: defaultWorkspace(buildPolicy(config, deps.paths, undefined, productRoots()), deps.paths), project: { id: project.id, root },
    taint: { tainted: true, sources: ['runtime'] },
    conversationTainted: () => deps.conversations.everTainted(input.conversationId),
    log: deps.log ?? (() => undefined),
    services: deps.services(),
    permissionMode: 'plan',
  };
  return {
    specs: offered,
    async call(name, args) {
      if (!names.has(name)) return { text: `beat has no plan tool named ${name.slice(0, 80)}`, isError: true };
      // 実行役の道具の行は橋が出す（tool.call・tool.result）。ここのパイプラインの同じ出来事で画面に行が二重に出ないよう、その 2 つだけ流さない
      const outcome = await runToolCall({ id: `rtplan_${randomUUID()}`, name, arguments: args }, ctx, {
        registry: deps.tools.registry, approvals: deps.tools.approvals, pending: deps.tools.pending, productRoots, db: deps.conversations.db, config: deps.config,
        emit: event => { if (event.type !== 'tool.call' && event.type !== 'tool.result') deps.bus.publish(event); },
        permissionMode: () => deps.modeOf(input.conversationId),
        conversationTainted: () => deps.conversations.everTainted(input.conversationId),
      });
      return { text: outcome.output.content, isError: outcome.output.isError === true || outcome.decision !== 'allow' };
    },
  };
}
