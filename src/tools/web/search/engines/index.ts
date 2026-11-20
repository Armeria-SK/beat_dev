import type { SearchEngine } from '../engine.ts';
import { bing } from './bing.ts';
import { brave } from './brave.ts';
import { duckduckgoHtml } from './duckduckgo-html.ts';
import { duckduckgoLite } from './duckduckgo-lite.ts';
import { mojeek } from './mojeek.ts';
import { startpage } from './startpage.ts';
import { wikipedia } from './wikipedia.ts';
import { yahoo } from './yahoo.ts';

export const ENGINE_IDS = ['duckduckgo-html', 'duckduckgo-lite', 'bing', 'brave', 'startpage', 'mojeek', 'yahoo', 'wikipedia'] as const;
export type EngineId = typeof ENGINE_IDS[number];

export const ENGINES: readonly SearchEngine[] = [duckduckgoHtml, duckduckgoLite, bing, brave, startpage, mojeek, yahoo, wikipedia];

export const DEFAULT_ENGINES: readonly EngineId[] = ['duckduckgo-html', 'duckduckgo-lite', 'bing', 'brave', 'startpage', 'mojeek', 'yahoo', 'wikipedia'];

export function enginesById(ids: readonly string[]): SearchEngine[] {
  return ids.map(id => ENGINES.find(engine => engine.id === id)).filter((engine): engine is SearchEngine => engine !== undefined);
}
