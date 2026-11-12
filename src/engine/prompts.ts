import type { Language } from '../config/schema.ts';

interface EngineText {
  summaryHeading: string;
  compactSystem: string;
  compactInstructions: readonly string[];
  compactPreviousHeading: string;
  compactTranscriptHeading: string;
  user: string;
  toolResult: (name: string) => string;
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
  },
};

export function summarySection(summary: string, language: Language): string {
  return summary ? `${TEXT[language].summaryHeading}\n${summary}` : '';
}

export function compactSystem(language: Language): string {
  return TEXT[language].compactSystem;
}

export function compactSpeaker(message: { role: string; name?: string }, language: Language): string {
  const text = TEXT[language];
  return message.role === 'user' ? text.user : message.role === 'assistant' ? 'beat' : text.toolResult(message.name ?? '');
}

export function compactPrompt(input: { previous: string | null; transcript: string }, language: Language): string {
  const text = TEXT[language];
  return [
    ...text.compactInstructions,
    input.previous ? `\n${text.compactPreviousHeading}\n${input.previous}` : '',
    `\n${text.compactTranscriptHeading}\n${input.transcript}`,
  ].join('\n');
}
