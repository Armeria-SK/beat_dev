export { DEFAULT_SEARCH_ENGINES, SEARCH_ENGINE_IDS, type SearchEngineId } from '../../../../shared/search-engines.ts';
import type { SearchEngine } from '../engine.ts';
import { bing } from './bing.ts';
import { brave } from './brave.ts';
import { duckduckgoHtml } from './duckduckgo-html.ts';
import { duckduckgoLite } from './duckduckgo-lite.ts';
import { mojeek } from './mojeek.ts';
import { startpage } from './startpage.ts';
import { wikipedia } from './wikipedia.ts';
import { yahoo } from './yahoo.ts';

export const ENGINES: readonly SearchEngine[] = [duckduckgoHtml, duckduckgoLite, bing, brave, startpage, mojeek, yahoo, wikipedia];

export function enginesById(ids: readonly string[]): SearchEngine[] {
  return ids.map(id => ENGINES.find(engine => engine.id === id)).filter((engine): engine is SearchEngine => engine !== undefined);
}
