import { useEffect, useRef, useState } from 'react';
import { subscribe } from '../feedback.ts';
import { Button, Icon, ToastStack } from './parts.tsx';
import {
  dropToast, leaveToast, pauseClock, pushToast, resumeClock, startClock, TOAST_A, TOAST_B, TOAST_LEAVE_MS, toastDuration, type ToastClock, type ToastEntry,
} from './toast-list.ts';
import { variant } from './variants.ts';

interface Running { clock: ToastClock; timer: ReturnType<typeof setTimeout> | null }

export function Toasts() {
  const limits = import.meta.env.DEV && variant('toast') === 'b' ? TOAST_B : TOAST_A;
  const [list, setList] = useState<ToastEntry[]>([]);
  const nextId = useRef(1);
  const clocks = useRef(new Map<number, Running>());
  const leaving = useRef(new Set<ReturnType<typeof setTimeout>>());
  const held = useRef(false);

  const dismiss = (id: number) => {
    const running = clocks.current.get(id);
    if (running?.timer) clearTimeout(running.timer);
    clocks.current.delete(id);
    setList(current => leaveToast(current, id));
    const timer = setTimeout(() => { leaving.current.delete(timer); setList(current => dropToast(current, id)); }, TOAST_LEAVE_MS);
    leaving.current.add(timer);
  };
  const arm = (id: number, running: Running) => {
    running.timer = setTimeout(() => dismiss(id), running.clock.remaining);
  };
  const hold = (on: boolean) => {
    held.current = on;
    const now = performance.now();
    for (const [id, running] of clocks.current) {
      if (running.timer) clearTimeout(running.timer);
      running.timer = null;
      running.clock = on ? pauseClock(running.clock, now) : resumeClock(running.clock, now);
      if (!on) arm(id, running);
    }
  };
  const act = useRef({ dismiss, arm });
  act.current = { dismiss, arm };

  useEffect(() => {
    const stop = subscribe(item => {
      const id = nextId.current++;
      const now = performance.now();
      const running: Running = { clock: startClock(toastDuration(item, limits), now), timer: null };
      if (held.current) running.clock = pauseClock(running.clock, now); else act.current.arm(id, running);
      clocks.current.set(id, running);
      setList(current => {
        const next = pushToast(current, { id, item, leaving: false }, limits.max);
        for (const dropped of current) {
          if (next.some(e => e.id === dropped.id)) continue;
          const old = clocks.current.get(dropped.id);
          if (old?.timer) clearTimeout(old.timer);
          clocks.current.delete(dropped.id);
        }
        return next;
      });
    });
    const running = clocks.current;
    const pending = leaving.current;
    return () => {
      stop();
      for (const r of running.values()) if (r.timer) clearTimeout(r.timer);
      running.clear();
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, [limits]);

  return (
    <div className="ui-toasts" data-toasts={limits.tag}
      onPointerEnter={() => hold(true)} onPointerLeave={() => hold(false)}
      onFocus={() => hold(true)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) hold(false); }}>
      <ToastStack>
        {list.map(({ id, item, leaving: isLeaving }) => {
          const body = (
            <>
              <p className="bt-toast__title">{item.title}</p>
              {item.body && <p className="bt-toast__text">{item.body}</p>}
            </>
          );
          return (
            <div key={id} className={`bt-toast${isLeaving ? ' is-leaving' : ''}`}>
              {item.lead === 'dot' ? <span className="bt-dot" aria-hidden="true" /> : <Icon name={item.icon ?? 'check'} className={item.icon === 'alert' ? 'ui-danger' : undefined} />}
              {item.href
                ? <a className="bt-toast__body ui-toast__link" href={item.href} onClick={() => dismiss(id)}>{body}</a>
                : <div className="bt-toast__body">{body}</div>}
              {item.action && <Button small icon="undo" disabled={isLeaving} onClick={() => { item.action!.run(); dismiss(id); }}>{item.action.label}</Button>}
            </div>
          );
        })}
      </ToastStack>
    </div>
  );
}
