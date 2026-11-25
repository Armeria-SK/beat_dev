import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import { useT } from '../i18n/index.ts';
import { answerText, askStep, choose, emptyPick, type AskPick, type OpenAsk } from './ask.ts';
import { Button } from './parts.tsx';

export function AskCard({ ask, busy, onAnswer }: { ask: OpenAsk; busy: boolean; onAnswer: (text: string) => void }) {
  const t = useT();
  const name = useId();
  const group = useRef<HTMLFieldSetElement>(null);
  const [picks, setPicks] = useState<AskPick[]>(() => ask.questions.map(emptyPick));
  const [step, setStep] = useState(0);
  const set = (index: number, next: AskPick) => setPicks(current => current.map((p, i) => (i === index ? next : p)));
  const s = askStep(ask.questions, picks, step);
  const qi = s.index;

  // 問いが替わったら、新しい問いの組へフォーカスを移す。押したボタンが消えても body に落ちず、
  // キーボードの連打の 2 回目が、同じ場所に残った（または出た）ボタンに当たらない。最初に出たときは動かさない。
  const shown = useRef(qi);
  useEffect(() => {
    if (shown.current === qi) return;
    shown.current = qi;
    group.current?.focus();
  }, [qi]);

  const q = ask.questions[qi];
  if (!q) return null;
  const pick = picks[qi] ?? emptyPick();
  const type = q.multiSelect ? 'checkbox' : 'radio';
  // Next のダブルクリックの 2 回目（detail 2）は、同じ場所に出た Answer に当たる。それでは送らない。
  const send = (e: MouseEvent<HTMLButtonElement>) => { if (e.detail <= 1) onAnswer(answerText(ask.questions, picks, t('ui.ask.lead'))); };
  return (
    <section className="bt-card ui-pinned ui-ask bt-rise" aria-label={t('ui.ask.head')} data-ask={ask.key}>
      <div className="bt-card__head">
        <span className="bt-card__kind"><span className="bt-dot" aria-hidden="true" /><span className="bt-label">{t('ui.ask.head')}</span></span>
        {s.total > 1 && <span className="bt-meta ui-ask__step" aria-live="polite">{t('ui.ask.step', qi + 1, s.total)}</span>}
      </div>
      <div className="ui-ask__body">
        <div key={qi} className="bt-question ui-ask__q">
          <div className="ui-ask__chips"><span className="bt-label ui-ask__header">{q.header}</span>{q.multiSelect && <span className="bt-meta">{t('ui.ask.multi')}</span>}</div>
          <h3 className="bt-question__q">{q.question}</h3>
          <fieldset ref={group} tabIndex={-1} className="bt-choices" disabled={busy} aria-label={q.question}>
            {q.options.map(option => (
              <label key={option.label} className="bt-choice">
                <input type={type} name={`${name}-${qi}`} checked={pick.labels.includes(option.label)} onChange={() => set(qi, choose(q, pick, option.label))} />
                <span className="ui-ask__option"><span>{option.label}</span>{option.description && <span className="bt-meta">{option.description}</span>}</span>
              </label>
            ))}
            <label className="bt-choice">
              <input type={type} name={`${name}-${qi}`} checked={pick.other} onChange={() => set(qi, choose(q, pick, null))} />
              <span>{t('ui.q.other')}</span>
            </label>
            {pick.other && (
              <textarea className="bt-field ui-ask__other" aria-label={t('ui.q.otherField')} placeholder={t('ui.q.otherField')} rows={2} maxLength={4000} value={pick.text} onChange={e => set(qi, { ...pick, text: e.target.value })} />
            )}
          </fieldset>
        </div>
      </div>
      <div className="bt-card__actions ui-ask__actions">
        {!s.first && <Button key="back" variant="ghost" small disabled={busy} onClick={() => setStep(qi - 1)}>{t('ui.ask.back')}</Button>}
        {s.last ? (
          <Button key="answer" variant="primary" small disabled={busy || !s.canSend} onClick={send}>{t('ui.ask.answer')}</Button>
        ) : (
          <Button key="next" variant="primary" small disabled={busy || !s.canNext} onClick={() => setStep(qi + 1)}>{t('ui.ask.next')}</Button>
        )}
        <span className="bt-meta">{s.last ? t('ui.ask.consequence') : t('ui.ask.consequenceStep')}</span>
      </div>
    </section>
  );
}
