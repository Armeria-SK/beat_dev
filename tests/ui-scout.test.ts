import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkerRun } from '../web/src/api.ts';
import { removeModel, renameModel } from '../web/src/settings/model.ts';
import { firstSentences, kanbanPaneCount, NARROW_COLUMNS } from '../web/src/ui/kanban.ts';
import { ownerRuns, runningRows } from '../web/src/ui/overview.ts';
import { canThinkNow, isScoutState, SCOUT_MODE_CHOICES } from '../web/src/ui/scout.ts';
import { scoutChoice, setScout } from '../web/src/ui/settings/view.ts';

// beat 7-1: the Kanban pane, proposal cards, the thinking model's state and the Scout role. Pure rules only.

test('ui/kanban (7-1): a proposal card shows at most two sentences of why', () => {
  assert.equal(firstSentences('One. Two! Three? Four.'), 'One. Two!');
  assert.equal(firstSentences('Only one sentence without a stop'), 'Only one sentence without a stop');
  assert.equal(firstSentences('日本語の文。二つ目。三つ目。'), '日本語の文。二つ目。');
  assert.equal(firstSentences('  '), '');
});

test('ui/kanban (7-1): the Kanban pane tab counts Proposed plus Awaiting check of this product only; the narrow order is Proposed, Awaiting check, In progress, Approved, Done', () => {
  const marks = [
    { status: 'inbox' as const, projectId: 'p1' }, { status: 'inbox' as const, projectId: 'p2' }, { status: 'inbox' as const, projectId: null },
    { status: 'done' as const, checkState: 'awaiting' as const, projectId: 'p1' }, { status: 'done' as const, checkState: 'checked' as const, projectId: 'p1' },
    { status: 'ready' as const, projectId: 'p1' }, { status: 'waiting' as const, projectId: 'p1' },
  ];
  assert.equal(kanbanPaneCount(marks, 'p1'), 2);
  assert.equal(kanbanPaneCount(marks, 'p2'), 1);
  assert.equal(kanbanPaneCount([], 'p1'), 0);
  assert.deepEqual(NARROW_COLUMNS.slice(0, 5), ['proposed', 'check', 'progress', 'approved', 'done']);
});

test('ui/overview (7-1): a worker run of a kind the screen does not know (the thinking run, "scout") is neither a Running now row nor "another task is running"', () => {
  const runs: WorkerRun[] = [
    { kind: 'scout', taskId: 't-scout', runId: 'r1', title: 'think' },
    { kind: 'task', taskId: 't1', runId: 'r2', title: 'Build' },
    { kind: 'review', reviewKind: 'memory', taskId: null, runId: 'r3', title: '' },
  ];
  assert.deepEqual(ownerRuns(runs).map(r => r.runId), ['r2', 'r3']);
  assert.deepEqual(ownerRuns([runs[0]!]), [], 'only the thinking run: nothing else is busy');
  const unknown = { kind: 'later', taskId: null, runId: 'r4', title: '' } as unknown as WorkerRun;
  assert.deepEqual(runningRows({ worker: [...runs, unknown], drafts: [], conversations: [], checklists: new Map() }).map(r => r.key), ['w:r2', 'w:r3']);
});

test('ui/scout (7-1): the state endpoint is used only when its shape is right; Think now needs a mode other than Off and a state other than off or thinking; pre-fix is not pressable yet', () => {
  const state = { state: 'asleep', examined: 3, area: null, lastChangeAt: 5, note: null };
  assert.equal(isScoutState(state), true);
  for (const bad of [{}, null, { ...state, state: 'dreaming' }, { ...state, examined: '3' }, { ...state, note: 1 }]) assert.equal(isScoutState(bad), false, JSON.stringify(bad));
  assert.equal(canThinkNow({ ...state, state: 'asleep' } as never, 'research'), true);
  assert.equal(canThinkNow({ ...state, state: 'idle' } as never, 'research'), true);
  assert.equal(canThinkNow({ ...state, state: 'thinking' } as never, 'research'), false);
  assert.equal(canThinkNow({ ...state, state: 'off' } as never, 'research'), false);
  assert.equal(canThinkNow({ ...state, state: 'asleep' } as never, 'off'), false);
  assert.deepEqual(SCOUT_MODE_CHOICES.map(c => [c.mode, c.enabled]), [['off', true], ['research', true], ['fix', false]]);
});

test('ui/settings (7-1): the Scout row writes routing.scout and Off removes it; removing or renaming a model updates routing.scout too', () => {
  const config = { models: [{ id: 'a' }, { id: 'b' }], routing: { chat: ['a'], background: [] } } as Record<string, any>;
  assert.equal(scoutChoice(config), '', 'empty = Off');
  const set = setScout(config, 'b');
  assert.deepEqual(set.routing.scout, ['b']);
  assert.equal(scoutChoice(set), 'b');
  assert.deepEqual(setScout({ ...config, routing: { ...config.routing, scout: ['a', 'b'] } }, 'c').routing.scout, ['c', 'b'], 'like the judge: the pick replaces the first, the backups set in the file stay');
  const off = setScout(set, '');
  assert.equal('scout' in off.routing, false, 'Off removes the key');
  assert.deepEqual(removeModel(set, 'b').routing.scout, []);
  assert.deepEqual(renameModel(set, 'b', 'c').routing.scout, ['c']);
  assert.equal('scout' in removeModel(config, 'a').routing, false, 'no key is added when there was none');
});
