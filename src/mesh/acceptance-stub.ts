import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectDir } from '../projects/store.ts';

export type AcceptanceSource =
  | { kind: 'owner_words'; quote: string; messageId: number; conversationId: string }
  | { kind: 'owner_choice'; question: string; questionMessageId: number; answer: string; answerMessageId: number; conversationId: string }
  | { kind: 'ai_added'; claimed?: string; reason?: 'not_found' | 'too_short' | 'not_next_reply' }
  | { kind: 'owner_edit' };

export type AcceptanceCheck = { kind: 'command'; command: string } | { kind: 'look' } | { kind: 'read' };

export type AcceptanceState = 'open' | 'met' | 'unverified';

export interface AcceptanceItem {
  id: string;
  result: string;
  source: AcceptanceSource;
  check: AcceptanceCheck;
  state: AcceptanceState;
  evidence: unknown[];
  changedIn: number | null;
  removedIn: number | null;
}

export interface NotDoingItem { id: string; text: string; source: AcceptanceSource }

export interface AcceptanceDoc {
  schema: 1;
  version: number;
  language: string | null;
  items: AcceptanceItem[];
  notDoing: NotDoingItem[];
  taintedRuns?: string[];
}

export class AcceptanceStore {
  readonly #projects: string;

  constructor(projectsDir: string) { this.#projects = projectsDir; }

  read(projectId: string): AcceptanceDoc | undefined {
    const file = join(projectDir(this.#projects, projectId), 'acceptance.json');
    if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return undefined;
    return JSON.parse(readFileSync(file, 'utf8')) as AcceptanceDoc;
  }
}
