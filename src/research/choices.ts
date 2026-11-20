import type { DatabaseSync } from 'node:sqlite';
import { RESEARCH_LANGUAGES, type ResearchLanguage, type ResearchSettings } from '../shared/research-languages.ts';
import type { ToolCheck } from './toolchain.ts';

// beat R (R-3): 言語とやり方の物差し。列も行もコードが決める（モデルの好みでは決めない）

export const LANGUAGE_QUESTION = 'Programming language';
export const LOAD_QUESTION = 'Expected load';
export const DELIVERY_QUESTION = 'How it is delivered';
export const LOAD_OPTIONS = ['Light (one person, small data)', 'Normal (a few people at once)', 'Heavy (many people or large data, quick replies)'] as const;
export const DELIVERY_OPTIONS = ['One app or file on this PC', 'A server', 'A page in the web browser'] as const;
export type Delivery = 'local' | 'server' | 'browser';
const DELIVERIES: readonly Delivery[] = ['local', 'server', 'browser'];
export const LANGUAGE_OPTIONS_MAX = 4;

// 言語の名前（語の切れ目のある所だけ当てる。「is written in Go」は「Google」では当たらない）
const NAMES: Record<ResearchLanguage, { words: readonly string[]; exact?: readonly string[] }> = {
  'TypeScript / JavaScript': { words: ['typescript', 'javascript', 'node.js', 'nodejs', 'deno'] },
  Python: { words: ['python'] },
  Go: { words: ['golang'], exact: ['Go'] },
  Rust: { words: ['rust'] },
  'C#': { words: ['c#', 'csharp', '.net'] },
  'Java / Kotlin': { words: ['java', 'kotlin'] },
  'C / C++': { words: ['c++', 'cpp'] },
  Swift: { words: ['swift'] },
  Dart: { words: ['dart', 'flutter'] },
  PHP: { words: ['php'] },
  Ruby: { words: ['ruby'] },
};

const EDGE = /[\p{L}\p{N}_+#]/u;

// exact（大文字の Go など）は文の頭では当てない（「Go ahead」を言語の名前にしない）
function hasWord(text: string, word: string, fold: boolean): boolean {
  const hay = fold ? text.toLowerCase() : text;
  for (let at = hay.indexOf(word); at >= 0; at = hay.indexOf(word, at + 1)) {
    const before = hay[at - 1];
    const after = hay[at + word.length];
    const head = !fold && /(?:^|[.!?\n])\s*$/u.test(hay.slice(0, at));
    if ((before === undefined || !EDGE.test(before)) && (after === undefined || !EDGE.test(after)) && !head) return true;
  }
  return false;
}

export function languagesIn(text: string): ResearchLanguage[] {
  const folded = text.normalize('NFKC');
  return RESEARCH_LANGUAGES.filter(language => NAMES[language].words.some(word => hasWord(folded, word, true)) || (NAMES[language].exact ?? []).some(word => hasWord(folded, word, false)));
}

const EXTENSIONS: Record<string, ResearchLanguage> = {
  ts: 'TypeScript / JavaScript', tsx: 'TypeScript / JavaScript', js: 'TypeScript / JavaScript', jsx: 'TypeScript / JavaScript', mjs: 'TypeScript / JavaScript', cjs: 'TypeScript / JavaScript',
  py: 'Python', go: 'Go', rs: 'Rust', cs: 'C#', java: 'Java / Kotlin', kt: 'Java / Kotlin', c: 'C / C++', cc: 'C / C++', cpp: 'C / C++', h: 'C / C++', hpp: 'C / C++',
  swift: 'Swift', dart: 'Dart', php: 'PHP', rb: 'Ruby',
};

// 製品のフォルダのコードの言語（拡張子で数えて最も多いもの）。コードが無ければ null
export function languageOfFiles(places: readonly string[]): ResearchLanguage | null {
  const counts = new Map<ResearchLanguage, number>();
  for (const place of places) {
    const ext = /\.([a-z0-9]+)$/iu.exec(place)?.[1]?.toLowerCase();
    const language = ext ? EXTENSIONS[ext] : undefined;
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || RESEARCH_LANGUAGES.indexOf(a[0]) - RESEARCH_LANGUAGES.indexOf(b[0]))[0]?.[0] ?? null;
}

export type NoAsk = { ask: false; language: ResearchLanguage; why: 'files' | 'settings' | 'owner' } | { ask: true };

// 聞かないとき: 製品のフォルダにコードがある・設定で「聞かない」と好きな言語・持ち主の発言に言語の名前が 1 つだけ
export function languageDecided(input: { files: readonly string[]; settings: Pick<ResearchSettings, 'askLanguage' | 'preferLanguages'>; ownerText: string }): NoAsk {
  const files = languageOfFiles(input.files);
  if (files) return { ask: false, language: files, why: 'files' };
  if (!input.settings.askLanguage && input.settings.preferLanguages[0]) return { ask: false, language: input.settings.preferLanguages[0], why: 'settings' };
  const said = languagesIn(input.ownerText);
  if (said.length === 1) return { ask: false, language: said[0]!, why: 'owner' };
  return { ask: true };
}

const DELIVERY_WORDS: Record<Delivery, readonly string[]> = {
  local: ['desktop app', 'command line', 'cli', 'single file', 'デスクトップ', 'コマンドライン'],
  server: ['server', 'api', 'backend', 'サーバー', 'サーバ'],
  browser: ['browser', 'web app', 'web page', 'website', 'ブラウザ', 'ウェブ', 'サイト'],
};

export function deliveryIn(ownerText: string): Delivery | null {
  const text = ownerText.normalize('NFKC');
  const found = DELIVERIES.filter(d => DELIVERY_WORDS[d].some(word => /^[a-z ]+$/u.test(word) ? hasWord(text, word, true) : text.includes(word)));
  return found.length === 1 ? found[0]! : null;
}

const RUNS_ON: Record<ResearchLanguage, readonly string[]> = {
  'TypeScript / JavaScript': ['node', 'deno', 'bun'], Python: ['python', 'python3'], Go: ['go'], Rust: ['cargo', 'rustc'], 'C#': ['dotnet'], 'Java / Kotlin': ['java'],
  'C / C++': [], Swift: [], Dart: [], PHP: ['php'], Ruby: ['ruby'],
};
const FITS: Record<Delivery, readonly ResearchLanguage[]> = {
  local: ['Go', 'Rust', 'C#', 'Python', 'TypeScript / JavaScript'],
  server: ['Go', 'TypeScript / JavaScript', 'Python', 'Java / Kotlin', 'C#', 'Rust'],
  browser: ['TypeScript / JavaScript'],
};
const FAST: readonly ResearchLanguage[] = ['Go', 'Rust', 'C#', 'Java / Kotlin', 'C / C++'];

export const toolsFor = (language: ResearchLanguage): readonly string[] => RUNS_ON[language];

export interface RankInput {
  delivery: Delivery | null;
  heavy: boolean;
  tools: readonly ToolCheck[];
  similar: readonly ResearchLanguage[];
  prefer: readonly ResearchLanguage[];
  avoid: readonly ResearchLanguage[];
  past: ReadonlyMap<ResearchLanguage, number>;
}

export interface Ranked { language: ResearchLanguage; score: number }

// 決まった順の重み: 配り方と PC の道具が先、似ている OSS が次、持ち主の好みと過去の選び、負荷は「重い」のときだけ速い言語を上げる
export function rankLanguages(input: RankInput): Ranked[] {
  const installed = new Set(input.tools.filter(t => t.state === 'installed' || t.state === 'found').map(t => t.name));
  const similar = new Map<ResearchLanguage, number>();
  for (const language of input.similar) similar.set(language, (similar.get(language) ?? 0) + 1);
  return RESEARCH_LANGUAGES.filter(language => !input.avoid.includes(language)).map(language => {
    let score = 0;
    if (input.delivery) score += FITS[input.delivery].includes(language) ? 40 - FITS[input.delivery].indexOf(language) * 2 : -40;
    if (RUNS_ON[language].some(tool => installed.has(tool))) score += 30;
    score += Math.min(3, similar.get(language) ?? 0) * 8;
    if (input.prefer.includes(language)) score += 12;
    score += Math.min(3, input.past.get(language) ?? 0) * 3;
    if (input.heavy && FAST.includes(language)) score += 10;
    return { language, score };
  }).sort((a, b) => b.score - a.score || RESEARCH_LANGUAGES.indexOf(a.language) - RESEARCH_LANGUAGES.indexOf(b.language));
}

// 持ち主がこれまで選んだ言語: DB の、ほかの製品の確定した言語の行（コードが作った行・持ち主の選んだ値）だけを数える。DECISIONS.md は読まない
export function pastLanguages(db: DatabaseSync, projectId: string): Map<ResearchLanguage, number> {
  const rows = db.prepare(`SELECT i.options, i.decision FROM research_items i JOIN research_runs r ON r.id = i.research_id
    WHERE r.project_id IS NOT ? AND r.status = 'confirmed' AND i.kind = 'choice' AND i.decision IS NOT NULL AND json_extract(i.evidence, '$.what') = 'language'`).all(projectId) as Array<{ options: string; decision: string }>;
  const counts = new Map<ResearchLanguage, number>();
  for (const row of rows) {
    const value = (JSON.parse(row.options) as string[])[Number(row.decision)];
    const language = RESEARCH_LANGUAGES.find(l => l === value);
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return counts;
}

const CHECKS: Partial<Record<ResearchLanguage, string>> = {
  'TypeScript / JavaScript': 'npm test', Python: 'python -m pytest', Go: 'go test ./...', Rust: 'cargo test', 'C#': 'dotnet test', 'Java / Kotlin': 'gradle test', PHP: 'composer test', Ruby: 'bundle exec rake test',
};

export const checkCommandFor = (language: string): string | null => CHECKS[language as ResearchLanguage] ?? null;

export const isLanguage = (value: string): value is ResearchLanguage => (RESEARCH_LANGUAGES as readonly string[]).includes(value);

const HEAVY = ['many users', 'large data', 'heavy load', 'high traffic', 'real time', 'realtime', '大量', '高速', 'リアルタイム', '同時に多く'];

// 負荷の重さ: 持ち主の発言に「重い」を表す語があるときだけ（負荷の問いの答えは同じ確定で来るので、物差しには使えない）
export const heavyIn = (ownerText: string): boolean => {
  const text = ownerText.normalize('NFKC').toLowerCase();
  return HEAVY.some(word => text.includes(word));
};
