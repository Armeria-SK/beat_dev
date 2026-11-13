interface Lane { active: number; waiters: Array<() => void>; front: number }

export type EndpointSlot = (signal: AbortSignal) => Promise<() => void>;

export class EndpointLimiter {
  #lanes = new Map<string, Lane>();

  async acquire(key: string, limit: () => number, signal?: AbortSignal, front = false): Promise<() => void> {
    signal?.throwIfAborted();
    const lane = this.#lanes.get(key) ?? { active: 0, waiters: [], front: 0 };
    this.#lanes.set(key, lane);
    const capacity = () => { const value = limit(); return Number.isInteger(value) && value >= 1 && value <= 8 ? value : 1; };
    const pump = () => {
      while (lane.waiters.length && lane.active < capacity()) { lane.active++; if (lane.front > 0) lane.front--; lane.waiters.shift()!(); }
      if (!lane.active && !lane.waiters.length && this.#lanes.get(key) === lane) this.#lanes.delete(key);
    };
    const release = () => {
      let done = false;
      return () => { if (!done) { done = true; lane.active--; pump(); } };
    };
    if (!lane.waiters.length && lane.active < capacity()) { lane.active++; return release(); }
    await new Promise<void>((resolve, reject) => {
      const waiter = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
      const onAbort = () => {
        const index = lane.waiters.indexOf(waiter);
        if (index >= 0) { lane.waiters.splice(index, 1); if (index < lane.front) lane.front--; }
        pump(); reject(signal!.reason);
      };
      if (front) lane.waiters.splice(lane.front++, 0, waiter);
      else lane.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    return release();
  }
}
