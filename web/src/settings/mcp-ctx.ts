import type { McpLimits } from '../api.ts';
import type { Access } from './access.ts';
import type { Config } from './model.ts';

// MCP の節の部品どうしで共有するもの（操作の通り道）。部品は、操作を直接は行わず、ここを通す
export interface McpCtx {
  // 保存済みの設定。広がる変更の確かめと、道具の申告の現在値に使う
  saved: Config;
  limits: McpLimits;
  // 操作中、または他の節に未保存の編集があるとき true（操作は止める）
  off: boolean;
  busy: boolean;
  // 広がる変更は、並べて確かめてから行う。空なら、そのまま行う
  guarded: (items: Access[], run: () => void) => void;
  // 操作を 1 つずつ行う。失敗は toast とカードの誤りの欄に出す。成功したら画面の状態と設定を読み直す。key はカードの id（追加フォームは '')
  run: (key: string, fn: () => Promise<unknown>, done?: string) => Promise<boolean>;
  // 操作の失敗をカードの誤りの欄から消す
  clear: (key: string) => void;
}
