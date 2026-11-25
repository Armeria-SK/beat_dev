import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import type { ToolDef } from '../src/tools/types.ts';

type Route = 'shell-statements' | 'submits' | 'precheck-outbound' | 'none';

const ROUTES: Readonly<Record<string, { route: Route; why: string }>> = {
  shell_stop: { route: 'none', why: 'stops a background command of this conversation; stopping is protective, it neither sends nor removes anything' },
  shell_run: { route: 'shell-statements', why: 'preCheck puts outboundOf(statements) into PreCheck.outbound: uploads, git push, scp/ssh, rm -rf, Remove-Item, Clear-Content' },
  browser_click: { route: 'submits', why: 'ToolDef.submits: every click may submit a form' },
  browser_type: { route: 'submits', why: 'ToolDef.submits: typing with Enter may submit a form' },
  browser_act: { route: 'submits', why: 'ToolDef.submits: its click and type steps may submit a form' },
  browser_open: { route: 'precheck-outbound', why: 'preCheck returns outbound send for a listed site with a query or after outside text' },
  file_write: { route: 'none', why: 'writes inside the allowed roots; overwriting is not a removal (owner ruling 2026-11-07)' },
  file_edit: { route: 'none', why: 'edits inside the allowed roots; no removal' },
  table_write: { route: 'none', why: 'writes a table inside the allowed roots; overwriting is not a removal' },
  web_search: { route: 'none', why: 'a query; secret-looking or long text is refused at order 1 (web.secret_text / web.long_query)' },
  web_fetch: { route: 'none', why: 'a GET; secret-looking URL text is refused at order 1' },
  web_download: { route: 'none', why: 'a GET saved under downloads/; secret-looking URL text is refused at order 1' },
  browser_read: { route: 'none', why: 'reads the open tab' },
  browser_find: { route: 'none', why: 'searches the open tab; the query stays on this PC' },
  browser_screenshot: { route: 'none', why: 'captures the open tab' },
  image_view: { route: 'none', why: 'a GET for a remote image (networkCall); secret-looking URL text is refused at order 1' },
};

const effectful = (tool: ToolDef): boolean => tool.effect === 'write' || tool.effect === 'exec' || tool.effect === 'network' || tool.networkCall !== undefined || tool.writesFiles === true || tool.submits === true;

test('every builtin tool that writes, runs, or goes out is classified here: a new one fails until it says how its sends and deletes reach the owner (order 3)', () => {
  const names = builtinTools().filter(effectful).map(tool => tool.name).sort();
  assert.deepEqual(names, Object.keys(ROUTES).sort());
});

test('the classification matches the tool definitions', () => {
  const tools = new Map(builtinTools().map(tool => [tool.name, tool]));
  for (const [name, { route }] of Object.entries(ROUTES)) {
    const tool = tools.get(name)!;
    assert.equal(tool.submits === true, route === 'submits', `${name}: submits`);
    if (route === 'shell-statements' || route === 'precheck-outbound') assert.ok(tool.preCheck, `${name}: needs a preCheck to return outbound`);
    assert.equal(tool.mcp, undefined, `${name}: builtin, not MCP`);
  }
});
