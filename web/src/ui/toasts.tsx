import { useEffect, useRef, useState } from 'react';
import { subscribe } from '../feedback.ts';
import { Button, Icon, ToastStack } from './parts.tsx';
import { dropToast, leaveToast, pushToast, TOAST_LEAVE_MS, toastDuration, type ToastEntry } from './toast-list.ts';

export function Toasts() {
  const [list, setList] = useState<ToastEntry[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const later = (run: () => void, ms: number) => {
      const timer = setTimeout(() => { timers.current.delete(timer); run(); }, ms);
      timers.current.add(timer);
    };
    const dismiss = (id: number) => {
      setList(current => leaveToast(current, id));
      later(() => setList(current => dropToast(current, id)), TOAST_LEAVE_MS);
    };
    const stop = subscribe(item => {
      const id = nextId.current++;
      setList(current => pushToast(current, { id, item, leaving: false }));
      later(() => dismiss(id), toastDuration(item));
    });
    const pending = timers.current;
    return () => { stop(); for (const timer of pending) clearTimeout(timer); pending.clear(); };
  }, []);

  return (
    <div className="ui-toasts">
      <ToastStack>
        {list.map(({ id, item, leaving }) => (
          <div key={id} className={`bt-toast${leaving ? ' is-leaving' : ''}`}>
            <Icon name={item.icon ?? 'check'} />
            <div className="bt-toast__body">
              <p className="bt-toast__title">{item.title}</p>
              {item.body && <p className="bt-toast__text">{item.body}</p>}
            </div>
            {item.action && <Button small onClick={() => { item.action!.run(); setList(current => dropToast(current, id)); }}>{item.action.label}</Button>}
          </div>
        ))}
      </ToastStack>
    </div>
  );
}
