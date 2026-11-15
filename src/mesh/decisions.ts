import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectDir } from '../projects/store.ts';
import { plainLine } from '../shared/plain-text.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { MeshWriteError, readOwn, replaceFile, type Writer } from './files.ts';

export const DECISIONS_FILE = 'DECISIONS.md';
export const DECISIONS_OLD_FILE = 'DECISIONS-old.md';
export const DECISIONS_ROWS_MAX = 30;
export const DECISIONS_LINE_MAX = 200;

const HEAD = ['# DECISIONS', '', `Decisions, oldest first. beat writes a line when the owner answers a question. Lines marked [by task] are decisions the AI recorded, not the owner. Older lines move to ${DECISIONS_OLD_FILE}.`, ''];
const FORMER_INTRO = `Decisions the owner made, oldest first. beat writes a line when the owner answers a question. Older lines move to ${DECISIONS_OLD_FILE}.`;
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
  fromBeat?: boolean | undefined;
}

const chars = (text: string): number => Array.from(text).length;

function clip(text: string, max: number): string {
  if (max <= 0) return '';
  const list = Array.from(text);
  return list.length <= max ? text : `${list.slice(0, Math.max(0, max - 1)).join('')}${ELLIPSIS}`;
}

const one = (text: string): string => redactSecrets(plainLine(text, Infinity));
const QUOTES = /["\u201C\u201D\u201E\u201F\uFF02\u00AB\u00BB\u02EE\u05F4\u301D-\u301F\u275D\u275E\u2033\u2035\u2036]/gu;
const aiText = (text: string): string => one(text.replace(QUOTES, "'").normalize('NFKC')).replace(QUOTES, "'").replace(/-{5,}/gu, '----');

export function decisionLine(d: OwnerDecision): string {
  const what = d.kept ? 'kept the assumed answer' : `changed the answer${d.item ? `, reopened ${d.item}` : ''}`;
  const head = `- ${d.date} question #${d.questionId}: ${what}. Owner ${d.picked === 'option' ? 'picked' : 'wrote'}: "`;
  const tail = d.external ? EXTERNAL_MARK : '';
  const answer = d.picked === 'option' ? aiText(d.answer) : one(d.answer);
  const question = aiText(d.question);
  const asked = (q: string) => (q ? `. ${d.fromBeat ? 'beat' : 'AI'} asked: "${q}"` : '');
  const frame = chars(asked('-')) - 1;
  const room = DECISIONS_LINE_MAX - chars(head) - chars(tail) - 1;
  const answerRoom = Math.min(chars(answer), Math.max(1, room - (question ? frame + QUESTION_MIN : 0)));
  const quoted = clip(answer, answerRoom);
  const left = room - chars(quoted) - frame;
  const shownQuestion = question && left >= QUESTION_MIN ? clip(question, left) : '';
  return `${head}${quoted}"${asked(shownQuestion)}${tail}`;
}

export interface AiDecision { date: string; text: string; writer: Writer }

const AI_EXTERNAL = / \\?\[by (?:conversation|task|child), src: external\\?\]$/u;
const AI_ROW = / \\?\[by (?:conversation|task|child)(?:, src: external)?\\?\]$/u;

export function aiDecisionLine(d: AiDecision): { line: string; hidden: boolean } {
  const folded = d.text.normalize('NFKC');
  if (/[[\]]/u.test(folded)) throw new MeshWriteError('decision_marks');
  const text = aiText(d.text);
  if (!text.trim()) throw new MeshWriteError('decision_empty');
  const head = `- ${d.date} AI decided: "`;
  const tail = `" [by ${d.writer.by}${d.writer.external ? ', src: external' : ''}]`;
  const max = DECISIONS_LINE_MAX - chars(head) - chars(tail);
  if (chars(text) > max) throw new MeshWriteError('decision_too_long', { length: chars(text), max });
  return { line: `${head}${text}${tail}`, hidden: one(folded) !== plainLine(folded, Infinity) };
}

export function addAiDecision(projectsDir: string, projectId: string, d: AiDecision): { hidden: boolean; lineMoved: boolean } {
  const { line, hidden } = aiDecisionLine(d);
  const dir = projectDir(projectsDir, projectId);
  mkdirSync(dir, { recursive: true });
  const { lineMoved } = appendDecision(dir, line);
  return { hidden, lineMoved };
}

export const decisionRows = (content: string): number => content.split(/\r?\n/u).filter(line => line.startsWith('- ') && !AI_EXTERNAL.test(line)).length;

function withRows(existing: string | undefined, head: readonly string[], added: readonly string[]): string {
  if (existing === undefined) return `${[...head, ...added].join('\n')}\n`;
  const lines = existing.split(/\r?\n/u);
  while (lines.length && lines.at(-1) === '') lines.pop();
  if (!lines.some(line => line.startsWith('- '))) lines.push('');
  return `${[...lines, ...added].join('\n')}\n`;
}

export function appendDecision(dir: string, line: string): { moved: number; lineMoved: boolean } {
  const file = join(dir, DECISIONS_FILE);
  const existing = readOwn(file, DECISIONS_FILE)?.split(/\r?\n/u).map(text => (text === FORMER_INTRO ? HEAD[2]! : text)).join('\n');
  const next = withRows(existing, HEAD, [line]).split('\n');
  const rowAt = next.flatMap((text, index) => (text.startsWith('- ') ? [index] : []));
  const extra = Math.max(0, rowAt.length - DECISIONS_ROWS_MAX);
  let lineMoved = false;
  if (extra > 0) {
    const old = join(dir, DECISIONS_OLD_FILE);
    const ai = rowAt.filter(index => AI_ROW.test(next[index]!));
    const moved = [...ai, ...rowAt.filter(index => !AI_ROW.test(next[index]!))].slice(0, extra).sort((a, b) => a - b);
    const moving = new Set(moved);
    lineMoved = moving.has(rowAt.at(-1)!);
    replaceFile(old, withRows(readOwn(old, DECISIONS_OLD_FILE), OLD_HEAD, moved.map(index => next[index]!)));
    replaceFile(file, next.filter((_text, index) => !moving.has(index)).join('\n'));
  } else {
    replaceFile(file, next.join('\n'));
  }
  return { moved: extra, lineMoved };
}
