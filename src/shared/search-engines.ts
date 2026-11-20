// 検索先の id（設定 tools.web.engines の値）。中身は src/tools/web/search/engines/
export const SEARCH_ENGINE_IDS = ['duckduckgo-html', 'duckduckgo-lite', 'bing', 'brave', 'startpage', 'mojeek', 'yahoo', 'wikipedia'] as const;
export type SearchEngineId = (typeof SEARCH_ENGINE_IDS)[number];

// 既定の先は、2026-11-21 にこの機械から scripts/search-smoke.ts（ふりの頭の行）で試した結果で決めた。外した先のファイルは残し、設定に書けば使える:
// - duckduckgo-lite: 2 回とも HTTP 202。html が止められた直後に同じく止められ、html と一緒に休む（restGroup）ので、並べても足しにならない
// - brave: 2 回とも HTTP 429
// - startpage: 2 回とも JavaScript で計算させる確かめの頁
// - mojeek: 2 回とも captcha の頁（正直な名乗りでも captcha だった）
// - yahoo: 2 回とも HTTP 500
// duckduckgo-html は 1 回目に結果、続けて送った 2 回目からは HTTP 202（止められた先は休む仕組みで扱う）。
// bing は 1 回目に結果、smoke の 1 回は返事を読めない種類として断った（原因は未確認）。そのあと頭の行だけ見た 1 回は普通の HTML だった
export const DEFAULT_SEARCH_ENGINES: readonly SearchEngineId[] = ['duckduckgo-html', 'bing', 'wikipedia'];
