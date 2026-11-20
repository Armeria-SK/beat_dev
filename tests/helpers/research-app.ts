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
export const ddg = (links: readonly string[]): PageResponse => html(`<div id="links" class="results">${links.map((l, i) => `<div class="result results_links web-result"><div class="result__body"><h2 class="result__title"><a class="result__a" href="${l}">Hit ${i}</a></h2><a class="result__snippet">Snippet ${i}</a></div></div>`).join('')}</div>`);

export const ALPHA = 'https://alpha.zqnotes.net/notes';
export const BETA = 'https://beta.zqnotes.net/app';

export function fakeWeb(hold?: { search?: Promise<void> }) {
  const asked: string[] = [];
  const network: PageNetwork = {
    resolve: async () => ['93.184.216.34'],
    get: async (url: URL, _address: string, signal: AbortSignal) => {
      asked.push(url.href);
      if (url.hostname === 'html.duckduckgo.com') {
        if (hold?.search) await Promise.race([hold.search, new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))]);
        return ddg([ALPHA, BETA]);
      }
      return html(`<p>${url.hostname} is released under the MIT License. It has Live Markdown preview and Tag search for notes.</p>`);
    },
  };
  return { network, asked };
}

export async function researchApp(t: Parameters<typeof startApp>[0], options: { configure?: (config: AppConfig) => void; contextLength?: number; hold?: { search?: Promise<void> } } = {}) {
  const products = realpathSync.native(tempDir(t as never));
  const web = fakeWeb(options.hold);
  const s = await startApp(t, {
    projectFolderExempt: [products], tools: builtinTools(), webNetwork: web.network,
    ...(options.contextLength ? { models: [fakeModel('m1', { contextLength: options.contextLength }), fakeModel('m2', { contextLength: options.contextLength })] } : {}),
    configure: c => { c.memory.review = false; c.research = { when: 'new' }; options.configure?.(c); },
  });
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
