// 入力欄の権限モード（段 8b）。会話ごとに覚える。新しい会話はいつも auto。
// auto: 確かめの一部を判定役の AI が決める / plan: 計画だけ（読む道具だけ使える）
export const PERMISSION_MODES = ['auto', 'plan'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

// 厳しさ: 計画 > 自動承認
const STRICTNESS: Record<PermissionMode, number> = { auto: 0, plan: 1 };

export const isPermissionMode = (value: unknown): value is PermissionMode => typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);

export const readMode = (value: unknown): PermissionMode => (isPermissionMode(value) ? value : 'auto');

export const stricterMode = (a: PermissionMode, b: PermissionMode): PermissionMode => (STRICTNESS[a] >= STRICTNESS[b] ? a : b);
