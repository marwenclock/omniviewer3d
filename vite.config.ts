import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

/** Version shown in Help / About and bug reports (OV-118): date + commit. */
const APP_VERSION = (() => { const d = new Date().toISOString().slice(0, 10).replace(/-/g, '.'); try { return `${d}-${execSync('git rev-parse --short HEAD').toString().trim()}`; } catch { return d; } })();
// @ts-ignore: plain JS module shared with the build script
import { PAGES, renderPage, pagePath } from './scripts/seo.mjs';

/** Renders the home page content into index.html, and serves the landing pages in dev. */
function seoPages(): Plugin {
  return {
    name: 'omniviewer-seo-pages',
    transformIndexHtml: {
      order: 'pre',
      handler: (html: string) => renderPage(html, PAGES[0]),
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url || '').split(/[?#]/)[0].replace(/^\//, '');
        const page = PAGES.find((p: any) => pagePath(p) && pagePath(p) === (path.endsWith('/') ? path : path + '/'));
        if (!page) return next();
        let html = readFileSync('index.html', 'utf8');
        html = await server.transformIndexHtml('/' + pagePath(page), html);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(renderPage(html, page));
      });
    },
  };
}

export default defineConfig({
  // Relative base so the build works on GitHub Pages sub-paths and custom domains alike.
  base: './',
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [seoPages()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
  optimizeDeps: {
    exclude: ['web-ifc'],
  },
});
