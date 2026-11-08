import type { App } from '../app.ts';
import type { AppConfig } from '../config/schema.ts';
import { ConfigError, parseConfig } from '../config/store.ts';
import { envFileValue, EnvFileError, removeEnvValue, setEnvValue } from '../env-file.ts';
import { keyProblem, MAX_KEY_CHARS } from '../shared/provider-key.ts';
import { configProblem, problem } from './http.ts';

// 画面から .env に秘密を書く API が共有する部品（routes-notify.ts と同じ決まり）。
// 設定と .env を変えるところは、await を挟まずに「検査 → .env → 設定の反映」と進める。失敗したら .env も実行中の環境も元に戻す

export function envProblem(error: unknown): never {
  if (error instanceof EnvFileError && error.reason === 'value') throw problem(400, 'invalid_field', 'notify_secret_unsupported', { field: 'value' });
  if (error instanceof EnvFileError) throw problem(409, 'env_unwritable', 'notify_env_unwritable', { params: { reason: error.message } });
  throw error;
}

export function envApply(app: App) {
  // OS の環境変数から来た値か（.env の値と違う値が、実行中の環境に入っている）
  const fromOs = (name: string): boolean => {
    const value = app.env[name]?.trim();
    return Boolean(value) && value !== envFileValue(app.paths.env, name)?.trim();
  };
  // 設定の検査（通らなければ 400）。通ったものを返す
  const checked = (next: AppConfig): AppConfig => {
    try { return parseConfig(structuredClone(next)); }
    catch (error) { if (error instanceof ConfigError) throw configProblem(error); throw error; }
  };
  // changes: 名前 → 新しい値（undefined は消す）
  const applyWithEnv = async (next: AppConfig, changes: ReadonlyMap<string, string | undefined>): Promise<void> => {
    const before = new Map<string, { file: string | undefined; run: string | undefined }>();
    const restore = (): void => {
      for (const [name, prev] of before) {
        try { if (prev.file === undefined) removeEnvValue(app.paths.env, name); else setEnvValue(app.paths.env, name, prev.file); } catch { /* 戻せなくても、元の失敗を返す */ }
        if (prev.run === undefined) delete app.env[name]; else app.env[name] = prev.run;
      }
    };
    try {
      for (const [name, value] of changes) {
        before.set(name, { file: envFileValue(app.paths.env, name), run: app.env[name] });
        if (value === undefined) { removeEnvValue(app.paths.env, name); delete app.env[name]; }
        else { setEnvValue(app.paths.env, name, value); app.env[name] = value; }
      }
    } catch (error) { restore(); envProblem(error); }
    try { await app.applyConfig(next, { probe: false }); }
    catch (error) {
      restore();
      if (error instanceof ConfigError) throw configProblem(error);
      throw error;
    }
  };
  // 秘密の値の検査（鍵と同じ決まり。文言は通知の欄のものを使う）
  const secretValue = (value: unknown, field: string): string => {
    const bad = typeof value === 'string' ? keyProblem(value) : 'empty';
    if (typeof value !== 'string' || bad) {
      const code = ({ empty: 'notify_secret_empty', chars: 'notify_secret_chars', padded: 'notify_secret_padded', too_long: 'notify_secret_too_long' } as const)[bad ?? 'empty'];
      throw problem(400, 'invalid_field', code, { field, ...(bad === 'too_long' ? { params: { max: MAX_KEY_CHARS } } : {}) });
    }
    return value;
  };
  return { fromOs, checked, applyWithEnv, secretValue };
}