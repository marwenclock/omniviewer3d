// Builds the SEO landing pages (format viewers, converters, tools) in every language.
// Used by vite.config.ts (home page + dev server) and scripts/generate-pages.mjs (build).
import { FORMATS, TARGETS, CONVERSIONS, TOOLS } from './seo-data.mjs';
import { LANGS } from './i18n.mjs';

/**
 * Public address of the site, with a trailing slash. Used for canonical links, hreflang and the sitemap.
 * Override with SITE_URL when building for another domain.
 */
export const SITE_URL = (process.env.SITE_URL || 'https://omniviewer3d.com/').replace(/\/?$/, '/');
export const APP = 'OMNIVIEWER';
export const BRAND = 'BANKASI MEDIA';
export const LANG_CODES = ['en', ...Object.keys(LANGS)];
const LANG_NAMES = { en: 'English', ...Object.fromEntries(Object.entries(LANGS).map(([k, v]) => [k, v.name])) };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const strip = (s) => String(s).replace(/<[^>]+>/g, '');
const extList = (f, key) => [key, ...f.alt].map((e) => '.' + e).join(', ');

// Supportable promises only (audit OV-079): what we can stand behind, with the limits stated.
const COMMON_FAQ = [
  ['Is OMNIVIEWER free?', 'Yes. It is free and open source, with no ads and no account. Donations help pay for hosting and development.'],
  ['Are my files uploaded?', 'No. Files are opened and converted inside your browser and are not uploaded to a server. If you turn recent files on, a copy stays in this browser so you can reopen it; you can turn that off.'],
  ['Does it work on Mac, Windows, Linux and phones?', 'It runs in current Chrome, Edge, Firefox and Safari on desktop, tablet and phone, with nothing to install. It needs WebGL (3D graphics) to be available.'],
  ['Is there a file size limit?', 'There is no fixed limit. Large files depend on your device\'s memory; phones handle less than computers.'],
];

/** Formats without a triangle surface get honest copy (OV-028, OV-073). */
const NO_MESH = { splat: 'splat', pcd: 'points', xyz: 'points', gcode: 'toolpath' };
const LIMIT_TEXT = {
  en: { splat: 'Gaussian splats are a cloud of soft points, not a surface: you can view, frame and screenshot them, but measuring and converting to mesh formats are not available.', points: 'Point clouds have no surface, so repair, volume and STL export do not apply. You can view them, change point size and colour, and measure between points.', toolpath: 'G-code is a printer toolpath made of lines, not a solid: step through it layer by layer, but mesh tools and mesh export do not apply.' },
  es: { splat: 'Los splats gaussianos son una nube de puntos suaves, no una superficie: puedes verlos y hacer capturas, pero no medirlos ni convertirlos a mallas.', points: 'Las nubes de puntos no tienen superficie: la reparación, el volumen y la exportación a STL no se aplican. Puedes verlas y medir entre puntos.', toolpath: 'El G-code es una trayectoria de impresora hecha de líneas, no un sólido: recórrela capa a capa; las herramientas de malla no se aplican.' },
  de: { splat: 'Gaussian Splats sind eine Wolke weicher Punkte, keine Oberfläche: ansehen und Bilder speichern geht, Messen und Umwandeln in Netze nicht.', points: 'Punktwolken haben keine Oberfläche: Reparatur, Volumen und STL-Export gelten nicht. Ansehen und zwischen Punkten messen geht.', toolpath: 'G-Code ist ein Druckerpfad aus Linien, kein Körper: Schicht für Schicht ansehen; Netzwerkzeuge gelten nicht.' },
  fr: { splat: 'Les splats gaussiens sont un nuage de points flous, pas une surface : vous pouvez les voir et les capturer, mais pas les mesurer ni les convertir en maillage.', points: 'Les nuages de points n’ont pas de surface : réparation, volume et export STL ne s’appliquent pas. Vous pouvez les voir et mesurer entre des points.', toolpath: 'Le G-code est un parcours d’imprimante fait de lignes, pas un solide : parcourez-le couche par couche ; les outils de maillage ne s’appliquent pas.' },
  pt: { splat: 'Splats gaussianos são uma nuvem de pontos suaves, não uma superfície: dá para ver e capturar, mas não medir nem converter em malha.', points: 'Nuvens de pontos não têm superfície: reparo, volume e exportação STL não se aplicam. Dá para ver e medir entre pontos.', toolpath: 'G-code é um caminho de impressora feito de linhas, não um sólido: veja camada por camada; ferramentas de malha não se aplicam.' },
};
/** What to know before opening each format (OV-076): companion files, units, exactness. */
const FORMAT_NOTES = {
  obj: ['Open the .obj together with its .mtl file and texture images (or drop the folder or a ZIP).', 'OBJ stores no units: check the size after opening.'],
  gltf: ['A .gltf usually needs its .bin file and images: drop them together, or convert to a self-contained GLB.'],
  glb: ['GLB is defined in metres, so its real size is known.'],
  fbx: ['Textures are often separate image files: include them.', 'Animation clips can be played and exported to GLB.'],
  dae: ['COLLADA files often reference separate textures: include them.'],
  '3ds': ['Textures are separate image files: include them.'],
  lwo: ['Textures are separate image files: include them.'],
  stl: ['STL stores no units. Most STL files are in millimetres; OMNIVIEWER checks whether the size looks plausible.'],
  ply: ['PLY can hold a mesh or a point cloud; OMNIVIEWER detects which one from the content.', 'PLY stores no units.'],
  step: ['STEP models are shown as a triangle mesh (tessellated). Measurements are close approximations of the exact CAD surfaces, and the model is not editable as CAD.'],
  iges: ['IGES files can contain open surfaces, which are not solids for printing. They are shown as a triangle mesh.'],
  brep: ['BREP models are shown as a triangle mesh; they are not editable as CAD here.'],
  '3dm': ['Rhino files keep their declared units. Curves and surfaces are shown through their render meshes.'],
  ifc: ['Elements are grouped by storey and type, with their properties. Mesh exports do not keep IFC properties.'],
  '3mf': ['3MF declares its unit, so the real size is known.'],
  off: ['OFF stores no units. Polygon faces are triangulated, including concave ones.'],
  usdz: ['Common USD files open; advanced USD features may not be shown.'],
  kmz: ['The 3D model inside the KMZ is shown, not the map location.'],
  vtk: ['Polygon and point data open; scientific fields (scalars, vectors) are not visualised.'],
  md2: ['Keyframe animation plays in the viewer.'],
};

const toolTr = (lang, slug) => {
  if (lang === 'en') return null;
  const t = LANGS[lang].tools[slug];
  return t ? { label: t[0], short: t[1], title: t[2], h1: t[3], lede: t[4], desc: t[5] } : null;
};

// ------------------------------------------------------------------ page list
function buildPages(lang) {
  const L = lang === 'en' ? null : LANGS[lang];
  const pages = [];
  const add = (p) => pages.push({ lang, ...p });

  add(L ? {
    slug: '', kind: 'home', title: L.home.title, desc: L.home.desc, h1: L.home.h1, lede: L.home.lede, config: {},
    copy: [[L.home.h2, L.home.body]], faq: L.common,
  } : {
    slug: '', kind: 'home',
    title: `${APP} · Free Online 3D Viewer, Converter & Editor`,
    desc: 'Free all-in-one 3D toolkit in your browser. View, convert, scale, measure, paint and edit STL, STEP, OBJ, FBX, GLB, 3MF, IFC, 3DM and 30+ formats. No uploads, no ads, no sign-up.',
    h1: 'Every 3D file.<br />One free <span class="glow">toolkit</span>.',
    lede: 'View, convert, scale, measure, paint and edit 3D models right in your browser. 30+ formats, no uploads, no ads, no sign-up.',
    config: {},
    copy: [['A free 3D toolkit that runs in your browser', [`${APP} opens almost any 3D file, from CAD formats like STEP, IGES and Rhino 3DM to meshes like STL, OBJ, FBX and GLB, building models in IFC, point clouds and Gaussian splats. Everything runs locally: nothing is uploaded, and there are no accounts or ads.`, 'Use it to check a part before printing, convert a file for another program, fix the scale of a model, repair a mesh, estimate print cost, measure a distance, paint a mock-up or make quick edits.']]],
    faq: COMMON_FAQ,
  });

  for (const [key, f] of Object.entries(FORMATS)) {
    const exts = extList(f, key);
    const related = CONVERSIONS.filter(([a]) => a === key).map(([a, b]) => ({ href: `${a}-to-${b}/`, label: `${FORMATS[a].name} → ${TARGETS[b].name}` }));
    const nm = NO_MESH[key];
    add(L ? {
      slug: `${key}-viewer`, kind: 'viewer', key,
      title: L.viewer.title(f.name, exts), desc: L.viewer.desc(f.name, exts), h1: L.viewer.h1(esc(f.name)), lede: nm ? LIMIT_TEXT[lang][nm] : L.viewer.lede(exts),
      config: { kind: 'viewer', from: key },
      copy: [[L.viewer.what(f.name), [L.formats[key] || f.about, ...(nm ? [LIMIT_TEXT[lang][nm]] : [])]], [L.viewer.how(f.name), null, L.viewer.steps(exts)]],
      related, faq: [...L.viewer.faq(f.name, exts), ...L.common],
    } : nm ? {
      slug: `${key}-viewer`, kind: 'viewer', key,
      title: `${f.name} Viewer Online · Free, No Upload · Open ${exts} Files`,
      desc: `Free online ${f.name} viewer. Open ${exts} files in your browser, processed on your device. No install, no ads.`,
      h1: `Free online <span class="glow">${esc(f.name)} viewer</span>.`,
      lede: `Open ${exts} files in your browser. ${LIMIT_TEXT.en[nm]}`,
      config: { kind: 'viewer', from: key },
      copy: [
        [`What is a ${f.name} file?`, [f.about, `It is used by ${f.users}.`]],
        [`What you can do with ${f.name} files here`, [LIMIT_TEXT.en[nm]], f.tips, 'ul'],
        [`How to open a ${f.name} file online`, null, [`Click <b>Open</b> above, or drag your ${exts} file anywhere onto this page.`, 'Orbit with the left mouse button, pan with the right button and zoom with the wheel (or pinch on a phone).']],
      ],
      related,
      faq: [[`How do I open a ${f.name} file without software?`, `Open this page and drop the file in. ${APP} reads ${exts} files directly in the browser.`], ...COMMON_FAQ],
    } : {
      slug: `${key}-viewer`, kind: 'viewer', key,
      title: `${f.name} Viewer Online · Free, No Upload · Open ${exts} Files`,
      desc: `Free online ${f.name} viewer. Open ${exts} files in your browser, measure, section, scale, paint and convert them to STL, OBJ or GLB. No upload, no install, no ads.`,
      h1: `Free online <span class="glow">${esc(f.name)} viewer</span>.`,
      lede: `Open ${exts} files in your browser to measure, section, scale and convert them. Processed on your device, never uploaded.`,
      config: { kind: 'viewer', from: key },
      copy: [
        [`What is a ${f.name} file?`, [f.about, `It is used by ${f.users}.`]],
        [`How to open a ${f.name} file online`, null, [`Click <b>Open</b> above, or drag your ${exts} file anywhere onto this page.`, 'Orbit with the left mouse button, pan with the right button and zoom with the wheel (or pinch on a phone).', 'Use Measure, Section, Paint, Scale, Repair or the editor from the toolbar.', 'Click Export, check what the chosen format keeps, and download it as STL, 3MF, OBJ, GLB, glTF, PLY or USDZ.']],
        [`Tips for ${f.name} files`, null, [...(FORMAT_NOTES[key] || []), ...f.tips], 'ul'],
      ],
      related,
      faq: [
        [`How do I open a ${f.name} file without software?`, `Open this page and drop the file in. ${APP} reads ${exts} files directly in the browser, so you do not need to install anything.`],
        [`Can I convert ${f.name} to another format?`, 'Yes. After opening it, click Export and choose STL, OBJ, GLB, glTF, PLY, USDZ or 3MF.'],
        ...COMMON_FAQ,
      ],
    });
  }

  for (const [from, to] of CONVERSIONS) {
    const f = FORMATS[from], t = TARGETS[to];
    const related = CONVERSIONS.filter(([a, b]) => (a === from || b === to) && !(a === from && b === to)).slice(0, 8)
      .map(([a, b]) => ({ href: `${a}-to-${b}/`, label: `${FORMATS[a].name} → ${TARGETS[b].name}` }))
      .concat([{ href: `${from}-viewer/`, label: L ? `${L.ui.viewer3d}: ${f.name}` : `${f.name} viewer` }]);
    add(L ? {
      slug: `${from}-to-${to}`, kind: 'convert', key: from,
      title: L.convert.title(f.name, t.name), desc: L.convert.desc(f.name, t.name), h1: L.convert.h1(esc(f.name), esc(t.name)), lede: L.convert.lede(f.name, t.name),
      config: { kind: 'convert', from, to: t.id },
      copy: [[L.convert.how(f.name, t.name), null, L.convert.steps(f.name, t.name)], [L.convert.about(f.name, t.name), [L.formats[from] || f.about, L.targets[to] || t.note]]],
      related, faq: [...L.convert.faq(f.name, t.name), L.common[2]],
    } : {
      slug: `${from}-to-${to}`, kind: 'convert', key: from,
      title: `Convert ${f.name} to ${t.name} Online · Free ${f.name} to ${t.name} Converter`,
      desc: `Convert ${f.name} (${extList(f, from)}) to ${t.name} free in your browser. No upload, no sign-up, no ads. Preview, scale and fix the model before you download.`,
      h1: `Convert <span class="glow">${esc(f.name)} to ${esc(t.name)}</span>.`,
      lede: `Drop a ${f.name} file and download it as ${t.name}, with the real size kept. Conversion happens on your device, so your file is not uploaded.`,
      config: { kind: 'convert', from, to: t.id },
      copy: [
        [`How to convert ${f.name} to ${t.name}`, null, [`Click <b>Open</b> above, or drag your ${f.name} file onto this page.`, 'Check the preview and the size. Optionally confirm units, repair it or hide parts you don\'t want.', `The export window opens with <b>${t.name}</b> selected and shows what is kept and lost, the real size and the orientation. Click Download.`]],
        [`About ${f.name} and ${t.name}`, [f.about, t.note, ...(FORMAT_NOTES[from] || [])]],
      ],
      related,
      faq: [
        [`Is this ${f.name} to ${t.name} converter free?`, 'Yes, free with no watermarks or sign-up.'],
        [`Will my ${f.name} file be uploaded?`, 'No. The conversion runs in your browser; the file is not sent to a server.'],
        [`Will the size be correct in ${t.name}?`, t.id === 'glb' || t.id === 'gltf' || t.id === 'usdz' ? `Yes. ${t.name} is defined in metres, so the model is converted from its own unit. Check the unit shown after opening, especially for formats without units such as STL.` : t.id === '3mf' ? '3MF declares its unit, so slicers read the real size.' : `${t.name} files store no units; the numbers are written in millimetres by default, which slicers expect. You can choose another unit in the export window.`],
        ['Can I convert several files at once?', 'Yes: use the batch converter in the Tools menu to convert many files into one ZIP.'],
        COMMON_FAQ[2],
      ],
    });
  }

  for (const t of TOOLS) {
    const tr = toolTr(lang, t.slug);
    add({
      slug: t.slug, kind: 'tool',
      title: `${tr ? tr.title : t.title} · ${APP}`,
      desc: tr ? tr.desc : t.desc,
      h1: tr ? tr.h1 : t.h1,
      lede: tr ? tr.lede : t.lede,
      config: { kind: 'tool', tool: t.tool },
      copy: [[strip(tr ? tr.title : t.title).split('·')[0].trim(), tr ? [tr.desc] : t.body]],
      faq: L ? L.common : COMMON_FAQ,
    });
  }
  return pages;
}

export const PAGES = LANG_CODES.flatMap(buildPages);

// ------------------------------------------------------------------ rendering
const prefix = (lang) => (lang === 'en' ? '' : lang + '/');
export const pagePath = (p) => prefix(p.lang) + (p.slug ? p.slug + '/' : '');
const url = (p) => SITE_URL + pagePath(p);
export const ogName = (p) => `og/${p.lang}-${p.slug || 'home'}.png`;

function toolsGrid(lang) {
  const pre = prefix(lang);
  const L = LANGS[lang];
  return `<div class="tools-grid">
    <a class="tool-tile" href="${pre || './'}"><i data-icon="eye"></i><b>${L ? L.ui.viewer3d : '3D viewer'}</b><span>${L ? L.ui.viewer3dShort : 'Open 30+ formats'}</span></a>
    ${TOOLS.map((t) => { const tr = toolTr(lang, t.slug); return `<a class="tool-tile" href="${pre}${t.slug}/"><i data-icon="${t.icon}"></i><b>${esc(tr ? tr.label : t.label)}</b><span>${esc(tr ? tr.short : t.short)}</span></a>`; }).join('\n    ')}
  </div>`;
}

function linkDirectory(page) {
  const pre = prefix(page.lang);
  const L = LANGS[page.lang];
  const viewers = Object.entries(FORMATS).map(([k, f]) => `<a href="${pre}${k}-viewer/">${L ? esc(f.name) : `${esc(f.name)} viewer`}</a>`).join('');
  const convs = CONVERSIONS.map(([a, b]) => `<a href="${pre}${a}-to-${b}/">${esc(FORMATS[a].name)} ${L ? '→' : 'to'} ${esc(TARGETS[b].name)}</a>`).join('');
  const langs = LANG_CODES.map((l) => `<a href="${prefix(l)}${page.slug ? page.slug + '/' : (l === 'en' ? './' : '')}" hreflang="${l}" ${l === page.lang ? 'aria-current="page"' : ''}>${LANG_NAMES[l]}</a>`).join('');
  return `<nav class="seo-links" aria-label="All tools">
    <div><h3>${L ? L.ui.viewers : 'Viewers'}</h3><div class="link-cloud">${viewers}</div></div>
    <div><h3>${L ? L.ui.converters : 'Converters'}</h3><div class="link-cloud">${convs}</div></div>
    <div><h3>${L ? L.ui.languages : 'Languages'}</h3><div class="link-cloud lang-links">${langs}</div></div>
  </nav>`;
}

function renderSeo(page) {
  const L = LANGS[page.lang];
  const pre = prefix(page.lang);
  const copy = (page.copy || []).map(([h, paras, list, listType]) => {
    const tag = listType || 'ol';
    return `<h2>${esc(h)}</h2>${(paras || []).map((p) => `<p>${p}</p>`).join('')}${list ? `<${tag}>${list.map((li) => `<li>${li}</li>`).join('')}</${tag}>` : ''}`;
  }).join('\n');
  const related = page.related?.length ? `<h2>${L ? L.ui.related : 'Related'}</h2><div class="link-cloud">${page.related.map((r) => `<a href="${pre}${r.href}">${esc(r.label)}</a>`).join('')}</div>` : '';
  const faq = page.faq?.length ? `<h2>${L ? L.ui.faq : 'Frequently asked questions'}</h2>${page.faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}` : '';
  // Task help first, related next; the full tool directory comes last and folded (OV-045).
  return `<section class="seo">
  <article class="seo-copy">${copy}${related}${faq}</article>
  <details class="seo-dir"><summary>${L ? L.ui.viewers + ' · ' + L.ui.converters : 'All tools, viewers and converters'}</summary>
  ${toolsGrid(page.lang)}
  ${linkDirectory(page)}
  </details>
</section>`;
}

function jsonLd(page) {
  const app = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: page.kind === 'home' ? APP : strip(page.h1).replace(/\.$/, ''),
    url: url(page),
    description: page.desc,
    inLanguage: page.lang,
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
  return [app, faq].filter(Boolean).map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`).join('\n    ');
}

const UI_STRINGS = (L) => [
  ['<span class="card-label">[open]</span>', `<span class="card-label">${L.ui.open}</span>`],
  ['<span class="dz-title" id="dzTitle">Drop a model, folder or ZIP</span>', `<span class="dz-title" id="dzTitle">${L.ui.drop}</span>`],
  ['<span class="card-label">From link</span>', `<span class="card-label">${L.ui.fromLink}</span>`],
  ['<span class="card-title">Open a model URL</span>', `<span class="card-title">${L.ui.openUrl}</span>`],
  ['<span class="card-label">Build</span>', `<span class="card-label">${L.ui.build}</span>`],
  ['<span class="card-title">Start an empty scene</span>', `<span class="card-title">${L.ui.empty}</span>`],
  ['<span class="ex-label">Try an example:</span>', `<span class="ex-label">${L.ui.example}</span>`],
  ['<strong>Completely free. No ads. Open source.</strong>', `<strong>${L.ui.freeTitle}</strong>`],
  ['<span>To support hosting and development, donations are welcome.</span>', `<span>${L.ui.freeSub}</span>`],
];

/** Fills the index.html template for one page. */
export function renderPage(html, page) {
  const rep = (re, val) => { if (!re.test(html)) throw new Error('template marker missing: ' + re); html = html.replace(re, () => val); };
  const L = LANGS[page.lang];
  rep(/<html lang="[^"]*">/, `<html lang="${page.lang}">`);
  rep(/<title>[\s\S]*?<\/title>/, `<title>${esc(page.title)}</title>`);
  rep(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${esc(page.desc)}" />`);
  rep(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${esc(page.title)}" />`);
  rep(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${esc(page.desc)}" />`);
  rep(/<meta name="twitter:card" content="[^"]*" \/>/, '<meta name="twitter:card" content="summary_large_image" />');
  const siblings = PAGES.filter((p) => p.slug === page.slug && p.kind === page.kind);
  rep(/<!--head-extra-->[\s\S]*?<!--\/head-extra-->/, `<!--head-extra-->
    <link rel="canonical" href="${url(page)}" />
    ${siblings.map((p) => `<link rel="alternate" hreflang="${p.lang}" href="${url(p)}" />`).join('\n    ')}
    <link rel="alternate" hreflang="x-default" href="${url(siblings.find((p) => p.lang === 'en') || page)}" />
    <meta property="og:url" content="${url(page)}" />
    <meta property="og:locale" content="${L ? L.locale : 'en_US'}" />
    <meta property="og:image" content="${SITE_URL}${ogName(page)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    ${jsonLd(page)}
    <!--/head-extra-->`);
  rep(/<!--hero-->[\s\S]*?<!--\/hero-->/, `<!--hero-->
            <h1>${page.h1}</h1>
            <p class="lede">${page.lede}</p>
            <!--/hero-->`);
  rep(/<!--seo-->[\s\S]*?<!--\/seo-->/, `<!--seo-->${renderSeo(page)}<!--/seo-->`);
  rep(/<script id="page-config" type="application\/json">[\s\S]*?<\/script>/, `<script id="page-config" type="application/json">${JSON.stringify({ ...page.config, lang: page.lang })}</script>`);
  if (L) for (const [a, b] of UI_STRINGS(L)) html = html.replace(a, b);
  // The brand link goes to the home page in the same language (OV-075).
  if (L) html = html.replace('<a class="brand-home" href="./"', `<a class="brand-home" href="${prefix(page.lang)}"`);
  const depth = (page.lang === 'en' ? 0 : 1) + (page.slug ? 1 : 0);
  if (depth) html = html.replace(/<head>/, `<head>\n    <base href="${'../'.repeat(depth)}" />`);
  return html;
}

// ------------------------------------------------------------------ share image (1200×630)
export function ogSvg(page) {
  const title = strip(page.h1).replace(/\s+/g, ' ').trim();
  const words = title.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > 24 && line) { lines.push(line); line = w; } else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line);
  const size = lines.length > 3 ? 62 : 76;
  const L = LANGS[page.lang];
  const tagline = L ? `${L.ui.freeTitle}` : 'Free · No ads · Files never leave your device';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs><radialGradient id="g" cx="18%" cy="0%" r="90%"><stop offset="0" stop-color="#262626"/><stop offset="1" stop-color="#0a0a0a"/></radialGradient></defs>
  <rect width="1200" height="630" fill="url(#g)"/>
  <g transform="translate(80 78) scale(1.9)" fill="none" stroke="#f5f5f5" stroke-width="2.4" stroke-linejoin="round">
    <path d="M1.6 11C5.6 4.6 10.9 1.6 17 1.6S28.4 4.6 32.4 11C28.4 17.4 23.1 20.4 17 20.4S5.6 17.4 1.6 11z"/><circle cx="17" cy="11" r="5.4"/><circle cx="17" cy="11" r="2.1" fill="#f5f5f5"/>
  </g>
  <text x="154" y="112" font-family="Geist" font-weight="700" font-size="38" letter-spacing="7.6" fill="#ffffff">MNIVIEWER</text>
  <rect x="500" y="80" width="1.5" height="40" fill="#3a3a3a"/>
  <text x="518" y="114" font-family="Geist" font-size="20" fill="#8a8a8a">by <tspan font-weight="700" letter-spacing="3.6" fill="#e6e6e6">BANKASI</tspan><tspan font-size="11" dy="-9" letter-spacing="2.4" fill="#a0a0a0"> MEDIA</tspan></text>
  ${lines.slice(0, 4).map((l, i) => `<text x="80" y="${250 + i * size * 1.08}" font-family="Geist" font-weight="700" font-size="${size}" letter-spacing="-2" fill="#ffffff">${esc(l)}</text>`).join('\n  ')}
  <rect x="80" y="528" width="1040" height="1" fill="#2e2e2e"/>
  <text x="80" y="574" font-family="Geist" font-size="24" fill="#a8a8a8">${esc(tagline)}</text>
  <text x="1120" y="574" text-anchor="end" font-family="Geist" font-weight="700" font-size="24" letter-spacing="1" fill="#e6e6e6">${esc(SITE_URL.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</text>
</svg>`;
}

export function sitemap() {
  const today = new Date().toISOString().slice(0, 10);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${PAGES.map((p) => {
    const sibs = PAGES.filter((q) => q.slug === p.slug && q.kind === p.kind);
    return `  <url><loc>${url(p)}</loc><lastmod>${today}</lastmod><priority>${p.kind === 'home' ? '1.0' : p.kind === 'tool' ? '0.9' : '0.8'}</priority>${sibs.map((q) => `<xhtml:link rel="alternate" hreflang="${q.lang}" href="${url(q)}"/>`).join('')}</url>`;
  }).join('\n')}
</urlset>
`;
}

export const robots = () => `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}sitemap.xml\n`;
