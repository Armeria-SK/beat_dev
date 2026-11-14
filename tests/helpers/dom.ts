import { JSDOM } from 'jsdom';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
const host = globalThis as Record<string, unknown>;

for (const key of Object.getOwnPropertyNames(window)) {
  if (key in globalThis) continue;
  Object.defineProperty(globalThis, key, { configurable: true, get: () => (window as unknown as Record<string, unknown>)[key] });
}
host.IS_REACT_ACT_ENVIRONMENT = true;

export interface Rendered { container: HTMLElement; root: Root }

const mounted = new Set<Rendered>();

export async function render(node: ReactNode): Promise<Rendered> {
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container);
  const rendered = { container, root };
  mounted.add(rendered);
  await act(async () => { root.render(node); });
  return rendered;
}

export async function update(run: () => void | Promise<void>): Promise<void> {
  await act(async () => { await run(); });
}

export async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('click: no element');
  await act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
}

export function byText(container: ParentNode, selector: string, text: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>(selector)].find(el => el.textContent?.trim() === text);
}

export async function cleanup(): Promise<void> {
  for (const { container, root } of mounted) {
    await act(async () => { root.unmount(); });
    container.remove();
  }
  mounted.clear();
}

export const loadTsx = <T>(path: string, from: string): Promise<T> => import(new URL(path, from).href) as Promise<T>;
