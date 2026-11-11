import type { Language } from '../config/schema.ts';

interface EngineText {
  summaryHeading: string;
  compactSystem: string;
  compactInstructions: readonly string[];
  compactPreviousHeading: string;
  compactTranscriptHeading: string;
  user: string;
  toolResult: (name: string) => string;
  wrapUpSystem: string;
  wrapUpInstructions: readonly string[];
  wrapUpTranscriptHeading: string;
}

const TEXT: Record<Language, EngineText> = {
  en: {
    summaryHeading: '# Summary of the conversation so far (the older part; the original text can be read with history_read)',
    compactSystem: 'You are a conversation summarizer. Write only the summary, exactly as instructed.',
    compactInstructions: [
      'This is the older part of a conversation. Summarize, concisely as bullet points in the language the user writes in (the language of the "User:" lines), what is needed to continue the conversation from here.',
      "Keep: the user's goals, what they asked for, what was decided, facts that were found, what is not finished yet, and important proper nouns and numbers.",
      'Drop: greetings, turns of phrase, and the details of trial and error.',
    ],
    compactPreviousHeading: '# Summary so far (add to this and rewrite it as one summary)',
    compactTranscriptHeading: '# Older part of the conversation',
    user: 'User',
    toolResult: name => `Result of tool (${name})`,
    wrapUpSystem: 'You write handover notes. Write only a short handover note, exactly as instructed. You cannot use tools.',
    wrapUpInstructions: [
      'The work so far stopped partway because the tool-call limit was reached. Write only the following two parts, briefly, in the language the user writes in (the language of the "User:" lines in the record below; 10 lines or fewer in total). Keep the two headings exactly as written here, in English: "Done so far:" and "Next step:".',
      '"Done so far:": what was actually finished (including files written and facts found).',
      '"Next step:": what to do first if the work continues.',
      'Do not present things you have not seen or done as done.',
    ],
    wrapUpTranscriptHeading: '# Record of the work so far',
  },
};

export function summarySection(summary: string, language: Language): string {
  return summary ? `${TEXT[language].summaryHeading}\n${summary}` : '';
}

export function compactSystem(language: Language): string {
  return TEXT[language].compactSystem;
}

export function wrapUpSystem(language: Language): string {
  return TEXT[language].wrapUpSystem;
}

export function wrapUpPrompt(transcript: string, language: Language): string {
  const text = TEXT[language];
  return [...text.wrapUpInstructions, `\n${text.wrapUpTranscriptHeading}\n${transcript}`].join('\n');
}

const NEXT_STEP = /(?:^|\n)[ \t]*(?:(?:#{1,6}|[-*+])[ \t]+)?[*_「『"“'`]*(?:次の一手|Next steps?)[*_」』"”'`]*[ \t]*(?:[:：][*_」』"”'`]*|\r?\n)([\s\S]+)$/iu;

// まとめの「次の一手」の部分（見出しの後ろ）。見出しは「」・""・**・先頭の # や - で飾ってよく、コロンは無くてもよい（中身は同じ行でも次の行でも）。見つからなければ undefined
export function nextStepOf(summary: string): string | undefined {
  const step = NEXT_STEP.exec(summary)?.[1]?.trim();
  return step ? step.slice(0, 500) : undefined;
}

export function compactSpeaker(message: { role: string; name?: string }, language: Language): string {
  const text = TEXT[language];
  return message.role === 'user' ? text.user : message.role === 'assistant' ? 'Clive' : text.toolResult(message.name ?? '');
}

export function compactPrompt(input: { previous: string | null; transcript: string }, language: Language): string {
  const text = TEXT[language];
  return [
    ...text.compactInstructions,
    input.previous ? `\n${text.compactPreviousHeading}\n${input.previous}` : '',
    `\n${text.compactTranscriptHeading}\n${input.transcript}`,
  ].join('\n');
}
