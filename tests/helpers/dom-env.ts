import { JSDOM } from 'jsdom';

export const { window } = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });

const source = window as unknown as Record<string, unknown>;
const replaced = new Set(['Event', 'CustomEvent', 'EventTarget']);

for (const key of Object.getOwnPropertyNames(window)) {
  if (key in globalThis && !replaced.has(key)) continue;
  Object.defineProperty(globalThis, key, { configurable: true, get: () => source[key] });
}
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
