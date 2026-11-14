import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { confirmable, escAsksLeave, hasUnsaved, serial, type Answer } from '../web/src/ui/settings/flow.ts';

// Settings の保存の流れ（1-5b のセキュリティ審査の直し）。確かめを挟んだ保存が「確かめたあとの結果」で終わること、
// 同時の保存が 1 つずつ順に走ること（互いに上書きしない）、書きかけがあれば閉じる前に聞くこと。

test('ui/settings flow: 確かめを挟んだ操作は、Confirm のあとの結果で終わる（秘密の欄を空にする・Add の行を閉じるのはこの結果を見る）', async () => {
  let answer: Answer | null = null;
  let runs = 0;
  const done = confirmable(a => { answer = a; }, async () => { runs += 1; return true; });
  answer!.confirm();
  answer!.confirm();
  assert.equal(await done, true);
  assert.equal(runs, 1, '2 回押しても 1 回だけ');
  const failed = confirmable(a => { a.confirm(); }, async () => false);
  assert.equal(await failed, false);
  const thrown = confirmable(a => { a.confirm(); }, async () => { throw new Error('x'); });
  assert.equal(await thrown, false);
});

test('ui/settings flow: Cancel や区分の切り替えで閉じた確かめは false で終わり、操作は走らない', async () => {
  let runs = 0;
  const cancelled = confirmable(a => { a.cancel(); a.confirm(); }, async () => { runs += 1; return true; });
  assert.equal(await cancelled, false);
  assert.equal(runs, 0);
});

test('ui/settings flow: 保存は 1 つずつ順に走る（前の保存が終わってから、次が最新を読み直す）。失敗しても次は走る', async () => {
  const enqueue = serial();
  const log: string[] = [];
  let release: () => void = () => undefined;
  const first = enqueue(() => new Promise<string>(resolve => { log.push('a:start'); release = () => { log.push('a:end'); resolve('a'); }; }));
  const second = enqueue(async () => { log.push('b:start'); return 'b'; });
  const third = enqueue(async () => { log.push('c:start'); throw new Error('c'); });
  const fourth = enqueue(async () => { log.push('d:start'); return 'd'; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(log, ['a:start'], 'a が終わるまで b は始まらない');
  release();
  assert.equal(await first, 'a');
  assert.equal(await second, 'b');
  await assert.rejects(third);
  assert.equal(await fourth, 'd');
  assert.deepEqual(log, ['a:start', 'a:end', 'b:start', 'c:start', 'd:start']);
});

test('ui/settings flow: 書きかけ（SOUL.md・USER.md・設定ファイル）が 1 つでもあれば、閉じる前に聞く', () => {
  assert.equal(hasUnsaved(new Map()), false);
  assert.equal(hasUnsaved(new Map([['persona:soul', false]])), false);
  assert.equal(hasUnsaved(new Map([['persona:soul', false], ['adv:file', true]])), true);
});

test('Settings の Esc の順番: 入れ子の部品が先に受けた Esc（preventDefault 済み）では「書きかけが消えます」を出さない。書きかけがあるときの Esc だけ出す（78107a7、backlog 479）', () => {
  assert.equal(escAsksLeave({ key: 'Escape', defaultPrevented: false }, true), true, '書きかけがあり、誰も受けていない Esc');
  assert.equal(escAsksLeave({ key: 'Escape', defaultPrevented: true }, true), false, '確かめの行・一覧・欄の取り消しが先に受けた');
  assert.equal(escAsksLeave({ key: 'Escape', defaultPrevented: false }, false), false, '書きかけが無ければ、そのまま閉じる（App の Esc）');
  assert.equal(escAsksLeave({ key: 'Enter', defaultPrevented: false }, true), false);
});

test('Settings の Esc の順番（配線）: 枠の中の Esc は枠の onKeyDown（入れ子のあと）で受け、枠の外の Esc だけ window の捕まえる段で受ける。受けたら preventDefault して App の「閉じる」へ渡さない', () => {
  const page = readFileSync(new URL('../web/src/ui/settings/Settings.tsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../web/src/ui/App.tsx', import.meta.url), 'utf8');
  assert.ok(page.includes('aria-labelledby="ui-settings-title" onKeyDown={askLeave}>'), '枠は泡の段で受ける（入れ子の onKeyDown が先）');
  assert.ok(page.includes('if (!escAsksLeave(e, hasUnsaved(dirty.current))) return;'), '出すかどうかは escAsksLeave で決める');
  const ask = page.slice(page.indexOf('const askLeave = useCallback('), page.indexOf('const discard = '));
  assert.ok(ask.indexOf('e.preventDefault();') < ask.indexOf('setLeave(() => onClose);'), '帯を出すときは Esc を受けたことにする');
  assert.ok(ask.includes('const onKey = (e: KeyboardEvent) => { if (!(e.target instanceof Node && modal.current?.contains(e.target))) askLeave(e); };'), 'window では枠の外の Esc だけ見る');
  assert.ok(ask.includes("addEventListener('keydown', onKey, true);") && ask.includes("removeEventListener('keydown', onKey, true);"), '枠の外は捕まえる段（App の閉じるより先）');
  assert.ok(app.includes("if (e.key !== 'Escape' || e.defaultPrevented) return;"), 'App は受け済みの Esc で Settings を閉じない');
});

test('ui/settings flow: 読み取りや保存が返ってこなくても、時間切れで次の保存へ進む。返ってこなかった操作は失敗で終わり、その通信は止める（backlog 196）', async () => {
  const enqueue = serial(20);
  let seen: AbortSignal | null = null;
  const stuck = enqueue(signal => { seen = signal; return new Promise<string>(() => undefined); });
  const next = enqueue(async () => 'next');
  const late = new Promise<string>(resolve => setTimeout(() => resolve('still waiting'), 500));
  assert.equal(await Promise.race([next, late]), 'next', '後ろの保存が待ち続けない');
  await assert.rejects(stuck);
  assert.equal((seen as AbortSignal | null)?.aborted, true, '時間切れの通信は止める');
  const quick = serial(20);
  let kept: AbortSignal | null = null;
  assert.equal(await quick(async signal => { kept = signal; return 'ok'; }), 'ok');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal((kept as AbortSignal | null)?.aborted, false, '間に合った操作は止めない');
});

test('ui/settings flow: 時間切れで止めた操作が自分で終われば、その結果（失敗の表示など）で終わり、それから次が始まる（backlog 196）', async () => {
  const enqueue = serial(20);
  const log: string[] = [];
  const stopped = enqueue(signal => new Promise<string>(resolve => { signal.addEventListener('abort', () => { log.push('a:stopped'); resolve('failed shown'); }); }));
  const next = enqueue(async () => { log.push('b:start'); return 'b'; });
  assert.equal(await stopped, 'failed shown');
  assert.equal(await next, 'b');
  assert.deepEqual(log, ['a:stopped', 'b:start'], '止めた操作の後片付けが、次の保存より先');
});

test('Settings を確かめの行が出たまま閉じると、その確かめを取り消して待ちを終える（配線、backlog 197）', () => {
  const page = readFileSync(new URL('../web/src/ui/settings/Settings.tsx', import.meta.url), 'utf8');
  assert.ok(page.includes('useEffect(() => () => { const open = pendingRef.current; pendingRef.current = null; open?.cancel?.(); }, []);'), '閉じる（外す）ときに出ている確かめの cancel を呼ぶ');
  let answered: boolean | null = null;
  let cancel: () => void = () => undefined;
  void confirmable(a => { cancel = a.cancel; }, async () => true).then(v => { answered = v; });
  cancel();
  return Promise.resolve().then(() => { assert.equal(answered, false, 'cancel で待ちは false で終わる'); });
});
