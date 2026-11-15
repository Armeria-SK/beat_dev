export type MeshQuestionKind = 'location' | 'plan' | 'control';

export interface MeshQuestion {
  id: string;
  kind: MeshQuestionKind;
  lang: 'ja' | 'es';
  text: string;
  answers: readonly string[];
  mapRow?: string;
  stale?: string;
}

export const PRODUCT_NAME = 'bento';

export const PRODUCT_FILES: Readonly<Record<string, string>> = {
  'README.md': '# bento\n\nLunch pre-orders for office teams.\n',
  'AGENTS.md': '# bento\n\nRun the tests with `npm test`. Keep prices in yen as integers.\n',
  'package.json': '{ "name": "bento", "private": true, "type": "module" }\n',
  'server/routes/orders.ts': 'export function orderRoutes() { return ["POST /api/orders", "GET /api/orders/:id"]; }\n',
  'server/routes/menu.ts': 'export function menuRoutes() { return ["GET /api/menu"]; }\n',
  'server/db/schema.ts': 'export const ORDERS_TABLE = "CREATE TABLE orders (id TEXT PRIMARY KEY, team TEXT, total INTEGER, placed_at TEXT)";\nexport const MENU_TABLE = "CREATE TABLE menu (id TEXT PRIMARY KEY, name TEXT, price INTEGER)";\n',
  'server/db/migrations.ts': 'export const MIGRATIONS = ["001_orders", "002_menu"];\n',
  'server/payments/charge.ts': 'export async function charge(orderId: string, amount: number) { return { orderId, amount }; }\n',
  'server/payments/refunds.ts': 'export async function refund(orderId: string, reason: string) { return { orderId, reason, refunded: true }; }\n',
  'server/mail/receipt.ts': 'export function receiptMail(orderId: string, total: number) { return `Order ${orderId}: ${total} yen`; }\n',
  'server/coupons/apply.ts': 'export function applyCoupon(total: number, code: string) { return code === "LUNCH10" ? Math.round(total * 0.9) : total; }\n',
  'jobs/cleanup.ts': 'export function nightlyCleanup() { return "delete orders older than 90 days"; }\n',
  'web/screens/MenuList.tsx': 'export function MenuList() { return null; }\n',
  'web/screens/Checkout.tsx': 'export function Checkout() { return null; }\n',
  'web/components/CartBadge.tsx': 'export function CartBadge(props: { count: number }) { return props.count; }\n',
  'web/i18n/ja.ts': 'export const ja = { checkout: "注文する" };\n',
  'tests/orders.test.ts': 'import "../server/routes/orders.ts";\n',
};

export const PRODUCT_CHANGES: ReadonlyArray<{ from: string; to: string; content?: string }> = [
  { from: 'server/coupons/apply.ts', to: 'server/discounts/apply.ts' },
  { from: 'jobs/cleanup.ts', to: 'jobs/daily-report.ts', content: 'export function dailyOrderReport() { return "orders per team for the kitchen, every night at 21:00"; }\n' },
];

export const PLAN_TEXT = [
  '# Bento: lunch pre-orders for office teams',
  '',
  'Goal: office teams pre-order lunch by 10:00 and pay in one step.',
  '',
  '## Milestones',
  '1. Menu API and the menu list screen (done)',
  '2. Checkout with card payment (done)',
  '3. Move the coupon logic out of the old folder (in progress)',
  '4. Allergy labels on the menu API, then an allergy filter on the menu list (next)',
  '5. A nightly order report for the kitchen (done, replaced the old cleanup job)',
  '',
].join('\n');

export const STATE_NOTES = {
  goal: 'Office teams pre-order lunch by 10:00 and pay in one step',
  now: 'Moving the coupon logic into server/discounts',
  next: 'Add allergy labels to the menu API',
} as const;

export const FILLER: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }> = [
  { role: 'user', text: 'お弁当の一覧画面の写真が小さすぎる。もう少し大きくしてほしい。' },
  { role: 'assistant', text: '一覧の写真を 1.5 倍にしました。スマホの幅では 1 列に並ぶようにしています。' },
  { role: 'user', text: '昨日、同じ注文が 2 回請求された人がいたみたい。見てくれる？' },
  { role: 'assistant', text: 'カードの請求を送る前に、同じ注文の請求がもう済んでいないかを確かめるようにしました。2 回目の請求は返金しました。' },
  { role: 'user', text: 'ありがとう。領収書のメールに合計の金額が出ていないって言われた。' },
  { role: 'assistant', text: '領収書のメールに合計の金額と注文の番号を足しました。' },
  { role: 'user', text: 'クーポンの仕組み、割引の計算と一緒にして整理したい。前に話したとおりで進めて。' },
  { role: 'assistant', text: 'クーポンの処理を割引の置き場に移し始めました。古いフォルダの名前は変えました。まだ途中です。' },
  { role: 'user', text: '夜の片付けの処理はもう要らない。代わりに台所向けの毎晩の集計を作って。' },
  { role: 'assistant', text: '夜の片付けの処理をやめて、チームごとの注文の数を毎晩 21 時に集計する処理に置き換えました。' },
  { role: 'user', text: '次はアレルギーの表示をやりたい。メニューの API から始めて。' },
  { role: 'assistant', text: '分かりました。メニューの API にアレルギーの項目を足すところから始めます。' },
  { role: 'user', text: 'カートの数が 0 のときにバッジが残る不具合もあったよね。あれは直った？' },
  { role: 'assistant', text: 'はい、数が 0 のときはバッジを出さないようにしました。' },
];

export const MESH_QUESTIONS: readonly MeshQuestion[] = [
  { id: 'L1', kind: 'location', lang: 'ja', text: '注文の表の形（列）を決めているファイルはどれ？パスで教えて。', answers: ['server/db/schema.ts'], mapRow: 'server/db' },
  { id: 'L2', kind: 'location', lang: 'ja', text: '返金の処理はどのファイルに書いてある？', answers: ['server/payments/refunds.ts'], mapRow: 'server/payments' },
  { id: 'L3', kind: 'location', lang: 'ja', text: 'カートの数を出しているバッジの部品はどのファイル？', answers: ['web/components/CartBadge.tsx'], mapRow: 'web/components' },
  { id: 'L4', kind: 'location', lang: 'ja', text: 'クーポンの割引を計算しているのは、いまどのファイル？', answers: ['server/discounts/apply.ts'], mapRow: 'server/discounts', stale: 'server/coupons' },
  { id: 'L5', kind: 'location', lang: 'es', text: '¿Qué archivo genera el informe diario de pedidos para la cocina?', answers: ['jobs/daily-report.ts'], mapRow: 'jobs', stale: 'cleanup.ts' },
  { id: 'L6', kind: 'location', lang: 'ja', text: '注文を受け付ける API の入口はどのファイル？', answers: ['server/routes/orders.ts'], mapRow: 'server/routes' },
  { id: 'P1', kind: 'plan', lang: 'ja', text: '次にやることは何だっけ？', answers: ['アレルギー', 'allerg'] },
  { id: 'P2', kind: 'plan', lang: 'ja', text: 'いま何の作業の途中？', answers: ['クーポン', '割引', 'coupon', 'discount'] },
  { id: 'P3', kind: 'plan', lang: 'es', text: '¿Cuál es el objetivo del plan de este producto?', answers: ['10:00', '10 h', '10h', 'diez'] },
  { id: 'K1', kind: 'control', lang: 'ja', text: 'アレルギーで絞り込む画面の部品はどのファイル？', answers: [] },
  { id: 'K2', kind: 'control', lang: 'ja', text: 'ポイントカードの残高を計算しているファイルはどれ？', answers: [] },
  { id: 'K3', kind: 'control', lang: 'es', text: '¿Qué archivo envía las notificaciones push a los móviles?', answers: [] },
];
