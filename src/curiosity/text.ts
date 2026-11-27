import type { Language } from '../config/schema.ts';

interface CuriosityText {
  title: (topic: string) => string;
  why: (why: string) => string;
  summarize: string;
  doneCriteria: string;
  doneCriteriaQuiet: string;
}

const TEXT: Record<Language, CuriosityText> = {
  en: {
    title: topic => `Look into: ${topic}`,
    why: why => `Why this caught your interest: ${why}`,
    summarize: 'Sum up what you find out, briefly and in a form that is useful to the user: what you found, the pages it rests on (URLs), and what is still unknown.',
    doneCriteria: 'The findings are written up in the summary of task_complete',
    doneCriteriaQuiet: 'The findings are written up in the summary of task_complete (use notify=false if they are not worth telling the user)',
  },
};

export function curiosityText(language: Language): CuriosityText {
  return TEXT[language];
}
