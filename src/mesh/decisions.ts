import { join } from 'node:path';
import { plainLine } from '../shared/plain-text.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { readOwn, replaceFile } from './files.ts';

export const DECISIONS_FILE = 'DECISIONS.md';
export const DECISIONS_OLD_FILE = 'DECISIONS-old.md';
export const DECISIONS_ROWS_MAX = 30;
export const DECISIONS_LINE_MAX = 200;

const HEAD = ['# DECISIONS', '', `Decisions the owner made, oldest first. beat writes a line when the owner answers a question. Older lines move to ${DECISIONS_OLD_FILE}.`, ''];
const OLD_HEAD = ['# DECISIONS (older)', '', `Lines moved out of ${DECISIONS_FILE}, oldest first.`, ''];
const EXTERNAL_MARK = ' [src: external]';
const ELLIPSIS = '…';
const QUESTION_MIN = 12;

export interface OwnerDecision {
  date: string;
  questionId: number;
  question: string;
  answer: string;
  picked: 'option' | 'text';
  kept: boolean;
  item: string | null;
  external: boolean;
}

const chars = (text: string): number => Array.from(text).length;

function clip(text: string, max: number): string {
  if (max <= 0) return '';
  const list = Array.from(text);
  return list.length <= max ? text : `${list.slice(0, Math.max(0, max - 1)).join('')}${ELLIPSIS}`;
}

const one = (text: string): string => plainLine(redactSecrets(text), Infinity);
const aiText = (text: string): string => one(text).replaceAll('"', "'");

export function decisionLine(d: OwnerDecision): string {
  const what = d.kept ? 'kept the assumed answer' : `changed the answer${d.item ? `, reopened ${d.item}` : ''}`;
  const head = `- ${d.date} question #${d.questionId}: ${what}. Owner ${d.picked === 'option' ? 'picked' : 'wrote'}: "`;
  const tail = d.external ? EXTERNAL_MARK : '';
  const answer = d.picked === 'option' ? aiText(d.answer) : one(d.answer);
  const question = aiText(d.question);
  const asked = (q: string) => (q ? `. AI asked: "${q}"` : '');
  const frame = chars(asked('-')) - 1;
  const room = DECISIONS_LINE_MAX - chars(head) - chars(tail) - 1;
  const answerRoom = Math.min(chars(answer), Math.max(1, room - (question ? frame + QUESTION_MIN : 0)));
  const quoted = clip(answer, answerRoom);
  const left = room - chars(quoted) - frame;
  const shownQuestion = question && left >= QUESTION_MIN ? clip(question, left) : '';
  return `${head}${quoted}"${asked(shownQuestion)}${tail}`;
}

export const decisionRows = (content: string): number => content.split(/\r?\n/u).filter(line => line.startsWith('- ')).length;

function withRows(existing: string | undefined, head: readonly string[], added: readonly string[]): string {
  if (existing === undefined) return `${[...head, ...added].join('\n')}\n`;
  const lines = existing.split(/\r?\n/u);
  while (lines.length && lines.at(-1) === '') lines.pop();
  if (!lines.some(line => line.startsWith('- '))) lines.push('');
  return `${[...lines, ...added].join('\n')}\n`;
}

export function appendDecision(dir: string, line: string): { moved: number } {
  const file = join(dir, DECISIONS_FILE);
  const existing = readOwn(file, DECISIONS_FILE);
  const next = withRows(existing, HEAD, [line]).split('\n');
  const rowAt = next.flatMap((text, index) => (text.startsWith('- ') ? [index] : []));
  const extra = Math.max(0, rowAt.length - DECISIONS_ROWS_MAX);
  if (extra > 0) {
    const old = join(dir, DECISIONS_OLD_FILE);
    const moving = new Set(rowAt.slice(0, extra));
    replaceFile(old, withRows(readOwn(old, DECISIONS_OLD_FILE), OLD_HEAD, rowAt.slice(0, extra).map(index => next[index]!)));
    replaceFile(file, next.filter((_text, index) => !moving.has(index)).join('\n'));
  } else {
    replaceFile(file, next.join('\n'));
  }
  return { moved: extra };
}
