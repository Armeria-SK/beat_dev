import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkThenRun, confirmable, escAsksLeave, hasUnsaved, serial, type Answer } from '../web/src/ui/settings/flow.ts';

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

test('Settings の Reset も保存の順番待ちを通る: 先に並んだ保存が終わってから確かめの材料を読み、確かめのあとの Reset も、そのあいだに並んだ保存の後ろで走る（backlog 279）', async () => {
  const enqueue = serial();
  const log: string[] = [];
  let release: () => void = () => undefined;
  const save = enqueue(() => new Promise<void>(resolve => { log.push('save:start'); release = () => { log.push('save:end'); resolve(); }; }));
  let confirm: () => void = () => undefined;
  const reset = checkThenRun(enqueue,
    async () => { log.push('check'); return ['wider']; },
    items => items.join(','),
    (items, go) => new Promise<boolean>(resolve => { log.push(`ask:${items.join(',')}`); confirm = () => { void go().then(resolve); }; }),
    async () => { log.push('reset'); return true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(log, ['save:start'], '保存が終わるまで Reset の確かめの材料を読まない');
  release();
  await save;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(log, ['save:start', 'save:end', 'check', 'ask:wider']);
  let hold: () => void = () => undefined;
  const later = enqueue(() => new Promise<void>(resolve => { log.push('later:start'); hold = () => { log.push('later:end'); resolve(); }; }));
  confirm();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(log.includes('reset'), false, '確かめのあいだに並んだ保存の後ろで待つ');
  hold();
  await later;
  assert.equal(await reset, true);
  assert.deepEqual(log.slice(-4), ['later:start', 'later:end', 'check', 'reset'], 'Reset の直前に確かめの材料を読み直す');
  const quiet: string[] = [];
  let jobs = 0;
  const counted: typeof enqueue = job => { jobs += 1; return enqueue(job); };
  assert.equal(await checkThenRun(counted, async () => [], items => items.join(','), async () => { quiet.push('ask'); return false; }, async () => { quiet.push('reset'); return true; }), true);
  assert.deepEqual(quiet, ['reset'], '広がる変更が無ければ聞かずに Reset');
  assert.equal(jobs, 1, '確かめの材料と Reset は 1 つの順番で走る');
});

test('Settings の Reset: 確かめのあいだに広がる中身が変わったら、Reset の前にもう一度聞く（保存の planSave と同じ。レビューの直し）', async () => {
  const enqueue = serial();
  const found = [['a'], ['a', 'b'], ['a', 'b']];
  const asked: string[] = [];
  let resets = 0;
  const done = await checkThenRun(enqueue, async () => found.shift() ?? [], items => items.join(','),
    (items, go) => { asked.push(items.join(',')); return go(); },
    async () => { resets += 1; return true; });
  assert.equal(done, true);
  assert.deepEqual(asked, ['a', 'a,b'], '変わった中身で聞き直す');
  assert.equal(resets, 1, '確かめた中身と同じになってから 1 回だけ Reset');
});

test('Settings › Advanced の Reset の配線: 確かめの材料と Reset を ctx.queue（保存の順番待ち）で走らせる（backlog 279）', () => {
  const page = readFileSync(new URL('../web/src/ui/settings/customize.tsx', import.meta.url), 'utf8');
  const reset = page.slice(page.indexOf('const reset = async () => {'), page.indexOf('const broken = '));
  assert.ok(reset.includes('await checkThenRun(ctx.queue,'), 'Reset は checkThenRun と ctx.queue を通す');
  assert.ok(reset.includes('}, accessKey, (items, go) =>'), '確かめた中身は accessKey で比べる');
  assert.ok(reset.includes('api.resetSettings(signal)') && reset.includes('api.settings(signal), api.resetPreview(signal)'), 'Reset の通信は時間切れで止められる');
  assert.ok(!/await run\(\)/u.test(reset), '順番待ちの外で Reset を呼ばない');
  const settings = readFileSync(new URL('../web/src/ui/settings/Settings.tsx', import.meta.url), 'utf8');
  assert.ok(settings.includes('commit, queue: enqueue,'), 'ctx.queue は保存と同じ順番待ち');
});

test('Settings の保存の配線: 保存の読み直しと書き込みは、順番待ちの signal を通して時間切れで止められる（backlog 196、レビューの直し）', () => {
  const page = readFileSync(new URL('../web/src/ui/settings/Settings.tsx', import.meta.url), 'utf8');
  const commit = page.slice(page.indexOf('const commit = useCallback('), page.indexOf('const setDirty = '));
  assert.ok(commit.includes('return enqueue(async (signal): Promise<'), '順番待ちの signal を受ける');
  assert.ok(commit.includes('latest = (await api.settings(signal)).config;'));
  assert.ok(commit.includes('const result = await api.saveSettings(plan.config, signal);'));
});

test('Settings の Reset: 確かめのあとの読み直しが失敗したら、黙って何もしないのではなく失敗を返す（呼ぶ側が行の下に出す。レビューの直し）', async () => {
  const enqueue = serial();
  let checks = 0;
  let resets = 0;
  const done = checkThenRun(enqueue,
    async () => { checks += 1; if (checks > 1) throw new Error('offline'); return ['wider']; },
    items => items.join(','),
    (_items, go) => confirmable(answer => { answer.confirm(); }, go),
    async () => { resets += 1; return true; });
  await assert.rejects(done, /offline/u);
  assert.equal(resets, 0, 'Reset は走らない');
});
