import { DEFAULT_LANGUAGE, type AppConfig, type Language } from '../config/schema.ts';

// 言語は 1 つ（英語）。引数は P1 で消す
export function languageOf(_config: AppConfig): Language {
  return DEFAULT_LANGUAGE;
}
