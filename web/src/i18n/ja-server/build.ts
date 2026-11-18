import type { buildText } from '../../../../src/shared/messages/build.ts';
import type { JaTable } from './table.ts';

export const buildJa = {
  'no_plan': "まだ計画がありません。Build の前に計画を書いてください",
  'changed': "そのあいだに計画か受け入れの一覧が変わりました。読み直して、もう一度確かめてください",
  'running': "この製品の Build はもう動いています",
  'frozen': "受け入れの一覧はもう固定されています（版 {version}）。もう一度 Build する前に変えてください",
  'snapshot_taken': "Build の前の控え: {hash}。保存したファイルを取り戻すには `git -C \"{root}\" archive --format=zip --output=\"{archive}\" {hash}` を動かしてください。製品のフォルダの外に zip を書き、製品の中は何も変えません。zip を開いて、要るものを写し戻してください。.gitignore で外したファイルは控えに入らず、製品の .gitattributes が export-ignore にしたファイルは zip から外れます（export-subst にしたファイルは zip の中で書き換わります）。秘密らしいファイル・リンクしたファイル・道具の設定で禁止したフォルダは控えに入りません（控えは {ref} に残します）。",
  'snapshot_not_git': "このフォルダは git のリポジトリではないので、beat は Build の前の控えを取れません。控えなしで Build を続けます。",
  'snapshot_unavailable': "このフォルダでは beat が git を安全に使えなかったので、Build の前の控えは取っていません。控えなしで Build を続けます。",
  'snapshot_timeout': "Build の前の控えが {seconds} 秒より長くかかったので、控えなしで Build を続けます。",
  'snapshot_failed': "Build の前の控えに失敗したので、控えなしで Build を続けます。",
} satisfies JaTable<typeof buildText>;
