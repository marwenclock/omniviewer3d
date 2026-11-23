// Tool bar layouts. D ("combo": labelled tool rail + tool column on the view's edge + camera dock) is the default
// on screens wider than 900px. ?layout=classic | dock | rail | split | combo picks one explicitly and shows a
// switcher (always shown in dev). Phones, narrow windows and embeds keep the classic header tool bar.
// The real buttons are moved (not copied) wherever possible, so every click handler, active state and
// disabled state keeps working.
import './layoutlab.css';
import { hydrateIcons } from './icons';

const VARIANTS: Record<string, string> = {
  classic: 'Classic',
  dock: 'A · Bottom dock',
  rail: 'B · Dock + tool rail',
  split: 'C · Split edges',
  combo: 'D · Rail + split + dock',
};

/** Short captions shown under the icons in the dock (the full name stays in the tooltip). */
const SHORT: Record<string, string> = {
  'Fit to window': 'Fit', 'Camera views': 'Views', 'Display mode': 'Display', 'Section plane': 'Section',
  'Explode view': 'Explode', 'Compare models': 'Compare', 'Repair and check': 'Repair', 'Printer bed check': 'Bed',
  'Wall thickness': 'Walls', 'Overhang map': 'Overhang', Screenshot: 'Shot', 'Turntable video or GIF': 'Turntable',
  'Share or embed': 'Share', Move: 'Move', Rotate: 'Rotate', Scale: 'Scale', 'Add shape': 'Add', Undo: 'Undo', Redo: 'Redo',
};

/** Groups that live outside the tool bar in a lab layout; layoutToolbar() puts them back here, not in the bar. */
export const labHome = new WeakMap<HTMLElement, HTMLElement>();

export function initLayoutLab() {
  const params = new URLSearchParams(location.search);
  const requested = params.get('layout');
  const embed = params.get('embed') === '1' || new URLSearchParams(location.hash.slice(1)).get('embed') === '1';
  let layout = requested && VARIANTS[requested] ? requested : embed || innerWidth <= 900 ? 'classic' : 'combo';
  if (embed) layout = 'classic';
  if (import.meta.env.DEV || requested !== null) { addSwitcher(layout); document.body.classList.add('lab-has-switch'); }
  if (layout === 'classic') return;

  document.body.classList.add('lab', `lab-${layout}`);
  if (layout === 'combo') document.body.classList.add('lab-split');
  const stage = document.getElementById('stage')!;
  const toolbar = document.getElementById('toolbar')!;

  // Captions under every icon-only button.
  toolbar.querySelectorAll<HTMLElement>('.tb').forEach((b) => {
    if (b.querySelector(':scope > span')) return;
    const name = SHORT[b.getAttribute('aria-label') || ''];
    if (!name) return;
    const s = document.createElement('span');
    s.className = 'dl';
    s.textContent = name;
    const chev = b.querySelector('.chev');
    b.insertBefore(s, chev);
  });

  // Glass panels (backdrop-filter) would trap the fixed-position menus inside them, so menus live on <body>.
  toolbar.querySelectorAll<HTMLElement>('.menu').forEach((m) => document.body.appendChild(m));

  // The tool bar leaves the header and floats over the 3D view.
  const host = document.createElement('div');
  host.className = 'lab-host';
  host.appendChild(toolbar);
  stage.appendChild(host);

  if (layout === 'dock' || layout === 'rail') {
    // Output tools and undo/redo get their own small pill in the top-right corner of the view.
    const pill = document.createElement('div');
    pill.className = 'lab-pill lab-tr';
    host.appendChild(pill);
    for (const name of ['present', 'history']) {
      const g = toolbar.querySelector<HTMLElement>(`.tb-group[data-group="${name}"]`)!;
      pill.appendChild(g);
      labHome.set(g, pill);
    }
  }
  if (layout === 'split' || layout === 'combo') {
    // Camera controls and undo/redo share one pill at the bottom centre.
    const pill = document.createElement('div');
    pill.className = 'lab-pill lab-bc';
    host.appendChild(pill);
    for (const name of ['view', 'history']) {
      const g = toolbar.querySelector<HTMLElement>(`.tb-group[data-group="${name}"]`)!;
      pill.appendChild(g);
      labHome.set(g, pill);
    }
  }
  if (layout === 'rail' || layout === 'combo') buildRail();
}

/** Every tool once, in one labelled column on the far left, grouped by what you are doing. Move / Rotate / Scale
 *  are not here: they appear next to the part you select (features/selbar.ts) and stay on W / E / R. The floating
 *  tool column and the "Tools" button are hidden in this layout, so there is one place to look instead of three. */
const RAIL: { label: string; items: { tool?: string; menu?: string; icon: string; name: string; tip: string }[] }[] = [
  { label: 'Inspect', items: [
    { tool: 'measure', icon: 'ruler', name: 'Measure', tip: 'Measure (M)' },
    { tool: 'section', icon: 'section', name: 'Section', tip: 'Section plane (X)' },
    { tool: 'explode', icon: 'explode', name: 'Explode', tip: 'Explode view' },
    { tool: 'compare', icon: 'compare', name: 'Compare', tip: 'Compare models' },
    { tool: 'clash', icon: 'clash', name: 'Clash', tip: 'Clash check' },
    { tool: 'report', icon: 'report', name: 'Report', tip: 'Inspection report' },
    { tool: 'drawing', icon: 'drawing', name: 'Drawing', tip: 'Technical drawing' },
  ] },
  { label: 'Print & fix', items: [
    { tool: 'repair', icon: 'repair', name: 'Repair', tip: 'Repair & check' },
    { tool: 'bed', icon: 'bed', name: 'Bed', tip: 'Printer bed check' },
    { tool: 'thickness', icon: 'thickness', name: 'Walls', tip: 'Wall thickness' },
    { tool: 'overhang', icon: 'overhang', name: 'Overhang', tip: 'Overhangs' },
    { tool: 'reduce', icon: 'reduce', name: 'Reduce', tip: 'Reduce & optimise' },
    { tool: 'hollow', icon: 'hollow', name: 'Hollow', tip: 'Hollow' },
    { tool: 'cut', icon: 'cut', name: 'Cut', tip: 'Cut / split' },
    { tool: 'layflat', icon: 'layflat', name: 'Lay flat', tip: 'Place face on floor' },
  ] },
  { label: 'Build', items: [
    { menu: 'add', icon: 'shapes', name: 'Shapes', tip: 'Add a box, sphere, cylinder…' },
    { tool: 'paint', icon: 'brush', name: 'Paint', tip: 'Paint (P)' },
    { tool: 'text', icon: 'text', name: '3D text', tip: '3D text' },
    { tool: 'svg', icon: 'logo', name: 'SVG logo', tip: 'SVG logo' },
    { tool: 'boolean', icon: 'boolean', name: 'Boolean', tip: 'Combine / subtract' },
  ] },
  { label: 'More', items: [
    { menu: 'tools', icon: 'more', name: 'More', tip: 'Files & textures, saved views, batch convert, AR…' },
  ] },
];

function buildRail() {
  const rail = document.createElement('nav');
  rail.className = 'lab-railnav';
  rail.setAttribute('aria-label', 'All tools');
  for (const sec of RAIL) {
    const group = document.createElement('div');
    group.className = 'rail-group';
    group.innerHTML = `<div class="rail-label">${sec.label}</div>`;
    for (const it of sec.items) {
      const b = document.createElement('button');
      b.className = 'rail-btn needs-model';
      if (it.tool) b.dataset.tool = it.tool;
      if (it.menu) { b.dataset.menu = it.menu; b.setAttribute('aria-haspopup', 'menu'); }
      if (it.menu === 'add' || it.menu === 'tools') b.classList.remove('needs-model'); // work in an empty scene too
      b.dataset.tip = it.tip;
      b.setAttribute('aria-label', it.tip.replace(/ \(.\)$/, ''));
      b.innerHTML = `<i data-icon="${it.icon}"></i><span>${it.name}</span>`;
      group.appendChild(b);
    }
    rail.appendChild(group);
  }
  // The "More" menu keeps only what the rail doesn't already show.
  const menu = document.getElementById('menu-tools')!;
  for (const el of Array.from(menu.children) as HTMLElement[]) {
    const t = (el as HTMLElement).dataset.tool;
    if (el.classList.contains('menu-label') || el.classList.contains('menu-sep')) el.classList.add('rail-dup');
    else if (t && t !== 'assets' && t !== 'views') el.classList.add('rail-dup');
  }
  document.body.classList.add('lab-railed');
  document.getElementById('layout')!.prepend(rail);
  hydrateIcons(rail);
}

function addSwitcher(current: string) {
  const bar = document.createElement('div');
  bar.className = 'lab-switch';
  bar.innerHTML = '<b>Layout</b>' + Object.entries(VARIANTS).map(([k, v]) =>
    `<a href="?layout=${k}" class="${k === current ? 'on' : ''}">${v}</a>`).join('');
  document.body.appendChild(bar);
}
