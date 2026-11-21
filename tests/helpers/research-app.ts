import assert from 'node:assert/strict';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { builtinTools } from '../../src/app.ts';
import type { AppConfig } from '../../src/config/schema.ts';
import type { ChatMessage } from '../../src/engine/types.ts';
import type { ResearchRunRow } from '../../src/research/store.ts';
import type { PageNetwork, PageResponse } from '../../src/tools/web/public-page.ts';
import { fakeModel, settled, startApp, uuid, waitFor } from '../app-setup.ts';
import { tempDir } from '../helpers.ts';

// beat R: 調べる記録の試験の組み立て。偽の Web（DuckDuckGo の形の結果と、ページ）と、新しい製品 1 つ

export const html = (body: string): PageResponse => ({ status: 200, contentType: 'text/html; charset=utf-8', body: Buffer.from(`<!doctype html><html><head><title>t</title></head><body><main>${body}</main></body></html>`) });
export const ddg = (links: readonly string[]): PageResponse => html(`<div id="links" class="results">${links.length ? links.map((l, i) => `<div class="result results_links web-result"><div class="result__body"><h2 class="result__title"><a class="result__a" href="${l}">Hit ${i}</a></h2><a class="result__snippet">Snippet ${i}</a></div></div>`).join('') : '<div class="no-results">No results.</div>'}</div>`);
// Bing の形の結果（検索先を 2 つにする試験だけが使う。tools.web.engines に bing を入れたとき）
export const bingPage = (links: readonly string[]): PageResponse => html(`<ol id="b_results">${links.length ? links.map((l, i) => `<li class="b_algo"><h2><a href="${l}">Bing hit ${i}</a></h2><div class="b_caption"><p>Bing snippet ${i}</p></div></li>`).join('') : '<li class="b_no">No results</li>'}</ol>`);

export const ALPHA = 'https://alpha.zqnotes.net/notes';
export const BETA = 'https://beta.zqnotes.net/app';

export function fakeWeb(hold?: { search?: Promise<void> }, blockSearch: boolean | number = false, emptySearch = false) {
  const asked: string[] = [];
  let searches = 0;
  const network: PageNetwork = {
    resolve: async () => ['93.184.216.34'],
    get: async (url: URL, _address: string, signal: AbortSignal) => {
      asked.push(url.href);
      if (url.hostname === 'www.bing.com') {
        searches++;
        if (blockSearch === true || searches <= Number(blockSearch)) return { status: 429, contentType: 'text/html', body: Buffer.alloc(0) };
        return bingPage(emptySearch ? [] : [ALPHA, BETA]);
      }
      if (url.hostname === 'html.duckduckgo.com') {
        searches++;
        if (blockSearch === true || searches <= Number(blockSearch)) return html('<p>Unfortunately, bots use DuckDuckGo too. Please complete the following challenge.</p>');
        if (hold?.search) await Promise.race([hold.search, new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))]);
        return ddg(emptySearch ? [] : [ALPHA, BETA]);
      }
      return html(`<p>${url.hostname} is released under the MIT License. It has Live Markdown preview and Tag search for notes.</p>`);
    },
  };
  return { network, asked };
}

export async function researchApp(t: Parameters<typeof startApp>[0], options: { configure?: (config: AppConfig) => void; contextLength?: number; hold?: { search?: Promise<void> }; blockSearch?: boolean | number; emptySearch?: boolean; now?: () => number } = {}) {
  const products = realpathSync.native(tempDir(t as never));
  const web = fakeWeb(options.hold, options.blockSearch, options.emptySearch);
  const s = await startApp(t, {
    projectFolderExempt: [products], tools: builtinTools(), webNetwork: web.network, ...(options.now ? { now: options.now } : {}),
    ...(options.contextLength ? { models: [fakeModel('m1', { contextLength: options.contextLength }), fakeModel('m2', { contextLength: options.contextLength })] } : {}),
    configure: c => { c.memory.review = false; c.research = { when: 'new' }; options.configure?.(c); },
  });
  // PC の道具の確かめは試験では動かさない（本物の実行ファイルを起こさない）
  s.app.research.toolchain = async names => names.map(name => ({ name, state: 'missing' as const, path: null, version: null }));
  const root = join(products, 'Notes');
  mkdirSync(root, { recursive: true });
  const made = await s.json('/api/projects', 'POST', { root });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const projectId = made.body.project.id as string;
  const send = async (conversation: number, text: string, extra: Record<string, unknown> = {}) => {
    const sent = await s.json(`/api/conversations/${uuid(conversation)}/messages`, 'POST', { text, projectId, ...extra });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await settled(s.app, sent.body.runId);
    return sent.body.runId as string;
  };
  const records = (): ResearchRunRow[] => s.app.research.store.list(projectId);
  const settle = async (label = 'research ended') => {
    await waitFor(() => records().length > 0 && records().every(r => r.status !== 'running'), label, 5000);
    await Promise.all(records().map(r => s.app.research.waitFor(r.id)));
  };
  const users = (conversationId: string) => s.app.conversations.messages(conversationId).map(m => m.message).filter((m): m is Extract<ChatMessage, { role: 'user' }> => m.role === 'user');
  const tools = (conversationId: string) => s.app.conversations.messages(conversationId).map(m => m.message).filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool');
  return { ...s, ...web, root, projectId, send, records, settle, users, tools };
}
