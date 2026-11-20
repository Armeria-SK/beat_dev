// 検索先の id（設定 tools.web.engines の値）。中身は src/tools/web/search/engines/
export const SEARCH_ENGINE_IDS = ['duckduckgo-html', 'duckduckgo-lite', 'bing', 'brave', 'startpage', 'mojeek', 'yahoo', 'wikipedia'] as const;
export type SearchEngineId = (typeof SEARCH_ENGINE_IDS)[number];

export const DEFAULT_SEARCH_ENGINES: readonly SearchEngineId[] = ['duckduckgo-html', 'duckduckgo-lite', 'bing', 'brave', 'startpage', 'mojeek', 'yahoo', 'wikipedia'];
