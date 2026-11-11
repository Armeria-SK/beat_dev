export interface LegacyKey {
  path: string;
  removedIn: string;
}

export const LEGACY_KEYS: readonly LegacyKey[] = [
  { path: 'models[].toolMode', removedIn: 'beat 0-1' },
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dropPath(target: Record<string, unknown>, segments: readonly string[]): boolean {
  const [head, ...rest] = segments;
  if (head === undefined) return false;
  if (head.endsWith('[]')) {
    const list = target[head.slice(0, -2)];
    if (!Array.isArray(list)) return false;
    let dropped = false;
    for (const item of list) if (isObject(item) && dropPath(item, rest)) dropped = true;
    return dropped;
  }
  if (!rest.length) {
    if (!Object.hasOwn(target, head)) return false;
    delete target[head];
    return true;
  }
  const next = target[head];
  return isObject(next) ? dropPath(next, rest) : false;
}

export function dropLegacy(raw: unknown): { config: unknown; dropped: string[] } {
  if (!isObject(raw)) return { config: raw, dropped: [] };
  const config = structuredClone(raw);
  const dropped = LEGACY_KEYS.filter(key => dropPath(config, key.path.split('.'))).map(key => key.path);
  return dropped.length ? { config, dropped } : { config: raw, dropped };
}
