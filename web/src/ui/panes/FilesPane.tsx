import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react';
import { api, type FileContent, type FileEntry, type FileTree } from '../../api.ts';
import { formatRelative } from '../../i18n/format.ts';
import { useT } from '../../i18n/index.ts';
import { Button, EmptyState, Icon, Notice } from '../parts.tsx';
import '../styles/files.css';

// beat 8-5a: Files の欄（Design FilesPane）。読むだけ。左に木（開いたフォルダごとに読み足す）、右に選んだファイル。
// 欄が 760px より狭いと木が全幅になり、ファイルは木の上に開いて戻るボタンが出る（files.css の container query）
export interface FilesPaneProps { productId: string; revision: string }

type Folder = { state: 'loading' } | { state: 'failed' } | { state: 'ok'; entries: FileEntry[]; truncated: boolean };
type Opened = { path: string; content: FileContent | null; failed: string | null };

const TREES: readonly FileTree[] = ['product', 'knowledge'];

export function FilesPane({ productId, revision }: FilesPaneProps) {
  const t = useT();
  const [tree, setTree] = useState<FileTree>('product');
  const [folders, setFolders] = useState<Record<string, Folder>>({});
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(['']));
  const [file, setFile] = useState<Opened | null>(null);
  const generation = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;
  const fileRef = useRef(file);
  fileRef.current = file;

  const loadFolder = useCallback(async (dir: string, quiet = false) => {
    const gen = generation.current;
    if (!quiet) setFolders(all => ({ ...all, [dir]: { state: 'loading' } }));
    try {
      const listing = await api.files(productId, tree, dir);
      if (gen === generation.current) setFolders(all => ({ ...all, [dir]: { state: 'ok', entries: listing.entries, truncated: listing.truncated } }));
    } catch {
      if (gen === generation.current) setFolders(all => ({ ...all, [dir]: { state: 'failed' } }));
    }
  }, [productId, tree]);

  const loadFile = useCallback(async (path: string) => {
    const gen = generation.current;
    try {
      const content = await api.file(productId, tree, path);
      if (gen === generation.current && fileRef.current?.path === path) setFile({ path, content, failed: null });
    } catch (error) {
      if (gen === generation.current && fileRef.current?.path === path) setFile({ path, content: null, failed: error instanceof Error ? error.message : String(error) });
    }
  }, [productId, tree]);

  useEffect(() => {
    generation.current++;
    setFolders({});
    setOpen(new Set(['']));
    setFile(null);
    void loadFolder('');
  }, [loadFolder]);

  const seen = useRef(revision);
  useEffect(() => {
    if (seen.current === revision) return;
    seen.current = revision;
    for (const dir of openRef.current) void loadFolder(dir, true);
    if (fileRef.current) void loadFile(fileRef.current.path);
  }, [revision, loadFolder, loadFile]);

  const toggle = (entry: FileEntry) => {
    if (entry.kind === 'file') {
      setFile({ path: entry.path, content: null, failed: null });
      fileRef.current = { path: entry.path, content: null, failed: null };
      void loadFile(entry.path);
      return;
    }
    if (entry.hidden) return;
    const next = new Set(open);
    if (next.has(entry.path)) next.delete(entry.path);
    else {
      next.add(entry.path);
      void loadFolder(entry.path);
    }
    setOpen(next);
  };

  const rows = (dir: string, depth: number): ReactElement[] => {
    const folder = folders[dir];
    if (!folder || folder.state === 'loading') return [];
    if (folder.state === 'failed') return [<li key={`${dir}/!`} className="bt-tree__row bt-meta" role="none" style={{ '--bt-depth': depth } as CSSProperties}>{t('ui.files.loadFailed')}</li>];
    if (folder.entries.length === 0) return [<li key={`${dir}/-`} className="bt-tree__row bt-meta" role="none" style={{ '--bt-depth': depth } as CSSProperties}>{t('ui.files.emptyFolder')}</li>];
    const out: ReactElement[] = [];
    for (const entry of folder.entries) {
      const dirRow = entry.kind === 'dir';
      const expanded = dirRow && !entry.hidden && open.has(entry.path);
      const active = !dirRow && file?.path === entry.path;
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(entry); } };
      out.push(
        <li key={entry.path} className={`bt-tree__row${dirRow ? ' bt-tree__row--dir' : ''}${active ? ' is-active' : ''}`} role="treeitem" tabIndex={0}
          aria-expanded={dirRow && !entry.hidden ? expanded : undefined} aria-selected={dirRow ? undefined : active} data-path={entry.path}
          style={{ '--bt-depth': depth } as CSSProperties} onClick={() => toggle(entry)} onKeyDown={onKey}>
          <Icon name={dirRow ? (expanded ? 'chevD' : 'chevR') : 'file'} />
          <span className="bt-tree__name">{entry.name}</span>
          {entry.hidden && <span className="bt-meta">{t('ui.files.hidden')}</span>}
          {entry.mark === 'M' && <span className="bt-meta" title={t('ui.files.modifiedMark')}>M</span>}
          {entry.mark === 'A' && <span className="bt-add" title={t('ui.files.addedMark')}>A</span>}
        </li>,
      );
      if (expanded) out.push(...rows(entry.path, depth + 1));
    }
    if (folder.truncated) out.push(<li key={`${dir}/+`} className="bt-tree__row bt-meta" role="none" style={{ '--bt-depth': depth } as CSSProperties}>{t('ui.files.more')}</li>);
    return out;
  };

  const root = folders[''];
  return (
    <div className={`ui-files${file ? ' is-open' : ''}`} data-tree={tree}>
      <div className="ui-files__grid">
        <div className="ui-files__side">
          <div className="bt-seg ui-files__trees" role="group" aria-label={t('ui.files.which')}>
            {TREES.map(name => <button key={name} type="button" className="bt-seg__opt" aria-pressed={tree === name} onClick={() => setTree(name)}>{t(name === 'product' ? 'ui.files.product' : 'ui.files.knowledge')}</button>)}
          </div>
          {root?.state === 'failed'
            ? <Notice tone="warn" icon="alert" title={t('ui.files.loadFailed')} action={{ label: t('ui.fail.retry'), run: () => void loadFolder('') }} />
            : <ul className="bt-tree" role="tree" aria-label={t(tree === 'product' ? 'ui.files.product' : 'ui.files.knowledge')}>{rows('', 0)}</ul>}
        </div>
        <div className="ui-files__view">
          {file ? <FileBody opened={file} onBack={() => setFile(null)} /> : <EmptyState title={t('ui.pane.files')} text={t('ui.files.pickHint')} />}
        </div>
      </div>
    </div>
  );
}

function FileBody({ opened, onBack }: { opened: Opened; onBack: () => void }) {
  const t = useT();
  const { content } = opened;
  const meta = [opened.path];
  if (content) {
    if (content.hidden) meta.push(t('ui.files.hidden'));
    else if (content.binary) meta.push(t('ui.files.binary'), t('ui.files.size', Math.max(1, Math.round(content.size / 1024))));
    else if (content.text !== null) meta.push(t('ui.files.lines', lineCount(content.text)));
    if (content.truncated && !content.binary) meta.push(t('ui.files.firstPart', 512));
    meta.push(t('ui.files.modified', formatRelative(content.modifiedAt)));
  }
  return (
    <>
      <Button small variant="ghost" icon="arrowL" className="ui-files__back" onClick={onBack}>{t('ui.files.back')}</Button>
      <div className="bt-pane__bar"><span className="bt-meta" title={opened.path}>{meta.join(' · ')}</span></div>
      {opened.failed !== null && <Notice tone="warn" icon="alert" title={t('ui.files.openFailed')} text={opened.failed} />}
      {content?.hidden && <p className="bt-meta ui-files__note">{t('ui.files.hiddenNote')}</p>}
      {content?.binary && !content.hidden && <p className="bt-meta ui-files__note">{t('ui.files.binaryNote')}</p>}
      {content && content.text !== null && <pre className="bt-term ui-files__text" tabIndex={0}>{content.text}</pre>}
    </>
  );
}

const lineCount = (text: string): number => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
