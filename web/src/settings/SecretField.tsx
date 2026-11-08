import { useState } from 'react';
import { isComposing } from '../keys.ts';
import { trimKey } from './model.ts';

interface Props {
  label: string;
  placeholder: string;
  saveLabel: string;
  busyLabel: string;
  cancelLabel: string;
  busy: boolean;
  // 保存できない入力（空・形が違う）のとき true
  invalid?: boolean;
  // 保存する。成功したら呼び出し側がこの欄を閉じる（入れた値は、閉じるときにこの欄ごと消える）
  onSubmit: (value: string) => void;
  onCancel?: (() => void) | undefined;
  onEdit?: (() => void) | undefined;
}

// 秘密（URL・token）の入力欄。入れた値は、この欄の中にだけあり、保存したら画面に残さない（KeyField と同じふるまい）。
// 値の前後の空白・改行は取り除く（途中は触らない）
export function SecretField({ label, placeholder, saveLabel, busyLabel, cancelLabel, busy, invalid, onSubmit, onCancel, onEdit }: Props) {
  const [value, setValue] = useState('');
  const key = trimKey(value);
  const submit = () => { if (key !== '' && !busy && !invalid) onSubmit(key); };
  return (
    <div className="set-keyrow">
      <input
        type="password" className="input set-text mono" value={value} placeholder={placeholder} aria-label={label}
        autoComplete="new-password" spellCheck={false} disabled={busy}
        onChange={e => { setValue(e.target.value); onEdit?.(); }}
        onKeyDown={e => { if (e.key === 'Enter' && !isComposing({ isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) submit(); }}
      />
      <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || key === '' || invalid === true}>{busy ? busyLabel : saveLabel}</button>
      {onCancel && <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>{cancelLabel}</button>}
    </div>
  );
}