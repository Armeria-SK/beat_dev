import { JSDOM } from 'jsdom';

export const { window } = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });

const source = window as unknown as Record<string, unknown>;
const replaced = new Set(['Event', 'CustomEvent', 'EventTarget']);

for (const key of Object.getOwnPropertyNames(window)) {
  if (key in globalThis && !replaced.has(key)) continue;
  Object.defineProperty(globalThis, key, { configurable: true, get: () => source[key] });
}
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// navigator は Node のもの（OS の言語）が残る。説明の言語の Auto が PC ごとに変わらないよう、言語の並びは jsdom のもの（en-US）にする
Object.defineProperty(globalThis.navigator, 'languages', { configurable: true, get: () => window.navigator.languages });

export type Listening = readonly [type: string, listener: EventListenerOrEventListenerObject, capture: boolean];
export const listening: Listening[] = [];
const captures = (options?: boolean | EventListenerOptions) => (typeof options === 'boolean' ? options : options?.capture === true);
const at = (type: string, listener: EventListenerOrEventListenerObject, capture: boolean) => listening.findIndex(([t, l, c]) => t === type && l === listener && c === capture);

Object.assign(globalThis, {
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
    window.addEventListener(type, listener, options);
    if (at(type, listener, captures(options)) < 0) listening.push([type, listener, captures(options)]);
  },
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) {
    window.removeEventListener(type, listener, options);
    const i = at(type, listener, captures(options));
    if (i >= 0) listening.splice(i, 1);
  },
});
