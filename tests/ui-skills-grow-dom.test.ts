import { cleanup, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';

interface SkillsProps { target: undefined; revision: number; running: boolean; onDrafts: (n: number) => void }
const { Skills } = await loadTsx<{ Skills: ComponentType<SkillsProps> }>('../web/src/ui/screens/Skills.tsx', import.meta.url);

const realFetch = globalThis.fetch;
afterEach(async () => { await cleanup(); globalThis.fetch = realFetch; });

function serve(skills: Record<string, unknown> | undefined): void {
  globalThis.fetch = (async (path: string | URL | Request) => {
    const p = String(path);
    const out = p === '/api/skills' ? { skills: [] } : p === '/api/review' ? { skillDrafts: [] } : p === '/api/tools' ? { tools: [] }
      : p === '/api/settings' ? { config: skills ? { skills } : {}, apiKeys: {}, configError: null, restartRequired: false, configPath: 'x' } : undefined;
    return new Response(JSON.stringify(out ?? { error: 'not found' }), { status: out === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 200)));

test('ui/Skills（DOM）: with Grow skills Off the screen says so in one quiet line; On (or unset) shows nothing', async () => {
  for (const [skills, shown] of [[{ grow: false }, true], [undefined, false], [{ grow: true }, false]] as const) {
    serve(skills);
    const { container } = await render(createElement(Skills, { target: undefined, revision: 0, running: false, onDrafts: () => undefined }));
    await settle();
    const line = container.querySelector('[data-grow="off"]');
    assert.equal(line !== null, shown, JSON.stringify(skills));
    if (line) assert.equal(line.textContent, 'Growing skills is off, so beat makes no new drafts · Settings › Skills');
    await cleanup();
  }
});
