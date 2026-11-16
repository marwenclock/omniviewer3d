import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
// @ts-ignore: plain JS module shared with the build script
import { PAGES, renderPage } from './scripts/seo.mjs';

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
        const slug = (req.url || '').split(/[?#]/)[0].replace(/^\/|\/$/g, '');
        const page = PAGES.find((p: any) => p.slug && p.slug === slug);
        if (!page) return next();
        let html = readFileSync('index.html', 'utf8');
        html = await server.transformIndexHtml(`/${slug}/`, html);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(renderPage(html, page, { base: '../' }));
      });
    },
  };
}

export default defineConfig({
  // Relative base so the build works on GitHub Pages sub-paths and custom domains alike.
  base: './',
  plugins: [seoPages()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
  optimizeDeps: {
    exclude: ['web-ifc'],
  },
});
