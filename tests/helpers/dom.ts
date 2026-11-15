import { listening, window, type Listening } from './dom-env.ts';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

export interface Rendered { container: HTMLElement; root: Root }

const mounted = new Set<Rendered>();
let before: Listening[] | null = null;

export async function render(node: ReactNode): Promise<Rendered> {
  before ??= [...listening];
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

export async function input(element: Element | null | undefined, value: string): Promise<void> {
  if (!(element instanceof window.HTMLInputElement || element instanceof window.HTMLTextAreaElement)) throw new Error('input: no input element');
  const proto = element instanceof window.HTMLInputElement ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

export function byText(container: ParentNode, selector: string, text: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>(selector)].find(el => el.textContent?.trim() === text);
}

export async function cleanup(): Promise<void> {
  const all = [...mounted];
  mounted.clear();
  let first: unknown;
  for (const { container, root } of all) {
    try { await act(async () => { root.unmount(); }); } catch (error) { first ??= error; }
    container.remove();
  }
  const kept = before;
  before = null;
  if (kept) for (const entry of listening.filter(entry => !kept.includes(entry))) removeEventListener(entry[0], entry[1], entry[2]);
  if (first !== undefined) throw first;
}

export const loadTsx = <T>(path: string, from: string): Promise<T> => import(new URL(path, from).href) as Promise<T>;
