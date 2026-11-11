import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const beat = process.env.VITE_BEAT_UI === '1';
if (beat && process.env.CLIVE_PORT !== undefined && process.env.CLIVE_PORT !== '4797') {
  throw new Error(`VITE_BEAT_UI=1 only talks to the preview server on 4797 (CLIVE_PORT=${process.env.CLIVE_PORT})`);
}
const target = `http://127.0.0.1:${beat ? 4797 : process.env.CLIVE_PORT ?? 4777}`;
const entry = beat ? './src/ui/main.tsx' : './src/legacy-main.tsx';

const woff2Only = {
  name: 'clive-woff2-only',
  enforce: 'pre',
  transform(code, id) {
    if (!/[\\/]node_modules[\\/]@fontsource[\\/].+\.css$/.test(id)) return null;
    return code.replace(/,\s*url\([^)]*\.woff\)\s*format\('woff'\)/g, '');
  },
};

// 画面だけを開発するときは `npm run dev:web`（API は npm start のサーバーへ転送する）。
// 転送するとき Origin を書き換えないと、サーバー側の認証（ほかのサイトからの書き込みを断る）で弾かれる。
export default defineConfig({
  root: 'web',
  plugins: [woff2Only, react()],
  resolve: { alias: [{ find: /^virtual-entry$/, replacement: fileURLToPath(new URL(entry, import.meta.url)) }] },
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
  server: {
    proxy: {
      '/api': {
        target, changeOrigin: true,
        configure: proxy => { proxy.on('proxyReq', req => { if (req.getHeader('origin')) req.setHeader('origin', target); }); },
      },
    },
  },
});
