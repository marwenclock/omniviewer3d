// Runs after `vite build`: writes one static page per format/converter/tool, plus sitemap.xml and robots.txt.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES, renderPage, sitemap, robots, SITE_URL } from './seo.mjs';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const template = readFileSync(join(dist, 'index.html'), 'utf8');

for (const page of PAGES) {
  if (!page.slug) { writeFileSync(join(dist, 'index.html'), renderPage(template, page)); continue; }
  const dir = join(dist, page.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), renderPage(template, page, { base: '../' }));
}
writeFileSync(join(dist, 'sitemap.xml'), sitemap());
writeFileSync(join(dist, 'robots.txt'), robots());
// GitHub Pages: serve files as-is (no Jekyll) and fall back to the home page for unknown paths.
writeFileSync(join(dist, '.nojekyll'), '');
writeFileSync(join(dist, '404.html'), renderPage(template, PAGES[0]).replace('<head>', '<head>\n    <meta name="robots" content="noindex" />'));
console.log(`[pages] ${PAGES.length} pages + sitemap for ${SITE_URL}`);
