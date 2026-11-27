import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LANGUAGE, type AppConfig, type Language } from '../../config/schema.ts';
import { atomicWriteFile } from '../../config/store.ts';
import { conversationSawOutside, conversationTaskBound } from '../../db/outside.ts';
import { estimateTextTokens } from '../../engine/tokens.ts';
import { LocalizedError, type MessageParams } from '../../shared/messages/define.ts';
import { redactSecrets } from '../../shared/redaction.ts';
import { storeText, type StoreMessageKey } from '../../shared/messages/stores.ts';

const INDEX_TEXT: Record<Language, { heading: string; instruction: string; more: (n: number) => string }> = {
  en: { heading: '# Skills (procedures)', instruction: "When the work matches one of the skills below, read its procedure with skill_view first and follow it. Where a step conflicts with the basic rules or with what the owner asked, the rules and the owner's request win.", more: n => `- ${n} more not listed here (read with skill_view; a name it does not know returns the full list)` },
};

// token-efficiency TE-7: 一覧は使える量の 3% まで（いちばん小さい使えるモデル。分からなければ 64k のモデルの使える量 45,875 の 3%）。説明は 1 つ 160 字まで
export const SKILLS_INDEX_RATIO = 0.03;
export const SKILLS_INDEX_DEFAULT_TOKENS = 1_376;
export const SKILLS_INDEX_DESCRIPTION_MAX = 160;
export const skillsIndexBudget = (smallestAvailable: number | undefined): number =>
  smallestAvailable === undefined ? SKILLS_INDEX_DEFAULT_TOKENS : Math.max(1, Math.floor(smallestAvailable * SKILLS_INDEX_RATIO));
const clip = (text: string, max: number): string => { const chars = [...text]; return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`; };

export interface Skill { name: string; description: string; body: string; uses: number; lastUsedAt: number | null; updatedAt: number; registered: boolean }
export type SkillSource = 'approved' | 'owner' | 'upgrade';
export interface SkillDraft {
  id: number; name: string; description: string; body: string; reason: string | null; change_summary: string | null;
  status: 'pending' | 'approved' | 'rejected'; conversation_id: string | null; run_id: string | null; created_at: number; decided_at: number | null; outside: 0 | 1;
}

export class SkillError extends LocalizedError<StoreMessageKey> {
  constructor(code: StoreMessageKey, params?: MessageParams) { super(storeText, code, params); }
}

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const MAX_BODY = 20_000;
const MAX_DESCRIPTION = 300;

export const askBeforeRegister = (config: Pick<AppConfig, 'skills'>): boolean => config.skills?.askBeforeRegister !== false;
export const growSkills = (config: Pick<AppConfig, 'skills'>): boolean => config.skills?.grow !== false;

export type SkillAuthor = 'you' | 'beat' | 'beat-auto' | 'outside';
export interface SkillVersion { id: string; at: number; who: SkillAuthor; lines: number; description: string; body: string }
export const SKILL_VERSIONS_KEPT = 20;
export const SKILL_AUTO_PER_DAY = 5;
export const SKILL_REVIEW_PENDING_MAX = 10;
const AUTO_LOG_KEY = 'skills:auto-registered';
const SEEN_KEY = 'skill-seen:';
const SEEN_MAX = MAX_BODY * 2;
const DAY_MS = 86_400_000;
const VERSION_FILE = /^(\d{1,16})-(you|beat-auto|beat|outside)(?:-(\d{1,4}))?\.md$/u;

function versionOrder(file: string): [number, number] {
  const m = VERSION_FILE.exec(file)!;
  return [Number(m[1]), Number(m[3] ?? 1)];
}
const byVersion = (a: string, b: string): number => {
  const [at, an] = versionOrder(a);
  const [bt, bn] = versionOrder(b);
  return at - bt || an - bn;
};

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try { return String(JSON.parse(value)); } catch { return value.slice(1, -1); }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/gu, "'");
  return value;
}

export function parseSkillFile(text: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(text);
  if (!m) return { body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/u)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/u.exec(line);
    if (kv) meta[kv[1]!] = unquote(kv[2]!.trim());
  }
  return { ...(meta.name ? { name: meta.name } : {}), ...(meta.description ? { description: meta.description } : {}), body: m[2]!.trim() };
}

export function renderSkillFile(skill: { name: string; description: string; body: string }): string {
  const description = skill.description.replace(/\r?\n/gu, ' ').trim();
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(description)}\n---\n\n${skill.body.trim()}\n`;
}

function validate(input: { name: string; description: string; body: string; reason?: string | null | undefined; change?: string | null | undefined }, secrets: readonly string[]): void {
  if (!SKILL_NAME.test(input.name)) throw new SkillError('skill.bad_name');
  if (!input.description.trim()) throw new SkillError('skill.empty_description');
  if (input.description.length > MAX_DESCRIPTION) throw new SkillError('skill.long_description', { max: MAX_DESCRIPTION });
  if (!input.body.trim()) throw new SkillError('skill.empty_body');
  if (input.body.length > MAX_BODY) throw new SkillError('skill.long_body', { max: MAX_BODY });
  const text = [input.name, input.description, input.body, input.reason ?? '', input.change ?? ''].join('\n');
  if (redactSecrets(text, secrets) !== text) throw new SkillError('skill.secret');
}

export class SkillStore {
  readonly #db: DatabaseSync;
  readonly #dir: string;
  readonly #now: () => number;
  onDraft: ((draft: SkillDraft) => void) | undefined;
  autoRegister: (() => boolean) | undefined;
  secrets: () => readonly string[] = () => [];

  readonly #language: () => Language;
  readonly #log: (line: string) => void;
  readonly #backups: string | null;
  readonly #grow: () => boolean;
  readonly #tooBigLogged = new Set<string>();

  constructor(db: DatabaseSync, dir: string, now: () => number = Date.now, language: () => Language = () => DEFAULT_LANGUAGE, log: (line: string) => void = () => undefined, backups: string | null = null, grow: () => boolean = () => true) {
    this.#db = db; this.#dir = dir; this.#now = now; this.#language = language; this.#log = log; this.#backups = backups; this.#grow = grow;
  }

  get growing(): boolean { return this.#grow(); }

  get dir(): string { return this.#dir; }

  // フォルダにあるスキルを全部返す（画面のため。registered で、持ち主が認めたものかを分ける）。フォルダが無い・読めないときは空
  list(): Skill[] {
    this.pruneMissing();
    let entries: Dirent[];
    try { entries = readdirSync(this.#dir, { withFileTypes: true }); } catch { return []; }
    const skills: Skill[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SKILL_NAME.test(entry.name)) continue;
      const skill = this.get(entry.name);
      if (skill) skills.push(skill);
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Skill | undefined {
    if (!SKILL_NAME.test(name)) return undefined;
    const path = join(this.#dir, name, 'SKILL.md');
    if (!existsSync(path)) { this.#dropMissing(name); return undefined; }
    const text = readFileSync(path, 'utf8');
    this.#checkOutsideEdit(name, text);
    const parsed = parseSkillFile(text);
    const usage = this.#db.prepare('SELECT uses, last_used_at FROM skill_usage WHERE name = ?').get(name) as { uses: number; last_used_at: number | null } | undefined;
    return {
      name, description: parsed.description ?? storeText(this.#language(), 'skill.no_description'), body: parsed.body,
      uses: usage?.uses ?? 0, lastUsedAt: usage?.last_used_at ?? null, updatedAt: statSync(path).mtimeMs, registered: this.isRegistered(name),
    };
  }

  // 登録している = その名前の行があり、フォルダに SKILL.md がある。登録した名前は、あとで書き直されても（承認・画面の保存・file_write・シェル）そのまま使う。
  // フォルダが消えていた名前は、見つけた時点で行も消す（UI 以外で消されたあとに置き直されたものを、登録済みとして信用しない）
  isRegistered(name: string): boolean {
    if (!SKILL_NAME.test(name) || this.#db.prepare('SELECT 1 FROM skill_registry WHERE name = ?').get(name) === undefined) return false;
    if (existsSync(join(this.#dir, name, 'SKILL.md'))) return true;
    this.#dropMissing(name);
    return false;
  }

  // フォルダ（SKILL.md）の無い名前の登録を全部外す（外した名前は 1 件ずつ INFO で記録する）。一覧を作るときと起動のときに呼ぶ。外した件数を返す。
  // スキル全体のフォルダが無い・読めないときは何も外さない
  pruneMissing(): number {
    const rows = this.#db.prepare('SELECT name FROM skill_registry').all() as Array<{ name: string }>;
    let n = 0;
    for (const { name } of rows) if (!existsSync(join(this.#dir, name, 'SKILL.md')) && this.#dropMissing(name)) n++;
    return n;
  }

  // 一覧（system）と skill_view が見るのは、登録した名前だけ。未登録の SKILL.md は無いものとして扱う
  getRegistered(name: string): Skill | undefined {
    const skill = this.get(name);
    return skill?.registered ? skill : undefined;
  }

  listRegistered(): Skill[] { return this.list().filter(s => s.registered); }

  // 持ち主の画面の「登録する」。登録の印を書ける道は approve()・write()（画面の保存）・これの 3 つだけ
  register(name: string): Skill {
    if (!this.get(name)) throw new SkillError('skill.not_found', { name });
    this.#mark(name, 'owner');
    return this.get(name)!;
  }

  // 更新の時点で既にあるスキルを全部登録する（起動のとき 1 回だけ呼ぶ）。登録した件数を返す
  registerExisting(): number {
    let n = 0;
    for (const skill of this.list()) if (!skill.registered) { this.#mark(skill.name, 'upgrade'); n++; }
    return n;
  }

  // スキル全体のフォルダを読めるか。読めないとき（ドライブが外れている・同期フォルダが開けない）は、スキルが無いのか見えないだけなのか分からないので、登録は外さない
  #readable(): boolean {
    try { readdirSync(this.#dir); return true; } catch { return false; }
  }

  #unmark(name: string): boolean {
    return Number(this.#db.prepare('DELETE FROM skill_registry WHERE name = ?').run(name).changes) > 0;
  }

  // フォルダ（SKILL.md）が無い名前の行を外して、名前を記録する。スキル全体のフォルダを読めないときは何もしない。外したら true
  #dropMissing(name: string): boolean {
    if (!this.#readable() || !this.#unmark(name)) return false;
    this.#log(`[INFO] Unregistered skill "${name}" because its folder is missing (even if a folder with the same name is put back, it is not used until you press "Register" on the screen)`);
    return true;
  }

  #mark(name: string, source: SkillSource): void {
    this.#db.prepare('INSERT OR IGNORE INTO skill_registry (name, source, registered_at) VALUES (?, ?, ?)').run(name, source, this.#now());
  }

  index(language: Language = DEFAULT_LANGUAGE, budget = SKILLS_INDEX_DEFAULT_TOKENS): string {
    const skills = this.listRegistered().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (!skills.length) return '';
    const text = INDEX_TEXT[language];
    const cost = (line: string) => estimateTextTokens(`${line}\n`);
    const lines = [text.heading, text.instruction];
    let used = lines.reduce((sum, line) => sum + cost(line), 0);
    const items = skills.map(s => `- ${s.name}: ${clip(s.description, SKILLS_INDEX_DESCRIPTION_MAX)}`);
    for (const [i, item] of items.entries()) {
      const rest = items.length - i - 1;
      if (used + cost(item) + (rest ? cost(text.more(rest)) : 0) > budget) { lines.push(text.more(items.length - i)); break; }
      lines.push(item);
      used += cost(item);
    }
    return lines.join('\n');
  }

  recordUse(name: string): void {
    this.#db.prepare(`INSERT INTO skill_usage (name, uses, last_used_at) VALUES (?, 1, ?)
      ON CONFLICT (name) DO UPDATE SET uses = uses + 1, last_used_at = excluded.last_used_at`).run(name, this.#now());
  }

  // 画面の保存（owner）と、承認した下書き（approved）は、書いたあとに名前を登録する
  write(input: { name: string; description: string; body: string }, source: SkillSource = 'owner', who: SkillAuthor = 'you', outside = false): Skill {
    validate(input, this.secrets());
    const dir = join(this.#dir, input.name);
    const target = join(dir, 'SKILL.md');
    const content = renderSkillFile(input);
    this.#keepVersion(input.name, target, content, who);
    mkdirSync(dir, { recursive: true });
    atomicWriteFile(target, content);
    this.#markSeen(input.name, content);
    this.#mark(input.name, source);
    this.#db.prepare('UPDATE skill_registry SET outside = ? WHERE name = ?').run(outside ? 1 : 0, input.name);
    return this.get(input.name)!;
  }

  fromOutside(name: string): boolean {
    return (this.#db.prepare('SELECT outside FROM skill_registry WHERE name = ?').get(name) as { outside: number } | undefined)?.outside === 1;
  }

  #keepVersion(name: string, target: string, next: string, who: SkillAuthor): void {
    if (this.#backups === null) return;
    if (!SKILL_NAME.test(name)) throw new SkillError('skill.bad_name');
    let previous = '';
    try { if (lstatSync(target).isFile()) previous = readFileSync(target, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.#keepOutsideEdit(name, previous);
    if (previous === next || (previous === '' && who !== 'beat-auto')) return;
    this.#saveVersion(this.#backups, name, previous, who);
  }

  #keepOutsideEdit(name: string, current: string): void {
    if (this.#backups === null) return;
    const seen = (this.#db.prepare('SELECT value FROM kv WHERE key = ?').get(`${SEEN_KEY}${name}`) as { value: string } | undefined)?.value ?? '';
    if (seen === current) return;
    const tooBig = current.length > SEEN_MAX;
    if (tooBig && !this.#tooBigLogged.has(name)) {
      this.#tooBigLogged.add(name);
      this.#log(`[WARN] Skill "${name}" is longer than ${SEEN_MAX} characters, so its text is not kept when it is changed outside the app`);
    }
    if (tooBig && seen === '') return;
    if (seen !== '') this.#saveVersion(this.#backups, name, seen, 'outside');
    this.#markSeen(name, tooBig ? '' : current);
  }

  #checkOutsideEdit(name: string, text?: string): void {
    const path = join(this.#dir, name, 'SKILL.md');
    try {
      this.#keepOutsideEdit(name, lstatSync(path).isFile() ? text ?? readFileSync(path, 'utf8') : '');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#log(`[WARN] Could not keep the earlier text of skill "${name}" that was changed outside the app: ${(error as Error).message}`);
    }
  }

  #markSeen(name: string, content: string): void {
    if (this.#backups === null) return;
    this.#db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(`${SEEN_KEY}${name}`, content, this.#now());
  }

  #saveVersion(backups: string, name: string, previous: string, who: SkillAuthor): void {
    const dir = join(backups, name);
    mkdirSync(dir, { recursive: true });
    const files = readdirSync(dir).filter(file => VERSION_FILE.test(file));
    const at = this.#now();
    const same = files.filter(file => versionOrder(file)[0] === at).length;
    const file = same ? `${at}-${who}-${same + 1}.md` : `${at}-${who}.md`;
    writeFileSync(join(dir, file), previous, { encoding: 'utf8', flag: 'wx' });
    const sorted = [...files, file].sort(byVersion);
    const lastYou = sorted.findLastIndex(f => VERSION_FILE.exec(f)![2] === 'you');
    const keep = new Set(lastYou >= 0 ? sorted.slice(lastYou, lastYou + 2) : sorted.slice(0, 1));
    for (const old of sorted.slice(0, Math.max(0, sorted.length - SKILL_VERSIONS_KEPT))) if (!keep.has(old)) unlinkSync(join(dir, old));
  }

  history(name: string): SkillVersion[] {
    if (!SKILL_NAME.test(name)) throw new SkillError('skill.bad_name');
    if (this.#backups === null) return [];
    this.#checkOutsideEdit(name);
    const dir = join(this.#backups, name);
    let files: string[];
    try { files = readdirSync(dir).filter(file => VERSION_FILE.test(file)); } catch { return []; }
    return files.sort(byVersion).reverse().map(file => {
      const m = VERSION_FILE.exec(file)!;
      const parsed = parseSkillFile(readFileSync(join(dir, file), 'utf8'));
      return {
        id: file.slice(0, -'.md'.length), at: Number(m[1]), who: m[2] as SkillAuthor,
        lines: parsed.body ? parsed.body.split(/\r?\n/u).length : 0, description: parsed.description ?? '', body: parsed.body,
      };
    });
  }

  remove(name: string): void {
    if (!SKILL_NAME.test(name)) throw new SkillError('skill.bad_name');
    // フォルダが先に消えていても登録の行は消す（残すと、同じ名前で置き直したものが、そのまま信用されてしまう）
    this.#unmark(name);
    const found = this.get(name) !== undefined;
    if (found) rmSync(join(this.#dir, name), { recursive: true, force: true });
    if (this.#backups !== null) rmSync(join(this.#backups, name), { recursive: true, force: true });
    this.#db.prepare('DELETE FROM kv WHERE key = ?').run(`${SEEN_KEY}${name}`);
    if (!found) throw new SkillError('skill.not_found', { name });
  }

  sawOutside(conversationId: string | undefined): boolean {
    return conversationSawOutside(this.#db, conversationId);
  }

  taskBound(conversationId: string | undefined): boolean {
    return conversationTaskBound(this.#db, conversationId);
  }

  #autoQuotaLeft(now: number): boolean {
    const row = this.#db.prepare('SELECT value FROM kv WHERE key = ?').get(AUTO_LOG_KEY) as { value: string } | undefined;
    const recent = (row ? (JSON.parse(row.value) as number[]) : []).filter(at => at > now - DAY_MS);
    return recent.length < SKILL_AUTO_PER_DAY;
  }

  #countAuto(now: number): void {
    const row = this.#db.prepare('SELECT value FROM kv WHERE key = ?').get(AUTO_LOG_KEY) as { value: string } | undefined;
    const recent = [...(row ? (JSON.parse(row.value) as number[]) : []).filter(at => at > now - DAY_MS), now];
    this.#db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(AUTO_LOG_KEY, JSON.stringify(recent), now);
  }

  draft(input: { name: string; description: string; body: string; reason?: string | undefined; change?: string | undefined; conversationId?: string; runId?: string; autoOk?: boolean; fromReview?: boolean }): SkillDraft {
    if (!this.#grow()) throw new SkillError('skill.growth_off');
    validate(input, this.secrets());
    const pending = this.#db.prepare("SELECT COUNT(*) AS n FROM skill_drafts WHERE status = 'pending'").get() as { n: number };
    if (pending.n >= 20) throw new SkillError('skill.too_many_drafts');
    if (input.fromReview) {
      const fromReview = "EXISTS (SELECT 1 FROM engine_runs r WHERE r.id = d.run_id AND r.kind = 'review')";
      if (this.#db.prepare(`SELECT 1 FROM skill_drafts d WHERE d.name = ? AND d.status = 'pending' AND NOT ${fromReview}`).get(input.name)) throw new SkillError('skill.pending_from_chat', { name: input.name });
      const mine = this.#db.prepare(`SELECT COUNT(*) AS n FROM skill_drafts d WHERE d.status = 'pending' AND ${fromReview}`).get() as { n: number };
      if (mine.n >= SKILL_REVIEW_PENDING_MAX) throw new SkillError('skill.too_many_review_drafts', { max: SKILL_REVIEW_PENDING_MAX });
    }
    // 同じ名前の承認待ちは、新しいもので置き換える（古い方は却下扱い）
    const now = this.#now();
    this.#db.prepare("UPDATE skill_drafts SET status = 'rejected', decided_at = ? WHERE name = ? AND status = 'pending'").run(now, input.name);
    const result = this.#db.prepare('INSERT INTO skill_drafts (name, description, body, reason, change_summary, conversation_id, run_id, created_at, outside) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(input.name, input.description.trim(), input.body.trim(), input.reason?.trim() || null, input.change?.trim() || null, input.conversationId ?? null, input.runId ?? null, now, input.autoOk === true ? 0 : 1);
    const id = Number(result.lastInsertRowid);
    if (input.autoOk === true && this.autoRegister?.() === true) {
      try { if (this.#autoQuotaLeft(now)) { this.approve(id, 'beat-auto'); this.#countAuto(now); } } catch (error) { this.#log(`[WARN] Could not register skill "${input.name}" without review, so it waits as a draft: ${(error as Error).message}`); }
    }
    const draft = this.getDraft(id)!;
    this.onDraft?.(draft);
    return draft;
  }

  getDraft(id: number): SkillDraft | undefined {
    return this.#db.prepare('SELECT * FROM skill_drafts WHERE id = ?').get(id) as SkillDraft | undefined;
  }

  drafts(status: SkillDraft['status'] | 'all' = 'pending', limit = 50): SkillDraft[] {
    return (status === 'all'
      ? this.#db.prepare('SELECT * FROM skill_drafts ORDER BY id DESC LIMIT ?').all(limit)
      : this.#db.prepare('SELECT * FROM skill_drafts WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit)) as unknown as SkillDraft[];
  }

  approve(id: number, who: 'beat' | 'beat-auto' = 'beat'): Skill {
    const draft = this.getDraft(id);
    if (!draft || draft.status !== 'pending') throw new SkillError('skill.not_pending');
    const skill = this.write(draft, 'approved', who, draft.outside === 1);
    this.#db.prepare("UPDATE skill_drafts SET status = 'approved', decided_at = ? WHERE id = ?").run(this.#now(), id);
    return skill;
  }

  reject(id: number): void {
    const draft = this.getDraft(id);
    if (!draft || draft.status !== 'pending') throw new SkillError('skill.not_pending');
    this.#db.prepare("UPDATE skill_drafts SET status = 'rejected', decided_at = ? WHERE id = ?").run(this.#now(), id);
  }
}
