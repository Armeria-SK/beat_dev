import type { Message } from '../api.ts';

export interface AskOption { label: string; description: string }
export interface AskQuestion { question: string; header: string; options: AskOption[]; multiSelect: boolean }
export interface OpenAsk { key: string; questions: AskQuestion[] }
export interface AskPick { labels: string[]; other: boolean; text: string }

const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const visible = (value: string): string => value.replace(/[\t\n\r\p{Zl}\p{Zp}]/gu, ' ').replace(HIDDEN, '');
const text = (value: unknown): string | null => (typeof value === 'string' && visible(value).trim() ? visible(value) : null);

export function parseAsk(input: string): AskQuestion[] | null {
  let value: unknown;
  try { value = JSON.parse(input); } catch { return null; }
  const list = value && typeof value === 'object' ? (value as { questions?: unknown }).questions : undefined;
  if (!Array.isArray(list) || list.length === 0) return null;
  const questions: AskQuestion[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') return null;
    const q = item as Record<string, unknown>;
    const question = text(q['question']);
    const header = text(q['header']);
    if (!question || !header || !Array.isArray(q['options']) || q['options'].length < 2) return null;
    const options: AskOption[] = [];
    for (const raw of q['options'] as unknown[]) {
      const label = raw && typeof raw === 'object' ? text((raw as Record<string, unknown>)['label']) : null;
      if (!label) return null;
      const description = (raw as Record<string, unknown>)['description'];
      options.push({ label, description: typeof description === 'string' ? visible(description) : '' });
    }
    questions.push({ question, header, options, multiSelect: q['multiSelect'] === true });
  }
  return questions;
}

const callInput = (messages: readonly Message[], before: number, callId: string | undefined): string | null => {
  if (!callId) return null;
  for (let i = before - 1; i >= 0; i--) {
    const found = messages[i]!.toolCalls?.find(c => c.id === callId);
    if (found) return found.input;
  }
  return null;
};

export function openAsk(messages: readonly Message[]): OpenAsk | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && !m.note) return null;
    if (m.role !== 'tool' || m.toolName !== 'ask_owner' || m.isError) continue;
    const input = callInput(messages, i, m.toolCallId);
    const questions = input === null ? null : parseAsk(input);
    if (questions) return { key: String(m.id), questions };
  }
  return null;
}

export const emptyPick = (): AskPick => ({ labels: [], other: false, text: '' });

export function choose(question: AskQuestion, pick: AskPick, label: string | null): AskPick {
  if (!question.multiSelect) return label === null ? { ...pick, labels: [], other: true } : { ...pick, labels: [label], other: false };
  if (label === null) return { ...pick, other: !pick.other };
  return { ...pick, labels: pick.labels.includes(label) ? pick.labels.filter(l => l !== label) : question.options.map(o => o.label).filter(l => l === label || pick.labels.includes(l)) };
}

const answered = (pick: AskPick | undefined): boolean => Boolean(pick && (pick.labels.length > 0 || pick.other) && (!pick.other || pick.text.trim()));

export const complete = (questions: readonly AskQuestion[], picks: readonly AskPick[]): boolean => questions.every((_, i) => answered(picks[i]));

export interface AskStep { index: number; total: number; first: boolean; last: boolean; canNext: boolean; canSend: boolean }

export function askStep(questions: readonly AskQuestion[], picks: readonly AskPick[], step: number): AskStep {
  const total = questions.length;
  const index = Math.min(Math.max(0, step), Math.max(0, total - 1));
  const last = index >= total - 1;
  return { index, total, first: index === 0, last, canNext: !last && answered(picks[index]), canSend: last && complete(questions, picks) };
}

export function answerText(questions: readonly AskQuestion[], picks: readonly AskPick[], lead: string): string {
  const lines = questions.map((q, i) => {
    const pick = picks[i] ?? emptyPick();
    const parts = [...pick.labels, ...(pick.other ? [pick.text.trim().replace(/\s*\n\s*/gu, ' ')] : [])];
    return `- ${q.header}: ${parts.join(', ')}`;
  });
  return [lead, ...lines].join('\n');
}
