import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config/store.ts';
import { APP_ROOT, resolvePaths } from '../src/paths.ts';
import { checkWorkFolder, folderGone, gitFolder, listFolders, MAX_LINK_HOPS, rootKeyOf, type FolderFs, type WorkFolderContext } from '../src/projects/work-folder.ts';
import { tempDir, testConfig } from './helpers.ts';

const WINDOWS = process.platform === 'win32';

function fixture(t: { after: (fn: () => void) => void }) {
  const base = realpathSync.native(tempDir(t));
  const dir = (...parts: string[]) => { const path = join(base, ...parts); mkdirSync(path, { recursive: true }); return path; };
  const home = dir('home');
  const appRoot = dir('clive');
  dir('clive', 'src');
  const paths = resolvePaths(dir('clive', 'data'));
  const env = {
    APPDATA: dir('home', 'AppData', 'Roaming'), LOCALAPPDATA: dir('home', 'AppData', 'Local'),
    SystemRoot: dir('os', 'Windows'), ProgramFiles: dir('os', 'Program Files'), 'ProgramFiles(x86)': dir('os', 'Program Files (x86)'), ProgramData: dir('os', 'ProgramData'),
  };
  const config = parseConfig(testConfig());
  const ctx = (over: Partial<WorkFolderContext> = {}): WorkFolderContext => ({ paths, appRoot, config, active: [], home, env, ...over });
  const reason = (path: string, over: Partial<WorkFolderContext> = {}) => { const r = checkWorkFolder(path, ctx(over)); return r.ok ? 'ok' : r.reason; };
  return { base, dir, home, appRoot, paths, env, config, ctx, reason };
}

test('checkWorkFolder: ホームの中のふつうのフォルダは通る。git の無いフォルダ・日本語の名前のフォルダも通り、控えるのは実体のパス', t => {
  const f = fixture(t);
  const plain = f.dir('home', 'projects', 'site');
  const checked = checkWorkFolder(plain, f.ctx());
  assert.deepEqual(checked, { ok: true, root: plain, rootKey: rootKeyOf(plain), notes: ['not_git'], isGit: false });
  const japanese = f.dir('home', 'projects', '旅のメモ');
  assert.equal(f.reason(japanese), 'ok');
  const repo = f.dir('home', 'projects', 'repo');
  mkdirSync(join(repo, '.git'));
  const git = checkWorkFolder(repo, f.ctx());
  assert.ok(git.ok && git.isGit && !git.notes.includes('not_git'));
  const trailing = checkWorkFolder(`${plain}${WINDOWS ? '\\' : '/'}`, f.ctx());
  assert.ok(trailing.ok && trailing.root === plain, '末尾の区切りは実体のパスにそろう');
});

test('checkWorkFolder: 絶対パスでない・".." や "." の入ったパス・無い・フォルダでないものは断る', t => {
  const f = fixture(t);
  const site = f.dir('home', 'projects', 'site');
  writeFileSync(join(site, 'file.txt'), 'x');
  assert.equal(f.reason('projects/site'), 'folder_not_absolute');
  assert.equal(f.reason(`${site}${WINDOWS ? '\\..\\' : '/../'}site`), 'folder_not_absolute');
  assert.equal(f.reason(join(site, '.') + (WINDOWS ? '\\.' : '/.')), 'folder_not_absolute');
  assert.equal(f.reason(join(site, 'nope')), 'folder_not_found');
  assert.equal(f.reason(join(site, 'file.txt')), 'folder_not_directory');
});

test('checkWorkFolder: ネットワークのパス・デバイスのパス・デバイス名は、ファイルの関数を 1 つも呼ばずに断る', t => {
  const f = fixture(t);
  const calls: string[] = [];
  const spy: FolderFs = {
    lstat: path => { calls.push(`lstat ${path}`); throw new Error('touched'); },
    readlink: path => { calls.push(`readlink ${path}`); throw new Error('touched'); },
    realpath: path => { calls.push(`realpath ${path}`); throw new Error('touched'); },
  };
  const cases: Array<[string, string]> = [
    ['\\\\server\\share\\work', 'folder_remote'], ['//server/share/work', 'folder_remote'], ['\\\\?\\C:\\work', 'folder_remote'],
    ['\\\\.\\C:\\work', 'folder_remote'], ['C:\\work\\nul', 'folder_hazard'], ['C:\\work\\a.txt:stream', 'folder_hazard'],
  ];
  for (const [path, expected] of cases) {
    const checked = checkWorkFolder(path, f.ctx({ fs: spy }));
    assert.equal(checked.ok, false, path);
    if (WINDOWS) assert.equal(!checked.ok && checked.reason, expected, path);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(checkWorkFolder(f.dir('home', 'projects', 'site'), f.ctx({ fs: spy })), { ok: false, reason: 'folder_unreadable' });
  assert.ok(calls.length > 0, '前提: ふつうのパスは、この差し替えたファイルの関数を呼ぶ');
});

test('checkWorkFolder: ホームとその親、AppData とその中、OS のフォルダ、ドライブの直下は選べない', t => {
  const f = fixture(t);
  assert.equal(f.reason(f.home), 'folder_home');
  assert.equal(f.reason(f.base), 'folder_home', 'ホームの親');
  assert.equal(f.reason(parse(f.base).root), 'folder_drive_root');
  if (WINDOWS) {
    assert.equal(f.reason(f.env.APPDATA), 'folder_app_data');
    assert.equal(f.reason(f.env.LOCALAPPDATA), 'folder_app_data');
    assert.equal(f.reason(join(f.home, 'AppData')), 'folder_app_data');
    assert.equal(f.reason(f.dir('home', 'AppData', 'Local', 'Temp', 'work')), 'folder_app_data', '一時フォルダも');
    assert.equal(f.reason(f.dir('home', 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')), 'folder_app_data');
    assert.equal(f.reason(f.env.SystemRoot), 'folder_system');
    assert.equal(f.reason(f.dir('os', 'Program Files', 'Tool')), 'folder_system');
    assert.equal(f.reason(f.dir('os', 'ProgramData', 'x')), 'folder_system');
    assert.equal(f.reason(join(f.base, 'os')), 'folder_system', 'OS のフォルダを中に含むもの');
  } else {
    assert.equal(f.reason(f.dir('home', '.config', 'tool')), 'folder_app_data');
    assert.equal(f.reason(f.dir('home', '.local', 'share')), 'folder_app_data');
    assert.equal(f.reason('/usr'), 'folder_system');
  }
});

test('checkWorkFolder: この PC の本物の場所でも同じ（ホーム・ホームの親・ドライブの直下・AppData・一時フォルダ・Windows のフォルダ）', () => {
  const paths = resolvePaths(join(APP_ROOT, 'data'));
  const config = parseConfig(testConfig());
  const reason = (path: string) => { const r = checkWorkFolder(path, { paths, appRoot: APP_ROOT, config, active: [] }); return r.ok ? 'ok' : r.reason; };
  assert.equal(reason(homedir()), 'folder_home');
  assert.equal(reason(parse(homedir()).root), 'folder_drive_root');
  if (dirname(homedir()) !== parse(homedir()).root) assert.equal(reason(dirname(homedir())), 'folder_home');
  if (WINDOWS) {
    assert.equal(reason(process.env.APPDATA!), 'folder_app_data');
    assert.equal(reason(process.env.LOCALAPPDATA!), 'folder_app_data');
    assert.equal(reason(tmpdir()), 'folder_app_data');
    assert.equal(reason(process.env.SystemRoot!), 'folder_system');
    assert.equal(reason(join(process.env.SystemRoot!, 'System32')), 'folder_system');
  }
});

test('checkWorkFolder: Clive 自身のフォルダ（その親・その中も）と、データのフォルダ（その親・その中も）は選べない', t => {
  const f = fixture(t);
  assert.equal(f.reason(f.appRoot), 'folder_clive');
  assert.equal(f.reason(join(f.appRoot, 'src')), 'folder_clive');
  assert.equal(f.reason(f.dir('clive', 'tmp', 'scratch')), 'folder_clive');
  assert.equal(f.reason(f.paths.data), 'folder_clive');
  assert.equal(f.reason(f.dir('clive', 'data', 'workspace')), 'folder_clive');
  const outside = resolvePaths(f.dir('elsewhere', 'store', 'data'));
  assert.equal(f.reason(outside.data, { paths: outside }), 'folder_clive', '--data-dir で外に置いたデータ');
  assert.equal(f.reason(join(f.base, 'elsewhere', 'store'), { paths: outside }), 'folder_clive', 'データのフォルダの親');
  assert.equal(f.reason(f.dir('elsewhere', 'store', 'data', 'projects', 'x'), { paths: outside }), 'folder_clive', 'データのフォルダの中');
  assert.equal(f.reason(join(APP_ROOT, 'src'), { appRoot: APP_ROOT }), 'folder_clive', '本物の Clive のフォルダの中');
  assert.equal(f.reason(dirname(APP_ROOT), { appRoot: APP_ROOT }), 'folder_clive', '本物の Clive のフォルダの親');
});

test('checkWorkFolder: 秘密の名前のフォルダの中と、設定の拒否の一覧（その中・それを中に含むもの）は選べない', t => {
  const f = fixture(t);
  assert.equal(f.reason(f.dir('home', 'projects', '.ssh', 'keys')), 'folder_secret');
  assert.equal(f.reason(f.dir('home', 'projects', 'secrets')), 'folder_secret');
  const blocked = f.dir('home', 'projects', 'client', 'blocked');
  const config = { ...f.config, tools: { ...f.config.tools, deny: [blocked] } };
  assert.equal(f.reason(blocked, { config }), 'folder_denied');
  assert.equal(f.reason(f.dir('home', 'projects', 'client', 'blocked', 'deep'), { config }), 'folder_denied');
  assert.equal(f.reason(join(f.home, 'projects', 'client'), { config }), 'folder_denied', '拒否のフォルダを中に含む');
  assert.equal(f.reason(f.dir('home', 'projects', 'other'), { config }), 'ok');
});

test('checkWorkFolder: もう使っている製品と同じフォルダは断る（大文字小文字だけ違う・ジャンクション越しでも）。入れ子は通って notes が付く', t => {
  const f = fixture(t);
  const site = f.dir('home', 'projects', 'site');
  const active = [{ root: site, root_key: rootKeyOf(site) }];
  assert.equal(f.reason(site, { active }), 'root_in_use');
  if (WINDOWS) assert.equal(f.reason(site.toUpperCase(), { active }), 'root_in_use');
  const link = join(f.home, 'projects', 'site-link');
  symlinkSync(site, link, 'junction');
  assert.equal(f.reason(link, { active }), 'root_in_use');
  const viaLink = checkWorkFolder(link, f.ctx());
  assert.ok(viaLink.ok && viaLink.root === site, 'リンク越しに選ぶと、実体のパスを控える');

  const inner = checkWorkFolder(f.dir('home', 'projects', 'site', 'packages', 'ui'), f.ctx({ active }));
  assert.ok(inner.ok && inner.notes.includes('nested_inside') && !inner.notes.includes('contains_product'));
  const outer = checkWorkFolder(join(f.home, 'projects'), f.ctx({ active }));
  assert.ok(outer.ok && outer.notes.includes('contains_product') && !outer.notes.includes('nested_inside'));
});

test('checkWorkFolder: 設定の許可フォルダとの重なりは通って notes が付く（含まれる → inside_config_root、同じフォルダが読むだけ → config_root_read_only）', t => {
  const f = fixture(t);
  const site = f.dir('home', 'projects', 'site');
  const withRoots = (roots: Array<{ path: string; mode: 'read' | 'write' }>) => ({ ...f.config, tools: { ...f.config.tools, roots } });
  const notes = (config: typeof f.config) => { const r = checkWorkFolder(site, f.ctx({ config })); assert.ok(r.ok); return r.notes; };
  assert.deepEqual(notes(withRoots([{ path: join(f.home, 'projects'), mode: 'write' }])), ['inside_config_root', 'not_git']);
  assert.deepEqual(notes(withRoots([{ path: join(f.home, 'projects'), mode: 'read' }])), ['inside_config_root', 'not_git']);
  assert.deepEqual(notes(withRoots([{ path: site, mode: 'read' }])), ['config_root_read_only', 'not_git']);
  assert.deepEqual(notes(withRoots([{ path: site, mode: 'write' }])), ['inside_config_root', 'not_git']);
  assert.deepEqual(notes(withRoots([{ path: f.dir('home', 'other'), mode: 'write' }])), ['not_git']);
});

test('checkWorkFolder: 試しとテストだけの抜け道は、渡したフォルダの下だけで効き、渡さなければ効かない。データのフォルダは抜け道の下でも選べない', t => {
  const f = fixture(t);
  const preview = f.dir('clive', 'tmp', 'preview');
  const product = f.dir('clive', 'tmp', 'preview', 'products', 'shop');
  assert.equal(f.reason(product), 'folder_clive', '渡さなければ Clive のフォルダの中');
  assert.equal(f.reason(product, { exempt: [] }), 'folder_clive');
  assert.equal(f.reason(product, { exempt: [preview] }), 'ok');
  assert.equal(f.reason(join(f.appRoot, 'src'), { exempt: [preview] }), 'folder_clive', '渡したフォルダの外は今までどおり');
  assert.equal(f.reason(f.home, { exempt: [preview] }), 'folder_home');
  const data = resolvePaths(f.dir('clive', 'tmp', 'preview', 'data'));
  assert.equal(f.reason(data.data, { exempt: [preview], paths: data }), 'folder_clive');
  assert.equal(f.reason(f.dir('clive', 'tmp', 'preview', 'products', '.ssh'), { exempt: [preview] }), 'folder_secret', '秘密の名前は抜け道でも断る');
});

test('listFolders: フォルダの名前だけを返す（ファイルと秘密の名前のフォルダは出さない）。リンク・ジャンクションの子は解かずに link: true', t => {
  const f = fixture(t);
  const root = f.dir('home', 'projects');
  f.dir('home', 'projects', 'alpha');
  mkdirSync(join(f.dir('home', 'projects', 'beta'), '.git'));
  f.dir('home', 'projects', '.ssh');
  f.dir('home', 'projects', 'secrets');
  writeFileSync(join(root, 'notes.txt'), 'x');
  writeFileSync(join(root, '.env'), 'KEY=1');
  const target = f.dir('elsewhere', 'target');
  f.dir('elsewhere', 'target', 'inside-target');
  symlinkSync(target, join(root, 'jump'), 'junction');

  const listing = listFolders(root, f.ctx());
  assert.ok(!('reason' in listing));
  assert.equal(listing.path, root);
  assert.equal(listing.parent, f.home);
  assert.equal(listing.truncated, false);
  assert.deepEqual(listing.entries, [
    { name: 'alpha', path: join(root, 'alpha'), selectable: true, isGit: false, link: false },
    { name: 'beta', path: join(root, 'beta'), selectable: true, isGit: true, link: false },
    { name: 'jump', path: join(root, 'jump'), selectable: false, reason: 'project.folder_link', isGit: false, link: true },
  ]);

  const opened = listFolders(join(root, 'jump'), f.ctx());
  assert.ok(!('reason' in opened));
  assert.equal(opened.path, target, '持ち主がリンクを開いたときは、行き先の実体を返す');
  assert.deepEqual(opened.entries.map(e => e.name), ['inside-target']);
});

test('listFolders: ネットワーク・デバイスのパスと危ない形・相対パスは断る。無いパス・ファイル・秘密の名前のフォルダも断る', t => {
  const f = fixture(t);
  const root = f.dir('home', 'projects');
  writeFileSync(join(root, 'notes.txt'), 'x');
  const reason = (path: string) => { const r = listFolders(path, f.ctx()); return 'reason' in r ? r.reason : 'ok'; };
  if (WINDOWS) {
    assert.equal(reason('\\\\server\\share'), 'folder_remote');
    assert.equal(reason('\\\\?\\C:\\Users'), 'folder_remote');
    assert.equal(reason('C:\\Users\\con'), 'folder_hazard');
  }
  assert.equal(reason('projects'), 'folder_not_absolute');
  assert.equal(reason(join(root, 'nope')), 'folder_not_found');
  assert.equal(reason(join(root, 'notes.txt')), 'folder_not_directory');
  assert.equal(reason(f.dir('home', 'projects', '.aws')), 'folder_secret');
});

test('listFolders: 1 回に 500 件まで（超えたら truncated）。選べないフォルダには理由が付く', t => {
  const f = fixture(t);
  const many = f.dir('home', 'many');
  for (let i = 0; i < 503; i++) mkdirSync(join(many, `d${String(i).padStart(3, '0')}`));
  const listing = listFolders(many, f.ctx());
  assert.ok(!('reason' in listing));
  assert.equal(listing.entries.length, 500);
  assert.equal(listing.truncated, true);
  assert.equal(listing.entries[0]!.name, 'd000');

  const top = listFolders(f.base, f.ctx());
  assert.ok(!('reason' in top));
  const byName = Object.fromEntries(top.entries.map(e => [e.name, e]));
  assert.deepEqual({ selectable: byName.home!.selectable, reason: byName.home!.reason }, { selectable: false, reason: 'project.folder_home' });
  assert.deepEqual({ selectable: byName.clive!.selectable, reason: byName.clive!.reason }, { selectable: false, reason: 'project.folder_clive' });
});

test('listFolders: 出発点はホーム・ホームのあるドライブの直下・設定の許可フォルダだけ（ドライブを探して回らない）', t => {
  const f = fixture(t);
  const work = f.dir('home', 'work');
  const config = { ...f.config, tools: { ...f.config.tools, roots: [{ path: work, mode: 'write' as const }] } };
  const listing = listFolders(undefined, f.ctx({ config }));
  assert.ok(!('reason' in listing));
  assert.deepEqual({ path: listing.path, parent: listing.parent, truncated: listing.truncated }, { path: null, parent: null, truncated: false });
  assert.deepEqual(listing.entries.map(e => e.path), [f.home, parse(f.home).root, work]);
  assert.deepEqual(listing.entries.map(e => e.selectable), [false, false, true]);
});

test('checkWorkFolder: ホームの隣（ほかの利用者のフォルダ・Default・Public）は選べない。ホームの中は通る', t => {
  const f = fixture(t);
  assert.equal(f.reason(f.dir('elsewhere')), 'folder_home');
  assert.equal(f.reason(f.dir('Public', 'Documents', 'site')), 'folder_home');
  assert.equal(f.reason(f.dir('home', 'projects', 'site')), 'ok');
  assert.equal(f.reason(f.dir('Public', 'site'), { exempt: [join(f.base, 'Public')] }), 'ok', '試しとテストだけの抜け道の下');
});

const LOCAL = /^[A-Za-z]:\\/u;
const w = (text: string) => text.replaceAll('/', '\\');

function linkFs(forward: Record<string, string>) {
  const links = Object.fromEntries(Object.entries(forward).map(([from, to]) => [w(from), w(to)]));
  const key = (path: string) => path.replace(/\\+$/u, '').toLowerCase();
  const table = new Map(Object.entries(links).map(([from, to]) => [key(from), to]));
  const calls: string[] = [];
  const reached: string[] = [];
  const follow = (path: string, final: boolean) => {
    let current = path;
    for (let hop = 0; hop < 100; hop++) {
      if (!LOCAL.test(current)) { reached.push(current); return; }
      const parts = current.replace(/\\+$/u, '').split('\\');
      let moved = false;
      for (let i = 2; i <= parts.length && !moved; i++) {
        if (i === parts.length && !final) break;
        const target = table.get(key(parts.slice(0, i).join('\\')));
        if (target === undefined) continue;
        current = [target.replace(/\\+$/u, ''), ...parts.slice(i)].join('\\');
        moved = true;
      }
      if (!moved) return;
    }
  };
  const fs: FolderFs = {
    lstat: path => {
      calls.push(path); follow(path, false);
      if (path.endsWith('.missing')) return undefined;
      const link = table.has(key(path));
      return { isSymbolicLink: () => link, isDirectory: () => !link };
    },
    readlink: path => { calls.push(path); follow(path, false); return table.get(key(path))!; },
    realpath: path => { calls.push(path); follow(path, true); return path; },
  };
  return { fs, calls, reached };
}

const LINK_CASES: Array<{ label: string; links: Record<string, string>; path: string; reason: string }> = [
  { label: 'リンクの先がまたリンクで、その先が UNC', links: { 'C:/w/a': 'C:/w/b', 'C:/w/b': '//host/share' }, path: w('C:/w/a'), reason: 'folder_remote' },
  { label: 'リンクの先が生の NT のパス', links: { 'C:/w/a': '/Device/Mup/host/share' }, path: w('C:/w/a'), reason: 'folder_link' },
  { label: '途中のフォルダがリンク', links: { 'C:/w/mid': '//host/share' }, path: w('C:/w/mid/leaf'), reason: 'folder_remote' },
  { label: 'リンクの先のパスが、途中で別のリンクを通る', links: { 'C:/w/a': 'C:/w/mid/x', 'C:/w/mid': '//host/share' }, path: w('C:/w/a'), reason: 'folder_remote' },
  { label: 'リンクの先が相対パス', links: { 'C:/w/a': '../b' }, path: w('C:/w/a'), reason: 'folder_link' },
  { label: 'リンクが輪になっている', links: { 'C:/w/a': 'C:/w/b', 'C:/w/b': 'C:/w/a' }, path: w('C:/w/a/leaf'), reason: 'folder_link' },
];

test('リンクをたどる歩き方: UNC・デバイスのパスへ届く呼び出しを 1 つもしない（checkWorkFolder・listFolders・gitFolder・folderGone）', { skip: !WINDOWS }, t => {
  const f = fixture(t);
  for (const c of LINK_CASES) {
    const checkFs = linkFs(c.links);
    assert.deepEqual(checkWorkFolder(c.path, f.ctx({ fs: checkFs.fs })), { ok: false, reason: c.reason }, c.label);
    const listFs = linkFs(c.links);
    assert.deepEqual(listFolders(c.path, f.ctx({ fs: listFs.fs })), { reason: c.reason }, c.label);
    const gitFs = linkFs(c.links);
    assert.equal(gitFolder(c.path, gitFs.fs), false, c.label);
    const goneFs = linkFs(c.links);
    assert.equal(folderGone(c.path, rootKeyOf(c.path), goneFs.fs), true, c.label);
    for (const used of [checkFs, listFs, gitFs, goneFs]) {
      assert.deepEqual(used.reached, [], `${c.label}: OS がリンクを追って外へ出た`);
      assert.ok(used.calls.length > 0 && used.calls.every(path => LOCAL.test(path)), `${c.label}: ${used.calls.join(' | ')}`);
      assert.ok(used.calls.length <= 3 * (MAX_LINK_HOPS + 2), `${c.label}: 呼び出しの数に上限がある`);
    }
  }
});

test('リンクをたどる歩き方: この PC の中を指すリンクは 1 つずつ確かめて通す。.git がリンクでも追わない。無いパスは folder_not_found', { skip: !WINDOWS }, t => {
  const f = fixture(t);
  const ok = linkFs({ 'C:/w/a': 'C:/w/b/', 'C:/w/b': 'C:/w/real', 'C:/w/real/.git': '//host/share' });
  const checked = checkWorkFolder(w('C:/w/a'), f.ctx({ fs: ok.fs }));
  assert.deepEqual(checked, { ok: true, root: w('C:/w/real'), rootKey: w('c:/w/real'), notes: [], isGit: true });
  assert.equal(gitFolder(w('C:/w/a'), ok.fs), true);
  assert.equal(folderGone(w('C:/w/real'), w('c:/w/real'), ok.fs), false);
  assert.equal(folderGone(w('C:/w/a'), w('c:/w/real'), ok.fs), true, '控えたパスの途中にリンクがあれば、すり替わったとみなす（追わない）');
  assert.equal(folderGone(w('C:/w/real'), w('c:/w/other'), ok.fs), true, '実体が変わった');
  assert.deepEqual(ok.reached, []);
  const missing = linkFs({ 'C:/w/a': 'C:/w/gone.missing' });
  assert.deepEqual(checkWorkFolder(w('C:/w/a'), f.ctx({ fs: missing.fs })), { ok: false, reason: 'folder_not_found' });
  const hops = linkFs(Object.fromEntries(Array.from({ length: MAX_LINK_HOPS + 1 }, (_, i) => [`C:/w/l${i}`, `C:/w/l${i + 1}`])));
  assert.deepEqual(checkWorkFolder(w('C:/w/l0'), f.ctx({ fs: hops.fs })), { ok: false, reason: 'folder_link' }, 'たどる回数の上限');
  const within = linkFs(Object.fromEntries(Array.from({ length: MAX_LINK_HOPS }, (_, i) => [`C:/w/l${i}`, `C:/w/l${i + 1}`])));
  assert.equal(checkWorkFolder(w('C:/w/l0'), f.ctx({ fs: within.fs })).ok, true, '上限ちょうどは通る');
});
