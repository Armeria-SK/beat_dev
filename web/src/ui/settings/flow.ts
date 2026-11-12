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

export function serial(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
}

export const hasUnsaved = (dirty: ReadonlyMap<string, boolean>): boolean => [...dirty.values()].some(Boolean);
