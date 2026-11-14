import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rootsLister } from '../src/projects/run.ts';

test('製品の一覧を取る関数: 一覧が読めなくなっても、それまでに見たフォルダを返す', () => {
  let rows: Array<{ root: string }> | undefined = [{ root: 'C:/work/a' }];
  const projects = {
    list: (options?: { archived?: boolean }) => {
      if (!rows) throw new Error('closed');
      return options?.archived ? [{ root: 'C:/work/old' }] : rows;
    },
  };
  const roots = rootsLister(projects);
  assert.deepEqual(roots(), ['C:/work/a', 'C:/work/old']);
  rows = [{ root: 'C:/work/b' }];
  assert.deepEqual(roots(), ['C:/work/a', 'C:/work/old', 'C:/work/b']);
  rows = undefined;
  assert.deepEqual(roots(), ['C:/work/a', 'C:/work/old', 'C:/work/b']);
  assert.deepEqual(rootsLister(undefined)(), []);
});
