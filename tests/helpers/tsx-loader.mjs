import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ENV = JSON.stringify({ DEV: false, PROD: true, MODE: 'production', BASE_URL: '/', SSR: false });
let esbuild;

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
