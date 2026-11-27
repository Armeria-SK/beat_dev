// 外の実行役の「確かめ」の結果の置き場（AR-6）。確かめは起動のときと、持ち主が押したときだけ起こす（設定を保存するたびには起こさない）。
// 起こす先は、各実行役の窓口の probe（版・ログインの状態）と models（モデルの一覧）だけ。発言は送らない。結果は覚えておいて、画面とモデルの状態（status.ts）が同じものを読む
import type { AppConfig, RuntimeConfig, RuntimeKind } from '../config/schema.ts';
import { redactSecrets } from '../shared/redaction.ts';
import type { RuntimeRegistry } from './registry.ts';
import { startBlocked, type RuntimeIssue, type RuntimeModel, type RuntimeStatus } from './types.ts';

export interface RuntimeCheck {
  id: string;
  kind: RuntimeKind;
  checkedAt: number;
  status: RuntimeStatus;
  // 会話を始めようとして止まった理由（会話をつなぐ段が渡す）。次の確かめで消える
  stop: RuntimeIssue | null;
}

export type RuntimeCheckFailure = 'unknown' | 'disabled' | 'not_built' | 'failed' | 'check_failed';

export type CheckOutcome = { ok: true; check: RuntimeCheck } | { ok: false; reason: RuntimeCheckFailure; detail: string };
export type ModelsOutcome = { ok: true; models: readonly RuntimeModel[] } | { ok: false; reason: RuntimeCheckFailure; detail: string };

const DEADLINE_MS = 60_000;
const MAX_MODELS = 500;
const MAX_DETAIL = 200;
// 設定のモデルの名前・ラベル・考える深さの決まり（config/schema.ts）に合わせる。実行役が返す一覧は信用しない（制御文字・長すぎる値・数の多すぎる値を落とす）
const EFFORT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/u;
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const CONTROL_ALL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

// 実行役が返した文は、ログや画面に渡す前に、制御文字などを ? にして秘密を伏せ、長さを切る（codex の safeLabel と同じ作り）
const plain = (text: string, max: number = MAX_DETAIL): string => redactSecrets(text.replace(CONTROL_ALL, '?')).slice(0, max);

function cleanModels(list: readonly RuntimeModel[]): RuntimeModel[] {
  const seen = new Set<string>();
  const out: RuntimeModel[] = [];
  for (const entry of list) {
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (id === '' || id.length > 200 || CONTROL.test(id) || seen.has(id)) continue;
    seen.add(id);
    const label = typeof entry.label === 'string' ? redactSecrets(entry.label.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').trim()).slice(0, 80) : '';
    const efforts = [...new Set((Array.isArray(entry.efforts) ? entry.efforts : []).filter((effort): effort is string => typeof effort === 'string' && EFFORT.test(effort)))].slice(0, 8);
    out.push({ id, ...(label ? { label } : {}), ...(efforts.length > 0 ? { efforts } : {}) });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

// 確かめの結果が、いまの設定にも当てはまるか（入れる実行ファイルや種類が変われば、前の結果は使わない。許可の設定を変えても確かめは変わらない）
const keyOf = (runtime: Pick<RuntimeConfig, 'kind' | 'executablePath'>): string => `${runtime.kind}\0${runtime.executablePath ?? ''}`;

export const usableCheck = (status: RuntimeStatus): boolean => status.installed && status.auth === 'ok' && !startBlocked(status);

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The runtime did not answer in time')), ms); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export class RuntimeChecks {
  readonly #registry: RuntimeRegistry;
  readonly #log: (line: string) => void;
  readonly #deadlineMs: number;
  readonly #checks = new Map<string, { key: string; check: RuntimeCheck }>();
  // 「モデルを読み込む」で取れた一覧。確かめの結果とは別に覚える（確かめの前に読み込んでも、一覧は消えない）
  readonly #lists = new Map<string, { key: string; models: readonly RuntimeModel[] }>();
  readonly #running = new Map<string, Promise<CheckOutcome>>();

  constructor(registry: RuntimeRegistry, log: (line: string) => void, deadlineMs: number = DEADLINE_MS) {
    this.#registry = registry;
    this.#log = log;
    this.#deadlineMs = deadlineMs;
  }

  get(id: string): RuntimeCheck | undefined { return this.#checks.get(id)?.check; }

  // 読み込んだ一覧（まだ読み込んでいなければ null）
  models(id: string): readonly RuntimeModel[] | null { return this.#lists.get(id)?.models ?? null; }

  // 設定から消えた・切れた・入れる先が変わった実行役の結果を捨てる（切った実行役を、古い「使える」のまま残さない）
  prune(config: Pick<AppConfig, 'runtimes'>): void {
    for (const [id, entry] of this.#checks) {
      const runtime = config.runtimes?.find(candidate => candidate.id === id);
      if (!runtime || !runtime.enabled || keyOf(runtime) !== entry.key) this.#checks.delete(id);
    }
    for (const [id, entry] of this.#lists) {
      const runtime = config.runtimes?.find(candidate => candidate.id === id);
      if (!runtime || !runtime.enabled || keyOf(runtime) !== entry.key) this.#lists.delete(id);
    }
  }

  // 版・ログインの状態を確かめる。切れている実行役は起こさない（registry の find が断る）。同じ実行役の確かめが走っているあいだは、それを待つ
  check(config: Pick<AppConfig, 'runtimes'>, id: string): Promise<CheckOutcome> {
    const found = this.#registry.find(config, id);
    if (!found.ok) return Promise.resolve({ ok: false, reason: found.reason, detail: found.detail });
    const running = this.#running.get(id);
    if (running) return running;
    const runtime = config.runtimes!.find(candidate => candidate.id === id)!;
    const key = keyOf(runtime);
    const work = (async (): Promise<CheckOutcome> => {
      try {
        const status = await withDeadline(found.runtime.probe(), this.#deadlineMs);
        const check: RuntimeCheck = { id, kind: runtime.kind, checkedAt: Date.now(), status, stop: null };
        this.#checks.set(id, { key, check });
        if (!usableCheck(status)) this.#log(`[WARN] runtime ${id}: ${plain(status.reason ?? 'not ready')}`);
        return { ok: true, check };
      } catch (error) {
        const detail = plain((error as Error).message);
        this.#log(`[ERROR] runtime ${id}: the check failed: ${detail}`);
        return { ok: false, reason: 'check_failed', detail };
      }
    })().finally(() => { this.#running.delete(id); });
    this.#running.set(id, work);
    return work;
  }

  // 起動のとき（main.ts）に 1 回だけ。入っている実行役を確かめ、使えると分かった実行役だけ一覧も読む（確かめと一覧は覚えるだけで、起動をまたいで残らないため）
  async checkEnabled(config: Pick<AppConfig, 'runtimes'>): Promise<void> {
    await Promise.all((config.runtimes ?? []).map(async runtime => {
      const outcome = await this.check(config, runtime.id);
      if (outcome.ok && usableCheck(outcome.check.status)) await this.loadModels(config, runtime.id);
    }));
  }

  // 「モデルを読み込む」。実行役自身の一覧の口（Claude Code: supportedModels()、Codex: model/list）だけを使う。取れた一覧は覚える
  async loadModels(config: Pick<AppConfig, 'runtimes'>, id: string): Promise<ModelsOutcome> {
    const found = this.#registry.find(config, id);
    if (!found.ok) return { ok: false, reason: found.reason, detail: found.detail };
    const runtime = config.runtimes!.find(candidate => candidate.id === id)!;
    try {
      const listed = await withDeadline(found.runtime.models(), this.#deadlineMs);
      const models = cleanModels(listed);
      this.#lists.set(id, { key: keyOf(runtime), models });
      return { ok: true, models };
    } catch (error) {
      const detail = plain((error as Error).message);
      this.#log(`[ERROR] runtime ${id}: the model list could not be read: ${detail}`);
      return { ok: false, reason: 'check_failed', detail };
    }
  }

  // 会話を始めようとして止まった理由を、状態の行に出すために覚える（AR-7 以降の会話をつなぐ段が呼ぶ）。確かめがまだ無い実行役には覚えない
  report(id: string, issue: RuntimeIssue): void {
    const entry = this.#checks.get(id);
    if (!entry) return;
    const detail = issue.detail === undefined ? undefined : plain(issue.detail);
    this.#checks.set(id, { key: entry.key, check: { ...entry.check, stop: { code: issue.code, ...(detail ? { detail } : {}) } } });
  }
}
