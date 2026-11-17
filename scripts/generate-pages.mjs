// Runs after `vite build`: writes every landing page in every language, share images, sitemap.xml and robots.txt.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES, renderPage, pagePath, ogName, ogSvg, sitemap, robots, SITE_URL } from './seo.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const template = readFileSync(join(dist, 'index.html'), 'utf8');

for (const page of PAGES) {
  const dir = join(dist, pagePath(page));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), renderPage(template, page));
}

// Share images (Open Graph / Twitter cards), rendered from SVG with the bundled Geist font.
const geist = (f) => join(root, 'node_modules/geist/dist/fonts/geist-sans', f);
let og = 0;
try {
  const { Resvg } = await import('@resvg/resvg-js');
  mkdirSync(join(dist, 'og'), { recursive: true });
  for (const page of PAGES) {
    const png = new Resvg(ogSvg(page), {
      font: { fontFiles: [geist('Geist-Bold.ttf'), geist('Geist-Regular.ttf')], loadSystemFonts: false, defaultFontFamily: 'Geist' },
    }).render().asPng();
    writeFileSync(join(dist, ogName(page)), png);
    og++;
  }
} catch (e) {
  console.warn('[pages] share images skipped:', e.message);
}

writeFileSync(join(dist, 'sitemap.xml'), sitemap());
writeFileSync(join(dist, 'robots.txt'), robots());
writeFileSync(join(dist, '.nojekyll'), '');
writeFileSync(join(dist, '404.html'), renderPage(template, PAGES[0]).replace('<head>', '<head>\n    <meta name="robots" content="noindex" />'));
console.log(`[pages] ${PAGES.length} pages, ${og} share images, sitemap for ${SITE_URL}`);
