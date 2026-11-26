import { useEffect, useState } from 'react';
import { api, type RuntimeView } from '../api.ts';
import { useT } from '../i18n/index.ts';
import { Notice } from './parts.tsx';
import { NAME, PERM_LABEL } from './settings/runtimes.tsx';

// 外の実行役の会話の上の注意書き（AR-10）: どの実行役か・いまの許可の設定・beat の判定役は働かないこと。許可の設定が読めないときは、そこだけ出さない
export function RuntimeNote({ runtimeId }: { runtimeId: string }) {
  const t = useT();
  const [view, setView] = useState<RuntimeView | null>(null);
  useEffect(() => {
    let live = true;
    setView(null);
    void api.runtimes().then(r => { if (live) setView(r.runtimes.find(item => item.id === runtimeId) ?? null); }).catch(() => undefined);
    return () => { live = false; };
  }, [runtimeId]);
  const name = view ? t(NAME[view.kind]) : runtimeId;
  const permission = view ? (PERM_LABEL[view.permission] ? t(PERM_LABEL[view.permission]!) : view.permission) : null;
  return (
    <div role="note" data-runtime-note={runtimeId}>
      <Notice title={permission ? t('ui.conv.runtimeTitle', name, permission) : t('ui.conv.runtimeTitleNoPermission', name)} text={t('ui.conv.runtimeText')} />
    </div>
  );
}
