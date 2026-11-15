import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChecklistItem, NotificationItem, PendingStatus, Task, ToolGate } from './api.ts';

export type RunEvent =
  | { type: 'run.start'; runId: string; conversationId: string; modelId: string }
  | { type: 'model.switch'; runId: string; conversationId: string; from: string; to: string; reason: string }
  | { type: 'text.delta'; runId: string; conversationId: string; text: string }
  | { type: 'warning'; runId: string; conversationId: string; code: string; message: string; params?: Record<string, unknown> }
  | { type: 'message.saved'; runId: string; conversationId: string; messageId: number; role: string }
  | { type: 'tool.call'; runId: string; conversationId: string; callId: string; name: string; input: string }
  | { type: 'tool.result'; runId: string; conversationId: string; callId: string; name: string; ok: boolean; decision: string; preview: string; gate?: ToolGate }
  | { type: 'tool.auto'; runId: string; conversationId: string; callId: string; name: string; state: 'checking' | 'allowed' | 'asked'; reason?: string }
  | { type: 'memory.changed'; runId: string; conversationId: string; memoryId: number; book: 'user' | 'notes'; action: 'create' | 'update' | 'forget'; content: string; eventId: number }
  | { type: 'checklist.updated'; runId: string; conversationId: string; items: ChecklistItem[]; tainted: boolean }
  | { type: 'compaction'; runId: string; conversationId: string; summarized: number }
  | { type: 'run.end'; runId: string; conversationId: string; ok: boolean; errorKind?: string; errorMessage?: string; errorCode?: string; errorParams?: Record<string, string | number>; detail?: { reason: string; hint?: string; measured?: number; required?: number } }
  | { type: 'agent.state'; runId: string; conversationId: string; callId: string; childRunId: string; childConversationId: string; state: 'running' | 'done' | 'failed' | 'cancelled' | 'timeout'; toolCalls: number }
  | { type: 'pending.changed'; conversationId: string }
  | { type: 'pendingAction.changed'; id: number; status: PendingStatus; projectId: string | null; conversationId: string; taskId: string | null }
  | { type: 'question.changed'; id: number; projectId: string | null; status: 'open' | 'answered' }
  | { type: 'conversation.changed'; conversationId: string; change: 'renamed' | 'archived' | 'unarchived' | 'deleted'; projectId?: string | null }
  | { type: 'project.changed'; projectId: string; change: 'created' | 'updated' | 'archived' | 'restored' }
  | { type: 'plan.changed'; projectId: string; conversationId: string; hash: string; by: 'ai' | 'owner' }
  | { type: 'acceptance.changed'; projectId: string; version: number; draft: boolean }
  | { type: 'task.changed'; task: Task }
  | { type: 'task.deleted'; id: string }
  | { type: 'notification'; notification: NotificationItem }
  | { type: 'notification.read'; ids: number[]; unread: number };

// 任せた子の担当の動き（agent_run を実行しているあいだだけ）。子の会話へのリンクと、使った道具の数
export interface AgentLive { conversationId: string; toolCalls: number }
export interface Draft { runId: string; conversationId: string; modelId: string; text: string; activeTool?: string | undefined; activeInput?: string | undefined; autoChecking?: boolean | undefined; agent?: AgentLive | undefined }

export function useRunEvents(onEvent: (e: RunEvent) => void, onResync: (drafts: Draft[]) => void): { connected: boolean; reconnect: () => void } {
  const [connected, setConnected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const handlers = useRef({ onEvent, onResync });
  handlers.current = { onEvent, onResync };
  useEffect(() => {
    let boot: string | undefined;
    const source = new EventSource('/api/events');
    source.addEventListener('hello', e => {
      const data = JSON.parse((e as MessageEvent).data) as { bootId: string; drafts: Draft[] };
      setConnected(true);
      if (boot !== data.bootId) { boot = data.bootId; handlers.current.onResync(data.drafts); }
    });
    source.addEventListener('resync', () => handlers.current.onResync([]));
    source.addEventListener('run', e => {
      try { handlers.current.onEvent(JSON.parse((e as MessageEvent).data) as RunEvent); } catch { }
    });
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [attempt]);
  const reconnect = useCallback(() => { setConnected(false); setAttempt(n => n + 1); }, []);
  return { connected, reconnect };
}
