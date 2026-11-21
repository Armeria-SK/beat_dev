import type { AskKind } from '../types.ts';

// 許可の一覧（allowlist*.ts）が、ふつうの確かめ（level 'ask'）として返す理由のキー → 確かめの種類（段 8b）。
// ここに無いキーは precheck（細かい種類なし）。種類は承認の依頼に kinds として運ぶ（pipeline.ts の順 4〔製品の中で動かす〕の判定などに使う）。
// 判定役に回すかは種類では決めない: pipeline.ts が、持ち主の鍵・方針の鍵・送る/消す・フックの確かめを持ち主の Pending に、断る鍵を拒否にし、
// 残りの確かめは種類に関わらず（code・precheck・egress も）自動承認の判定役に回す
export const ASK_REASON_KINDS: Readonly<Record<string, AskKind>> = {
  'ask.service': 'risky_command',
  'ask.git_remote': 'risky_command',
  'ask.package': 'egress',
  'ask.npx': 'egress',
  'ask.system_package': 'egress',
  'ask.curl': 'egress',
  'ask.wget': 'egress',
  'ask.powershell': 'egress',
  'ask.remote': 'egress',
  'ask.git_push': 'egress',
  'ask.gh': 'egress',
  'ask.container': 'egress',
  'list.lan': 'egress',
  'list.long_query': 'egress',
  'list.git_push': 'egress',
  'list.git_write': 'git_write',
  'list.git_identity': 'git_write',
};

export const askKindOf = (key: string): AskKind => ASK_REASON_KINDS[key] ?? 'precheck';
