// Builds the SEO landing pages (format viewers, converters, tools) from scripts/seo-data.mjs.
// Used by vite.config.ts (home page + dev server) and scripts/generate-pages.mjs (build).
import { FORMATS, TARGETS, CONVERSIONS, TOOLS } from './seo-data.mjs';

/**
 * Public address of the site, with a trailing slash. Used for canonical links and the sitemap.
 * Change it (or set SITE_URL when building) once the custom domain is live.
 */
export const SITE_URL = (process.env.SITE_URL || 'https://omniviewer3d.com/').replace(/\/?$/, '/');
export const APP = 'OMNIVIEWER';
export const BRAND = 'BANKASI MEDIA';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const strip = (s) => String(s).replace(/<[^>]+>/g, '');
const extList = (f, key) => [key, ...f.alt].map((e) => '.' + e).join(', ');

const COMMON_FAQ = [
  ['Is OMNIVIEWER free?', 'Yes. It is completely free, open source and has no ads, accounts or limits. Donations help pay for hosting and development.'],
  ['Are my files uploaded?', 'No. Files are opened and converted inside your browser and never leave your device, so confidential models stay private.'],
  ['Does it work on Mac, Windows, Linux and phones?', 'Yes. It runs in any modern browser (Chrome, Edge, Firefox, Safari) on desktop, tablet and phone. Nothing to install.'],
  ['Is there a file size limit?', 'There is no fixed limit. Files of several hundred megabytes usually work; the practical limit is your device\'s memory.'],
];

// ------------------------------------------------------------------ page list
export function buildPages() {
  const pages = [];
  pages.push({
    slug: '', kind: 'home',
    title: `${APP} · Free Online 3D Viewer, Converter & Editor`,
    desc: 'Free all-in-one 3D toolkit in your browser. View, convert, scale, measure, paint and edit STL, STEP, OBJ, FBX, GLB, 3MF, IFC, 3DM and 30+ formats. No uploads, no ads, no sign-up.',
    h1: 'Every 3D file.<br />One free <span class="glow">toolkit</span>.',
    lede: 'View, convert, scale, measure, paint and edit 3D models right in your browser. 30+ formats, no uploads, no ads, no sign-up.',
    config: {},
    copy: [
      ['A free 3D toolkit that runs in your browser', [`${APP} opens almost any 3D file, from CAD formats like STEP, IGES and Rhino 3DM to meshes like STL, OBJ, FBX and GLB, building models in IFC, and point clouds. Everything runs locally: nothing is uploaded, and there are no accounts or ads.`, 'Use it to check a part before printing, convert a file for another program, fix the scale of a model, measure a distance, paint a mock-up or make quick edits.']],
    ],
    faq: COMMON_FAQ,
  });

  for (const [key, f] of Object.entries(FORMATS)) {
    const exts = extList(f, key);
    const convs = CONVERSIONS.filter(([a]) => a === key);
    pages.push({
      slug: `${key}-viewer`, kind: 'viewer', key,
      title: `${f.name} Viewer Online · Free, No Upload · Open ${exts} Files`,
      desc: `Free online ${f.name} viewer. Open ${exts} files in your browser, measure, section, scale, paint and convert them to STL, OBJ or GLB. No upload, no install, no ads.`,
      h1: `Free online <span class="glow">${esc(f.name)} viewer</span>.`,
      lede: `Open ${exts} files instantly in your browser. Measure, section, scale and convert them. Your file never leaves your device.`,
      config: { kind: 'viewer', from: key },
      copy: [
        [`What is a ${f.name} file?`, [f.about, `It is used by ${f.users}.`]],
        [`How to open a ${f.name} file online`, null, [`Click <b>Drop files or browse</b> above, or drag your ${exts} file anywhere onto this page.`, 'Orbit with the left mouse button, pan with the right button and zoom with the wheel (or pinch on a phone).', 'Use Measure, Section, Paint, Scale or the editor from the toolbar.', 'Click Export to save it as STL, OBJ, GLB, glTF, PLY or USDZ.']],
        [`Tips for ${f.name} files`, null, f.tips],
      ],
      related: convs.map(([a, b]) => ({ href: `${a}-to-${b}/`, label: `${FORMATS[a].name} to ${TARGETS[b].name}` })),
      faq: [
        [`How do I open a ${f.name} file without software?`, `Open this page and drop the file in. ${APP} reads ${exts} files directly in the browser, so you do not need to install anything.`],
        [`Can I convert ${f.name} to another format?`, `Yes. After opening it, click Export and choose STL, OBJ, GLB, glTF, PLY or USDZ.`],
        ...COMMON_FAQ,
      ],
    });
  }

  for (const [from, to] of CONVERSIONS) {
    const f = FORMATS[from], t = TARGETS[to];
    pages.push({
      slug: `${from}-to-${to}`, kind: 'convert', key: from,
      title: `Convert ${f.name} to ${t.name} Online · Free ${f.name} to ${t.name} Converter`,
      desc: `Convert ${f.name} (${extList(f, from)}) to ${t.name} free in your browser. No upload, no sign-up, no ads. Preview, scale and fix the model before you download.`,
      h1: `Convert <span class="glow">${esc(f.name)} to ${esc(t.name)}</span>.`,
      lede: `Drop a ${f.name} file and download it as ${t.name} in seconds. Conversion happens on your device, so your file is never uploaded.`,
      config: { kind: 'convert', from, to: t.id },
      copy: [
        [`How to convert ${f.name} to ${t.name}`, null, [`Click <b>Drop files or browse</b> above, or drag your ${f.name} file onto this page.`, `Check the preview. Optionally scale it, change units or remove parts.`, `The export window opens with <b>${t.name}</b> selected: click it to download your file.`]],
        [`About ${f.name} and ${t.name}`, [f.about, t.note]],
      ],
      related: CONVERSIONS.filter(([a, b]) => (a === from || b === to) && !(a === from && b === to)).slice(0, 8)
        .map(([a, b]) => ({ href: `${a}-to-${b}/`, label: `${FORMATS[a].name} to ${TARGETS[b].name}` }))
        .concat([{ href: `${from}-viewer/`, label: `${f.name} viewer` }]),
      faq: [
        [`Is this ${f.name} to ${t.name} converter free?`, 'Yes, completely free with no limits, watermarks or sign-up.'],
        [`Will my ${f.name} file be uploaded?`, 'No. The conversion runs in your browser and the file never leaves your device.'],
        [`Can I convert several files at once?`, 'Drop several files together and they open as one scene; export saves them as one file. Export one part at a time by selecting it and ticking "Only the selected part".'],
        COMMON_FAQ[2],
      ],
    });
  }

  for (const t of TOOLS) {
    pages.push({
      slug: t.slug, kind: 'tool',
      title: `${t.title} · ${APP}`,
      desc: t.desc,
      h1: t.h1,
      lede: t.lede,
      config: { kind: 'tool', tool: t.tool },
      copy: [[strip(t.title).split('·')[0].trim(), t.body]],
      faq: COMMON_FAQ,
    });
  }
  return pages;
}

export const PAGES = buildPages();

// ------------------------------------------------------------------ rendering
const url = (slug) => SITE_URL + (slug ? slug + '/' : '');

function toolsGrid() {
  return `<div class="tools-grid">
    <a class="tool-tile" href="./"><i data-icon="eye"></i><b>3D viewer</b><span>Open 30+ formats</span></a>
    ${TOOLS.map((t) => `<a class="tool-tile" href="${t.slug}/"><i data-icon="${t.icon}"></i><b>${esc(t.label)}</b><span>${esc(t.short)}</span></a>`).join('\n    ')}
  </div>`;
}

function linkDirectory() {
  const viewers = Object.entries(FORMATS).map(([k, f]) => `<a href="${k}-viewer/">${esc(f.name)} viewer</a>`).join('');
  const convs = CONVERSIONS.map(([a, b]) => `<a href="${a}-to-${b}/">${esc(FORMATS[a].name)} to ${esc(TARGETS[b].name)}</a>`).join('');
  return `<nav class="seo-links" aria-label="All tools">
    <div><h3>Viewers</h3><div class="link-cloud">${viewers}</div></div>
    <div><h3>Converters</h3><div class="link-cloud">${convs}</div></div>
  </nav>`;
}

function renderSeo(page) {
  const copy = (page.copy || []).map(([h, paras, list]) => `<h2>${esc(h)}</h2>${(paras || []).map((p) => `<p>${p}</p>`).join('')}${list ? `<${page.kind === 'viewer' && h.startsWith('Tips') ? 'ul' : 'ol'}>${list.map((li) => `<li>${li}</li>`).join('')}</${page.kind === 'viewer' && h.startsWith('Tips') ? 'ul' : 'ol'}>` : ''}`).join('\n');
  const related = page.related?.length ? `<h2>Related</h2><div class="link-cloud">${page.related.map((r) => `<a href="${r.href}">${esc(r.label)}</a>`).join('')}</div>` : '';
  const faq = page.faq?.length ? `<h2>Frequently asked questions</h2>${page.faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}` : '';
  return `<section class="seo">
  ${toolsGrid()}
  <article class="seo-copy">${copy}${related}${faq}</article>
  ${linkDirectory()}
</section>`;
}

function jsonLd(page) {
  const app = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: page.kind === 'home' ? APP : strip(page.h1).replace(/\.$/, ''),
    url: url(page.slug),
    description: page.desc,
    applicationCategory: 'DesignApplication',
    operatingSystem: 'Any (web browser)',
    browserRequirements: 'Requires JavaScript and WebGL',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    publisher: { '@type': 'Organization', name: BRAND, url: 'https://bankasimedia.com' },
  };
  const faq = page.faq?.length ? {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: page.faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
  } : null;
  return [app, faq].filter(Boolean).map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('\n    ');
}

/** Fills the index.html template for one page. `base` is set for pages in sub-folders. */
export function renderPage(html, page, { base = '' } = {}) {
  const rep = (re, val) => { if (!re.test(html)) throw new Error('template marker missing: ' + re); html = html.replace(re, () => val); };
  rep(/<title>[\s\S]*?<\/title>/, `<title>${esc(page.title)}</title>`);
  rep(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${esc(page.desc)}" />`);
  rep(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${esc(page.title)}" />`);
  rep(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${esc(page.desc)}" />`);
  rep(/<!--head-extra-->[\s\S]*?<!--\/head-extra-->/, `<!--head-extra-->
    <link rel="canonical" href="${url(page.slug)}" />
    <meta property="og:url" content="${url(page.slug)}" />
    ${jsonLd(page)}
    <!--/head-extra-->`);
  rep(/<!--hero-->[\s\S]*?<!--\/hero-->/, `<!--hero-->
            <h1>${page.h1}</h1>
            <p class="lede">${page.lede}</p>
            <!--/hero-->`);
  rep(/<!--seo-->[\s\S]*?<!--\/seo-->/, `<!--seo-->${renderSeo(page)}<!--/seo-->`);
  rep(/<script id="page-config" type="application\/json">[\s\S]*?<\/script>/, `<script id="page-config" type="application/json">${JSON.stringify(page.config)}</script>`);
  if (base) html = html.replace(/<head>/, `<head>\n    <base href="${base}" />`);
  return html;
}

export function sitemap() {
  const today = new Date().toISOString().slice(0, 10);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PAGES.map((p) => `  <url><loc>${url(p.slug)}</loc><lastmod>${today}</lastmod><priority>${p.kind === 'home' ? '1.0' : p.kind === 'tool' ? '0.9' : '0.8'}</priority></url>`).join('\n')}
</urlset>
`;
}

export const robots = () => `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}sitemap.xml\n`;
