// Tells IndexNow search engines (Bing, Yandex, Seznam, Naver) that pages changed, so they recrawl them soon.
// Google does not use IndexNow: it reads sitemap.xml, which Search Console picks up (see docs/search-console.md).
//
// Usage, after a deploy that includes the key file (build with INDEXNOW_KEY set):
//   INDEXNOW_KEY=your-key node scripts/indexnow.mjs            submits every URL in dist/sitemap.xml
//   INDEXNOW_KEY=your-key node scripts/indexnow.mjs --dry-run  only prints what would be sent
import { readFileSync } from 'node:fs';
import { SITE_URL } from './seo.mjs';

const key = process.env.INDEXNOW_KEY;
if (!key) { console.error('Set INDEXNOW_KEY (the same value used at build time).'); process.exit(1); }
const xml = readFileSync(new URL('../dist/sitemap.xml', import.meta.url), 'utf8');
const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const host = new URL(SITE_URL).host;
const body = { host, key, keyLocation: `${SITE_URL}${key}.txt`, urlList: urls };
if (process.argv.includes('--dry-run')) { console.log(`Would submit ${urls.length} URLs for ${host}`); process.exit(0); }
// IndexNow accepts up to 10,000 URLs per request.
for (let i = 0; i < urls.length; i += 10000) {
  const res = await fetch('https://api.indexnow.org/indexnow', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ ...body, urlList: urls.slice(i, i + 10000) }) });
  console.log(`IndexNow ${i / 10000 + 1}: HTTP ${res.status} for ${Math.min(10000, urls.length - i)} URLs`);
}
