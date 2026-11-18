// Runs after `vite build`: writes every landing page in every language, share images, sitemap.xml, robots.txt,
// the 404 page, app icons, and stamps the service-worker cache with this release.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES, renderPage, pagePath, ogName, ogSvg, sitemap, robots, SITE_URL } from './seo.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const template = readFileSync(join(dist, 'index.html'), 'utf8');
/** Release id: date + commit (matches __APP_VERSION__ in vite.config.ts). */
const VERSION = (() => {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
  try { return `${d}-${execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim()}`; } catch { return d; }
})();

for (const page of PAGES) {
  const dir = join(dist, pagePath(page));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), renderPage(template, page));
}

// Share images (Open Graph / Twitter cards), rendered from SVG with the bundled Geist font.
const geist = (f) => join(root, 'node_modules/geist/dist/fonts/geist-sans', f);
let og = 0;
let Resvg = null;
try {
  ({ Resvg } = await import('@resvg/resvg-js'));
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

// Installable-app icons: raster and maskable PNGs from the eye mark (OV-083).
if (Resvg) {
  mkdirSync(join(dist, 'icons'), { recursive: true });
  const eye = '<path d="M1.6 11C5.6 4.6 10.9 1.6 17 1.6S28.4 4.6 32.4 11C28.4 17.4 23.1 20.4 17 20.4S5.6 17.4 1.6 11z" fill="none" stroke="#f3f2ef" stroke-width="2.4" stroke-linejoin="round"/><circle cx="17" cy="11" r="5.4" fill="none" stroke="#f3f2ef" stroke-width="2.4"/><circle cx="17" cy="11" r="2.1" fill="#f3f2ef"/>';
  // Maskable icons keep the mark inside the central safe zone (80%).
  const icon = (maskable) => {
    const k = maskable ? 1.6 : 2.2;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" ${maskable ? '' : 'rx="22"'} fill="#151515"/><g transform="translate(${50 - 17 * k} ${50 - 11 * k}) scale(${k})">${eye}</g></svg>`;
  };
  for (const [name, size, maskable] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['maskable-512.png', 512, true]]) {
    writeFileSync(join(dist, 'icons', name), new Resvg(icon(maskable), { fitTo: { mode: 'width', value: size } }).render().asPng());
  }
}

writeFileSync(join(dist, 'sitemap.xml'), sitemap());
writeFileSync(join(dist, 'robots.txt'), robots());
// IndexNow (Bing, Yandex, Seznam, Naver): the key file proves ownership; scripts/indexnow.mjs submits URLs.
if (process.env.INDEXNOW_KEY && /^[a-zA-Z0-9-]{8,128}$/.test(process.env.INDEXNOW_KEY)) writeFileSync(join(dist, `${process.env.INDEXNOW_KEY}.txt`), process.env.INDEXNOW_KEY);
writeFileSync(join(dist, '.nojekyll'), '');

// 404: Cloudflare serves it at ANY path, so assets must resolve from the site root (CA-01), and it must say what
// happened instead of looking like the home page (OV-078).
const notFound = renderPage(template, {
  ...PAGES[0],
  title: 'Page not found · OMNIVIEWER',
  h1: 'Page not found.',
  lede: 'This address does not exist, or no longer does. Open a model below, or go to <a href="./">the home page</a> or <a href="convert/">the converter</a>.',
}).replace('<head>', '<head>\n    <base href="/" />\n    <meta name="robots" content="noindex" />').replace(/<link rel="canonical"[^>]*>/, '');
writeFileSync(join(dist, '404.html'), notFound);

// Service worker: one cache per release, so updated engines in libs/ reach returning visitors (OV-082).
const swPath = join(dist, 'sw.js');
writeFileSync(swPath, readFileSync(swPath, 'utf8').replace(/const VERSION = '[^']*';/, `const VERSION = 'omniviewer-${VERSION}';`));

console.log(`[pages] ${PAGES.length} pages, ${og} share images, sitemap for ${SITE_URL}, release ${VERSION}`);
