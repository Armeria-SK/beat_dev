import { byText, cleanup, click, input, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Project } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';

type Props = { onProject: (project: Project) => void; connected?: boolean };
const { NewProduct } = await loadTsx<{ NewProduct: ComponentType<Props> }>('../web/src/ui/screens/NewProduct.tsx', import.meta.url);

const realFetch = globalThis.fetch;
interface Sent { path: string; method: string; body: unknown; signal: AbortSignal | undefined }
type Reply = { status?: number; body: unknown } | 'down' | 'hang';

function serve(routes: (path: string, method: string, body: unknown) => Reply | undefined): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const entry = { path: String(path), method: init?.method ?? 'GET', body, signal: init?.signal ?? undefined };
    sent.push(entry);
    const out = routes(entry.path, entry.method, body);
    if (out === 'down') throw new TypeError('Failed to fetch');
    if (out === 'hang') return new Promise<Response>((_, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });
    if (out === undefined) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return sent;
}

const project = (over: Partial<Project> = {}): Project => ({ id: 'p1aaaa', name: 'Old shop', root: 'C:\\old\\shop', archived_at: 1, ...over } as Project);
const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const field = (c: HTMLElement) => c.querySelector<HTMLInputElement>('#ui-np-root')!;
const openButton = (c: HTMLElement) => byText(c, 'button', en['ui.np.open']) as HTMLButtonElement | undefined;
const nameField = (c: HTMLElement) => c.querySelectorAll<HTMLInputElement>('input.bt-field')[1]!;
const posts = (sent: Sent[]) => sent.filter(s => s.method !== 'GET').map(s => [s.path, s.body]);
const text = (c: HTMLElement) => c.textContent ?? '';
const enter = (c: HTMLElement) => update(() => { field(c).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });

async function show(props: Partial<Props> = {}) {
  const rendered = await render(createElement(NewProduct, { onProject: () => undefined, ...props }));
  await settle();
  await settle();
  return rendered;
}

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
});

const base = (path: string, method: string): Reply | undefined => {
  if (path === '/api/folders/pick' && method === 'GET') return { body: { available: true } };
  if (path === '/api/projects?archived=1') return { body: { projects: [] } };
  return undefined;
};

test('ui/NewProduct（DOM）: 一覧（Places to start）は無く、この PC から開いたときは Open が窓を開き、選んだフォルダが欄に入って確かめ、Folder OK と notes を出す', async () => {
  const sent = serve((path, method) => {
    if (path === '/api/folders/pick' && method === 'POST') return { body: { path: 'C:\\work\\shop' } };
    if (path === '/api/folders/check') return { body: { root: 'C:\\work\\shop', notes: ['not_git'] } };
    return base(path, method);
  });
  const { container: c } = await show();
  assert.equal(text(c).includes('Places to start'), false);
  assert.deepEqual(posts(sent), [], '開いただけでは何も確かめない');
  assert.equal(field(c).placeholder, en['ui.np.folderFieldPick']);
  assert.equal(openButton(c)?.disabled, false, '欄が空でも Open は押せる');
  await click(openButton(c));
  await settle();
  assert.deepEqual(posts(sent), [['/api/folders/pick', {}], ['/api/folders/check', { path: 'C:\\work\\shop' }]]);
  assert.equal(field(c).value, 'C:\\work\\shop');
  assert.equal(nameField(c).value, '', '名前の欄は空のまま（フォルダ名は値にしない）');
  assert.equal(nameField(c).placeholder, 'shop', 'フォルダ名は薄い文字（placeholder）に出る');
  assert.ok(text(c).includes(`${en['ui.np.folderOk']} · Not a git folder.`));
});

test('ui/NewProduct（DOM）: 名前の欄は空で始まり、フォルダ名は placeholder に出る。打った文字だけが名前になり（後ろに足されない）、打たずに作ると名前は送らない', async () => {
  const sent = serve((path, method) => {
    if (path === '/api/folders/pick' && method === 'POST') return { body: { path: 'C:\\work\\kakeibo' } };
    if (path === '/api/folders/check') return { body: { root: 'C:\\work\\kakeibo', notes: [] } };
    if (path === '/api/projects' && method === 'POST') return { status: 201, body: { project: { id: 'p9zzzz', name: 'kakeibo' }, notes: [] } };
    return base(path, method);
  });
  const { container: c } = await show();
  assert.equal(nameField(c).value, '');
  assert.equal(nameField(c).placeholder, en['ui.np.nameHint'], 'フォルダが無い間は今までの案内');
  await click(openButton(c));
  await settle();
  assert.equal(nameField(c).value, '', 'フォルダを選んでも値には入れない（打つと後ろに足されて kakeibokakeibo になっていた）');
  assert.equal(nameField(c).placeholder, 'kakeibo');
  await input(field(c), 'C:\\work\\shop');
  assert.equal(nameField(c).placeholder, 'shop', '欄のパスを直すと placeholder も変わる');
  await input(nameField(c), `${nameField(c).value}Home`);
  assert.equal(nameField(c).value, 'Home', '打った文字だけが入る');
  await input(nameField(c), '');
  await click(byText(c, 'button', en['ui.np.create']));
  await settle();
  assert.deepEqual(sent.filter(s => s.path === '/api/projects' && s.method === 'POST').map(s => s.body), [{ root: 'C:\\work\\shop' }], '空に戻したら名前は送らない');
  window.location.hash = '';
});

test('ui/NewProduct（DOM）: 名前を打って作ると、打った文字がそのまま名前として送られる', async () => {
  const sent = serve((path, method) => {
    if (path === '/api/projects' && method === 'POST') return { status: 201, body: { project: { id: 'p9zzzz', name: 'Home' }, notes: [] } };
    return base(path, method);
  });
  const { container: c } = await show();
  await input(field(c), 'C:\\work\\kakeibo');
  await input(nameField(c), `${nameField(c).value}Home`);
  await click(byText(c, 'button', en['ui.np.create']));
  await settle();
  assert.deepEqual(sent.filter(s => s.path === '/api/projects' && s.method === 'POST').map(s => s.body), [{ root: 'C:\\work\\kakeibo', name: 'Home' }]);
  window.location.hash = '';
});

test('ui/NewProduct（DOM）: Check command の欄は無く（製品の設定にある）、作るときに確かめのコマンドを送らない', async () => {
  const sent = serve((path, method) => {
    if (path === '/api/projects' && method === 'POST') return { status: 201, body: { project: { id: 'p9zzzz', name: 'kakeibo' }, notes: [] } };
    return base(path, method);
  });
  const { container: c } = await show();
  assert.equal(text(c).includes(en['ui.np.check']), false, 'Check command の見出しが無い');
  assert.equal(text(c).includes(en['ui.np.checkHint']), false, 'Check command の説明が無い');
  assert.equal(c.querySelectorAll('input').length, 2, '欄は Folder と Name の 2 つだけ');
  await input(field(c), 'C:\\work\\kakeibo');
  await click(byText(c, 'button', en['ui.np.create']));
  await settle();
  const body = sent.find(s => s.path === '/api/projects' && s.method === 'POST')?.body as Record<string, unknown> | undefined;
  assert.ok(body);
  assert.equal('checkCommand' in body, false);
  window.location.hash = '';
});

test('ui/NewProduct（DOM）: 窓で選んだフォルダが製品のフォルダにできない（ホームなど）なら、その理由をすぐ欄の下に出す', async () => {
  serve((path, method) => {
    if (path === '/api/folders/pick' && method === 'POST') return { body: { path: 'C:\\Users\\me' } };
    if (path === '/api/folders/check') return { status: 400, body: { error: 'project', code: 'project.folder_home', message: 'x' } };
    return base(path, method);
  });
  const { container: c } = await show();
  await click(openButton(c));
  await settle();
  assert.match(c.querySelector('[role="alert"]')?.textContent ?? '', /home folder/u);
  assert.equal(text(c).includes(en['ui.np.folderOk']), false);
});

test('ui/NewProduct（DOM）: 窓を閉じた（cancelled）ら何も変えない。欄の値は窓の出発点として送る。窓が開いている間は Open を押せないが、案内の行は出さない', async () => {
  let answer: (value: Response) => void = () => undefined;
  const sent: Sent[] = [];
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    sent.push({ path: String(path), method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined, signal: undefined });
    if (String(path) === '/api/folders/pick' && method === 'POST') return new Promise<Response>(resolve => { answer = resolve; });
    const out = base(String(path), method) as { body: unknown };
    return new Response(JSON.stringify(out.body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const { container: c } = await show();
  await input(field(c), 'C:\\work');
  await click(openButton(c));
  assert.equal(text(c).includes('window that opened'), false, '窓が開いている間の案内の行は出さない');
  assert.equal(c.querySelector('[role="status"]'), null);
  assert.equal(openButton(c)?.disabled, true, '窓が開いている間は Open を押せない');
  await update(() => { answer(new Response(JSON.stringify({ cancelled: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })); });
  await settle();
  assert.deepEqual(posts(sent), [['/api/folders/pick', { path: 'C:\\work' }]]);
  assert.equal(field(c).value, 'C:\\work');
  assert.equal(openButton(c)?.disabled, false, '窓が閉じたら Open は押せる');
});

test('ui/NewProduct（DOM）: 窓が断られた（409）ら、その理由を欄の下に出す', async () => {
  serve((path, method) => {
    if (path === '/api/folders/pick' && method === 'POST') return { status: 409, body: { error: 'folder_dialog_busy', message: 'A folder window is already open' } };
    return base(path, method);
  });
  const { container: c } = await show();
  await click(openButton(c));
  await settle();
  assert.match(c.querySelector('[role="alert"]')?.textContent ?? '', /already open/u);
});

test('ui/NewProduct（DOM）: 窓が開いている間に画面を離れたら、窓の要求を取り消す（サーバーが窓を閉じる）', async () => {
  const sent = serve((path, method) => (path === '/api/folders/pick' && method === 'POST' ? 'hang' : base(path, method)));
  const { container: c, root } = await show();
  await click(openButton(c));
  const picking = sent.find(s => s.path === '/api/folders/pick' && s.method === 'POST')!;
  assert.equal(picking.signal?.aborted, false);
  await update(() => { root.unmount(); });
  assert.equal(picking.signal?.aborted, true);
});

test('ui/NewProduct（DOM）: 別の端末から・Windows でないときは、Open は打ったパスを確かめる（窓は出さない）。通れば Folder OK。欄の案内は「フルパスを貼る」', async () => {
  const sent = serve((path, method) => {
    if (path === '/api/folders/pick' && method === 'GET') return { body: { available: false } };
    if (path === '/api/folders/check') return { body: { root: 'C:\\work', notes: [] } };
    return base(path, method);
  });
  const { container: c } = await show();
  assert.equal(field(c).placeholder, en['ui.np.folderField']);
  assert.match(en['ui.np.folderField'], /full path/u);
  assert.equal(openButton(c)?.disabled, true);
  await input(field(c), 'C:\\work');
  await click(openButton(c));
  await settle();
  assert.deepEqual(posts(sent), [['/api/folders/check', { path: 'C:\\work' }]]);
  assert.equal(c.querySelector('[role="status"]')?.textContent, en['ui.np.folderOk']);
  await input(field(c), 'C:\\work\\x');
  assert.equal(text(c).includes(en['ui.np.folderOk']), false, '欄を変えたら消える');
});

test('ui/NewProduct（DOM）: サーバーが応えないときは「TypeError: Failed to fetch」ではなく、応えていないことと Retry を出す。Retry で同じ要求をやり直す', async () => {
  let down = true;
  const sent = serve((path, method) => (down ? 'down' : base(path, method)));
  const { container: c } = await show();
  assert.equal(text(c).includes('TypeError'), false);
  assert.equal(text(c).includes('Failed to fetch'), false);
  assert.ok(text(c).includes(en['ui.np.notAnswering']));
  down = false;
  await click(byText(c, 'button', en['ui.fail.retry']));
  await settle();
  assert.equal(text(c).includes(en['ui.np.notAnswering']), false);
  assert.equal(field(c).placeholder, en['ui.np.folderFieldPick']);
  assert.equal(sent.filter(s => s.path === '/api/folders/pick' && s.method === 'GET').length, 2);
});

test('ui/NewProduct（DOM）: Retry は失敗したときの値ではなく、いまの欄の値で送る（Create）', async () => {
  let down = false;
  const sent = serve((path, method) => {
    if (down) return 'down';
    if (path === '/api/projects' && method === 'POST') return { status: 201, body: { project: { id: 'p9zzzz', name: 'b' }, notes: [] } };
    return base(path, method);
  });
  const { container: c } = await show();
  await input(field(c), 'C:\\work\\a');
  down = true;
  await click(byText(c, 'button', en['ui.np.create']));
  await settle();
  assert.ok(text(c).includes(en['ui.np.notAnswering']));
  await input(field(c), 'C:\\work\\b');
  down = false;
  await click(byText(c, 'button', en['ui.fail.retry']));
  await settle();
  const created = sent.filter(s => s.path === '/api/projects' && s.method === 'POST').map(s => s.body);
  assert.deepEqual(created.at(-1), { root: 'C:\\work\\b' }, '名前を打っていなければ送らない（サーバーがフォルダ名にする）');
  window.location.hash = '';
});

test('ui/NewProduct（DOM）: 開いたときにサーバーが止まっていて、Retry ではなく Enter で確かめても、届いたら窓が使えるかを聞き直す', async () => {
  let down = true;
  const sent = serve((path, method) => {
    if (down) return 'down';
    if (path === '/api/folders/check') return { body: { root: 'C:\\work', notes: [] } };
    return base(path, method);
  });
  const { container: c } = await show();
  assert.equal(field(c).placeholder, en['ui.np.folderField']);
  await input(field(c), 'C:\\work');
  down = false;
  await enter(c);
  await settle();
  await settle();
  assert.equal(sent.filter(s => s.path === '/api/folders/pick' && s.method === 'GET').length, 2);
  assert.equal(field(c).placeholder, en['ui.np.folderFieldPick']);
  assert.equal(text(c).includes(en['ui.np.notAnswering']), false);
});

test('ui/NewProduct（DOM）: Enter で打ったパスを確かめるときにサーバーが応えなくても同じ文と Retry。つながりが戻ったら自分でやり直して消す', async () => {
  let down = false;
  const sent = serve((path, method) => {
    if (down) return 'down';
    if (path === '/api/folders/check') return { body: { root: 'C:\\work', notes: [] } };
    return base(path, method);
  });
  const { container: c, root } = await show({ connected: true });
  await input(field(c), 'C:\\work');
  down = true;
  await enter(c);
  await settle();
  assert.ok(text(c).includes(en['ui.np.notAnswering']));
  assert.equal(text(c).includes('Failed to fetch'), false);
  await update(() => { root.render(createElement(NewProduct, { onProject: () => undefined, connected: false })); });
  down = false;
  await update(() => { root.render(createElement(NewProduct, { onProject: () => undefined, connected: true })); });
  await settle();
  assert.equal(text(c).includes(en['ui.np.notAnswering']), false);
  assert.equal(sent.filter(s => s.path === '/api/folders/check').length, 2);
  assert.ok(text(c).includes(en['ui.np.folderOk']));
});

test('ui/NewProduct（DOM）: しまった製品の Restore でサーバーが応えないときも、トーストの TypeError ではなく同じ文と Retry', async () => {
  let down = false;
  const restored: unknown[] = [];
  serve((path, method, body) => {
    if (path === '/api/projects?archived=1') return { body: { projects: [project()] } };
    if (down) return 'down';
    if (path === '/api/projects/p1aaaa' && method === 'PATCH') { restored.push(body); return { body: { project: project({ archived_at: null }) } }; }
    return base(path, method);
  });
  const { container: c } = await show();
  down = true;
  await click(byText(c, 'button', en['ui.np.restore']));
  await settle();
  assert.ok(text(c).includes(en['ui.np.notAnswering']));
  down = false;
  await click(byText(c, 'button', en['ui.fail.retry']));
  await settle();
  assert.deepEqual(restored, [{ archived: false }]);
  assert.equal(text(c).includes(en['ui.np.notAnswering']), false);
});

test('ui/NewProduct（DOM）: つながりが戻っても、Create は自分でやり直さない（Retry を押すまで待つ。途中まで打った値で作らない）', async () => {
  let down = false;
  const sent = serve((path, method) => (down ? 'down' : base(path, method)));
  const { container: c, root } = await show({ connected: true });
  await input(field(c), 'C:\work\shop');
  down = true;
  await click(byText(c, 'button', en['ui.np.create']));
  await settle();
  assert.ok(text(c).includes(en['ui.np.notAnswering']));
  await input(field(c), 'C:\wo');
  await update(() => { root.render(createElement(NewProduct, { onProject: () => undefined, connected: false })); });
  down = false;
  await update(() => { root.render(createElement(NewProduct, { onProject: () => undefined, connected: true })); });
  await settle();
  assert.equal(sent.filter(s => s.path === '/api/projects' && s.method === 'POST').length, 1, 'Create は 1 回だけ');
  assert.ok(text(c).includes(en['ui.np.notAnswering']), '知らせは Retry を待って残る');
});

test('ui/NewProduct（DOM）: つながりが戻っても、窓（Open）は自分でやり直さない（beat が戻るたびに最前面の窓が勝手に出ないように）', async () => {
  let down = false;
  const sent = serve((path, method) => (down ? 'down' : base(path, method)));
  const { container: c, root } = await show({ connected: true });
  down = true;
  await click(openButton(c));
  await settle();
  await update(() => { root.render(createElement(NewProduct, { onProject: () => undefined, connected: false })); });
  down = false;
  await update(() => { root.render(createElement(NewProduct, { onProject: () => undefined, connected: true })); });
  await settle();
  assert.equal(sent.filter(s => s.path === '/api/folders/pick' && s.method === 'POST').length, 1);
});

test('ui/NewProduct（DOM）: 開いたときにサーバーが止まっていて、窓が使えるかの問い合わせで戻ったときも、しまった製品の一覧を読み直す', async () => {
  let down = true;
  const sent = serve((path, method) => {
    if (down) return 'down';
    if (path === '/api/projects?archived=1') return { body: { projects: [project()] } };
    return base(path, method);
  });
  const { container: c } = await show();
  assert.ok(text(c).includes(en['ui.np.notAnswering']));
  down = false;
  await click(byText(c, 'button', en['ui.fail.retry']));
  await settle();
  await settle();
  assert.equal(text(c).includes(en['ui.np.notAnswering']), false);
  assert.equal(sent.filter(s => s.path === '/api/projects?archived=1').length, 2);
  assert.ok(text(c).includes('Old shop'));
});
