export interface Answer { confirm: () => void; cancel: () => void }

export function confirmable(open: (answer: Answer) => void, run: () => Promise<boolean>): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    open({
      confirm: () => { if (settled) return; settled = true; run().then(resolve, () => resolve(false)); },
      cancel: () => { if (settled) return; settled = true; resolve(false); },
    });
  });
}

export const SAVE_LIMIT_MS = 30_000;

export type Enqueue = <T>(job: (signal: AbortSignal) => Promise<T>) => Promise<T>;

export function serial(limitMs = SAVE_LIMIT_MS): Enqueue {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const start = () => new Promise<T>((resolve, reject) => {
      const stop = new AbortController();
      let timer = setTimeout(() => {
        stop.abort();
        timer = setTimeout(() => reject(new Error('Timed out')), limitMs);
      }, limitMs);
      job(stop.signal).then(resolve, reject).finally(() => clearTimeout(timer));
    });
    const next = tail.then(start, start);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
}

export async function checkThenRun<T>(
  enqueue: Enqueue,
  check: (signal: AbortSignal) => Promise<readonly T[]>,
  ask: (items: readonly T[], run: () => Promise<boolean>) => Promise<boolean>,
  run: (signal: AbortSignal) => Promise<boolean>,
): Promise<boolean> {
  const items = await enqueue(check);
  return items.length > 0 ? ask(items, () => enqueue(run)) : enqueue(run);
}

export const hasUnsaved = (dirty: ReadonlyMap<string, boolean>): boolean => [...dirty.values()].some(Boolean);

export const escAsksLeave = (e: { key: string; defaultPrevented: boolean }, unsaved: boolean): boolean => e.key === 'Escape' && !e.defaultPrevented && unsaved;
