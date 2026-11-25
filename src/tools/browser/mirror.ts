// Browser の欄（持ち主の画面だけ）に配る、タブの画面の写し。会話ごとに最後の 1 枚だけを覚え、ディスクに書かない。モデルには渡さない（D-9）
// 撮るのは session.ts: 操作（開く・押す・入れる・読む）のある呼び出しの終わりに 1 枚（ロックの中）と、見ている人がいて動いているあいだの一定間隔（ロックが空いているときだけ）
import type { ElementTarget, FocusFacts, PageHandle } from './driver.ts';

// 動いているとみなす、最後の操作からの時間
export const DRIVING_MS = 60_000;
// 動いているあいだの撮影の間隔（A-5: 1280×800 の撮影 1 回は本物の Chrome で中央 22ms・最大 75ms）
export const SHOT_INTERVAL_MS = 2_000;
// 欄が読みに来てから、一定間隔の撮影を続ける時間（欄は開いているあいだ 1 秒ごとに読む）
export const WATCH_MS = 5_000;
// 撮影 1 回を待つ上限（越えたら、その 1 枚は捨てる）
export const SHOT_TIMEOUT_MS = 5_000;
const NAME_MAX = 60;
// 欄に出す題と URL の上限（ページが何 MB の題を付けても、読みのたびに送り直さない）
export const TITLE_MAX = 200;
export const URL_MAX = 2048;

export type MirrorActionKind = 'open' | 'click' | 'type' | 'read' | 'screenshot';
// いまの操作。target は押す・入れる要素の名前（無ければ役割）、開く URL のホスト。画面の言葉にするのは欄（9-2b）
export interface MirrorAction { kind: MirrorActionKind; target: string }

export interface MirrorFrame { seq: number; at: number; mediaType: 'image/png'; data: Buffer }

// 画面に出す短い文字: 制御文字・書式の文字（向きの上書きなど）を落とし、空白を 1 つにまとめ、max 文字まで（既定 60）
export function shortLabel(text: string, max = NAME_MAX): string {
  const clean = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : clean;
}

const elementLabel = (target: ElementTarget): string => shortLabel(target.name) || shortLabel(target.role);
const hostLabel = (url: string): string => { try { return shortLabel(new URL(url).host); } catch { return ''; } };

// 同じ呼び出しの中では、強い操作の言葉を残す（開いたあとの読み直しで「open」を「read」にしない）
const RANK: Record<MirrorActionKind, number> = { screenshot: 0, read: 1, open: 2, type: 3, click: 3 };
export function strongerAction(before: MirrorAction | undefined, next: MirrorAction): MirrorAction {
  return before !== undefined && RANK[before.kind] > RANK[next.kind] ? before : next;
}

// ページの操作を見張る写し。道具が呼ぶ操作の前に note。ほかは元のページそのまま（欄の画像は、呼び出しの終わりに session.ts が撮る）
export function observePage(page: PageHandle, note: (action: MirrorAction) => void): PageHandle {
  return new Proxy(page, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      switch (prop) {
        case 'goto': return (url: string, timeoutMs: number) => { note({ kind: 'open', target: hostLabel(url) }); return target.goto(url, timeoutMs); };
        case 'click': return (element: ElementTarget, timeoutMs: number) => { note({ kind: 'click', target: elementLabel(element) }); return target.click(element, timeoutMs); };
        case 'fill': return (element: ElementTarget, text: string, submit: boolean, timeoutMs: number) => { note({ kind: 'type', target: elementLabel(element) }); return target.fill(element, text, submit, timeoutMs); };
        // 選ぶは「押す」の言葉、鍵は「入れる」の言葉で映す（欄の言葉は増やさない）
        case 'select': return (element: ElementTarget, label: string, timeoutMs: number) => { note({ kind: 'click', target: elementLabel(element) }); return target.select(element, label, timeoutMs); };
        case 'press': return (key: string, expected: FocusFacts, timeoutMs: number) => { note({ kind: 'type', target: '' }); return target.press(key, expected, timeoutMs); };
        case 'text': return (maxChars: number) => { note({ kind: 'read', target: '' }); return target.text(maxChars); };
        case 'snapshot': return () => { note({ kind: 'read', target: '' }); return target.snapshot(); };
        case 'screenshot': return () => { note({ kind: 'screenshot', target: '' }); return target.screenshot(); };
        default: return (value as (...args: unknown[]) => unknown).bind(target);
      }
    },
  });
}

interface Slot { tabId: string; frame: MirrorFrame; token: number }

// 会話ごとの最後の 1 枚。token は撮り始めた順（あとから始めた撮影の画像を、先に始めて遅れて終わった撮影で上書きしない）
export class MirrorFrames {
  #slots = new Map<string, Slot>();
  #seq = 0;
  #token = 0;

  begin(): number { return ++this.#token; }

  store(conversationId: string, tabId: string, token: number, data: Buffer, at: number): void {
    const slot = this.#slots.get(conversationId);
    if (slot && slot.token > token) return;
    this.#slots.set(conversationId, { tabId, token, frame: { seq: ++this.#seq, at, mediaType: 'image/png', data } });
  }

  // そのタブの最後の 1 枚（会話の最後の 1 枚がほかのタブのものなら無い）
  frame(conversationId: string, tabId: string): MirrorFrame | undefined {
    const slot = this.#slots.get(conversationId);
    return slot?.tabId === tabId ? slot.frame : undefined;
  }

  forgetTab(tabId: string): void {
    for (const [conversationId, slot] of this.#slots) if (slot.tabId === tabId) this.#slots.delete(conversationId);
  }

  clear(): void { this.#slots.clear(); }
}
