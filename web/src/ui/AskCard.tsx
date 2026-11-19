import { useId, useState } from 'react';
import { useT } from '../i18n/index.ts';
import { answerText, choose, complete, emptyPick, type AskPick, type OpenAsk } from './ask.ts';
import { Button } from './parts.tsx';

export function AskCard({ ask, busy, onAnswer }: { ask: OpenAsk; busy: boolean; onAnswer: (text: string) => void }) {
  const t = useT();
  const name = useId();
  const [picks, setPicks] = useState<AskPick[]>(() => ask.questions.map(emptyPick));
  const set = (index: number, next: AskPick) => setPicks(current => current.map((p, i) => (i === index ? next : p)));
  const ready = complete(ask.questions, picks);
  return (
    <section className="bt-card ui-pinned ui-ask bt-rise" aria-label={t('ui.ask.head')} data-ask={ask.key}>
      <div className="bt-card__head">
        <span className="bt-card__kind"><span className="bt-dot" aria-hidden="true" /><span className="bt-label">{t('ui.ask.head')}</span></span>
      </div>
      <div className="ui-ask__body">
        {ask.questions.map((q, qi) => {
          const pick = picks[qi] ?? emptyPick();
          const type = q.multiSelect ? 'checkbox' : 'radio';
          return (
            <div key={qi} className="bt-question ui-ask__q">
              <div className="ui-ask__chips"><span className="bt-label ui-ask__header">{q.header}</span>{q.multiSelect && <span className="bt-meta">{t('ui.ask.multi')}</span>}</div>
              <h3 className="bt-question__q">{q.question}</h3>
              <fieldset className="bt-choices" disabled={busy} aria-label={q.question}>
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
          );
        })}
      </div>
      <div className="bt-card__actions ui-ask__actions">
        <Button variant="primary" small disabled={busy || !ready} onClick={() => onAnswer(answerText(ask.questions, picks, t('ui.ask.lead')))}>{t('ui.ask.answer')}</Button>
        <span className="bt-meta">{t('ui.ask.consequence')}</span>
      </div>
    </section>
  );
}
