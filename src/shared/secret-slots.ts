import { keyProblem, type KeyProblem } from './provider-key.ts';
import { isSafeOutboundUrl } from './url.ts';

// 画面から値を入れる「秘密の欄」の決まり（画面とサーバーが同じに使う。node の部品は使わない）。
// 環境変数の名前はサーバーが決める（クライアントからは受け取らない）。値は .env にだけ書き、設定には名前だけを書く
export type NotifySecretField = 'url' | 'token';

export function notifyEnvName(id: string, field: NotifySecretField): string {
  const base = `BEAT_NOTIFY_${id.toUpperCase().replaceAll('-', '_')}`;
  return field === 'url' ? `${base}_URL_SECRET` : `${base}_TOKEN`;
}

// 自動で付けた名前か。持ち主が自分で書いた名前（別の変数を指している）は、消さない・作り替えないために区別する
export function isAutoNotifyEnv(id: string, field: NotifySecretField, name: string): boolean {
  return name === notifyEnvName(id, field);
}

export type SecretProblem = KeyProblem | 'bad_url';

// 秘密の値の検査。URL の欄はさらに、https か、この PC（ループバック）の http だけ
export function secretProblem(field: NotifySecretField, value: string): SecretProblem | undefined {
  const base = keyProblem(value);
  if (base) return base;
  if (field === 'url' && !isSafeOutboundUrl(value)) return 'bad_url';
  return undefined;
}

// 外の MCP サーバーの秘密の欄（子に渡す環境変数 env・HTTP の見出し header）。id は英小文字と数字だけなので、名前から id が一意に読める
export type McpSecretKind = 'env' | 'header';

export function mcpEnvPrefix(id: string): string {
  return `BEAT_MCP_${id.toUpperCase()}_`;
}

// BEAT_MCP_<ID>_<E|H>_<NAME>_SECRET（最大 63 文字。SECRET を含むので、鍵の名前の決まりを満たす）
export function mcpEnvName(id: string, kind: McpSecretKind, name: string): string {
  return `${mcpEnvPrefix(id)}${kind === 'env' ? 'E' : 'H'}_${name.toUpperCase().replaceAll('-', '_')}_SECRET`;
}

export function isAutoMcpEnv(id: string, kind: McpSecretKind, name: string, variable: string): boolean {
  return variable === mcpEnvName(id, kind, name);
}