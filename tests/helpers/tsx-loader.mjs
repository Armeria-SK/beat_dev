import { readFileSync, statSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ENV = JSON.stringify({ DEV: false, PROD: true, MODE: 'production', BASE_URL: '/', SSR: false });
let esbuild;

// 試験は、本物の置き場所（製品のフォルダ）の .env・.env.bak を作らず書き換えない（paths.env は一時フォルダに向ける）。
// 有るか・大きさ・更新時刻だけを、始めと終わりで比べる（中身は読まない）。変わっていたら、その試験のファイルを失敗にする。
// 見るのは試験のファイルごとの子のプロセスだけ（--test の親のプロセスでは、子の失敗として出る）。exit の出来事なしに殺された子は確かめられない。
// 同時に動いた別のファイルが書いても、その間に動いていたファイルはみな失敗になる（どれが書いたかは、1 つずつ流し直して分ける）
const ROOT_ENV_FILES = ['.env', '.env.bak'].map(name => fileURLToPath(new URL(`../../${name}`, import.meta.url)));
const rootEnvStamp = () => ROOT_ENV_FILES.map(path => { const s = statSync(path, { throwIfNoEntry: false }); return s ? `${s.size}:${s.mtimeMs}` : '-'; }).join('|');
const rootEnvBefore = rootEnvStamp();
process.on('exit', () => {
  if (rootEnvStamp() === rootEnvBefore) return;
  console.error(`${ROOT_ENV_FILES.join(' / ')} was created or changed while this test file ran. Another test file running at the same time may be the cause: rerun the failing files one at a time. The test that writes it must point paths.env at a temporary folder (see tests/app-setup.ts)`);
  process.exitCode = 1;
});

// Node の navigator.languages は OS の言語に従う。画面の説明の言語の Auto が PC ごとに変わらないよう、どの試験でも en-US にする
Object.defineProperty(globalThis.navigator, 'languages', { configurable: true, get: () => Object.freeze(['en-US']) });

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    if (!url.startsWith('file:') || !url.endsWith('.tsx')) return nextLoad(url, context);
    esbuild ??= require('esbuild');
    const file = fileURLToPath(url);
    const { code } = esbuild.transformSync(readFileSync(file, 'utf8'), {
      loader: 'tsx',
      jsx: 'automatic',
      format: 'esm',
      target: 'es2023',
      sourcefile: file,
      sourcemap: 'inline',
      define: { 'import.meta.env': ENV },
    });
    return { format: 'module', source: code, shortCircuit: true };
  },
});
