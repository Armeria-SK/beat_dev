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

export function serial(limitMs = SAVE_LIMIT_MS): <T>(job: (signal: AbortSignal) => Promise<T>) => Promise<T> {
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

export const hasUnsaved = (dirty: ReadonlyMap<string, boolean>): boolean => [...dirty.values()].some(Boolean);

export const escAsksLeave = (e: { key: string; defaultPrevented: boolean }, unsaved: boolean): boolean => e.key === 'Escape' && !e.defaultPrevented && unsaved;
