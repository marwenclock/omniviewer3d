// Layout lab: experimental arrangements of the tool bar, picked with ?layout=dock | rail | split.
// The real buttons are moved (not copied) wherever possible, so every click handler, active state and
// disabled state keeps working. Without ?layout the page is unchanged.
import './layoutlab.css';

const VARIANTS: Record<string, string> = {
  '': 'Current',
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
  const layout = params.get('layout') || '';
  const dev = import.meta.env.DEV || params.has('layout');
  if (!dev) return;
  addSwitcher(layout);
  if (!VARIANTS[layout] || !layout) return;

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

/** Variant B: the tools hidden in the "Tools" menu get a permanent, labelled column on the far left. */
function buildRail() {
  const menu = document.getElementById('menu-tools')!;
  const rail = document.createElement('nav');
  rail.className = 'lab-railnav';
  rail.setAttribute('aria-label', 'All tools');
  let group: HTMLElement | null = null;
  for (const el of Array.from(menu.children) as HTMLElement[]) {
    if (el.classList.contains('menu-label')) {
      if (el.textContent === 'More') break;
      group = document.createElement('div');
      group.className = 'rail-group';
      const h = document.createElement('div');
      h.className = 'rail-label';
      h.textContent = el.textContent;
      group.appendChild(h);
      rail.appendChild(group);
    } else if (el.tagName === 'BUTTON' && group && el.dataset.tool) {
      const b = document.createElement('button');
      b.className = 'rail-btn needs-model';
      b.dataset.tool = el.dataset.tool;
      b.dataset.tip = el.textContent!.trim();
      b.setAttribute('aria-label', el.textContent!.trim());
      const icon = el.querySelector('i, svg')!.cloneNode(true) as HTMLElement;
      const label = document.createElement('span');
      label.textContent = railName(el.textContent!.trim());
      b.append(icon, label);
      group.appendChild(b);
    }
  }
  // Move / Rotate / Scale / Add shape join the rail as its first section.
  const edit = document.querySelector<HTMLElement>('#toolbar .tb-group[data-group="edit"]')!;
  const sec = document.createElement('div');
  sec.className = 'rail-group rail-edit';
  sec.innerHTML = '<div class="rail-label">Edit</div>';
  sec.appendChild(edit);
  labHome.set(edit, sec);
  rail.prepend(sec);
  document.getElementById('layout')!.prepend(rail);
}
function railName(s: string) {
  const map: Record<string, string> = {
    'Files & textures': 'Files', 'Clash check': 'Clash', 'Saved views': 'Views', 'Inspection report': 'Report',
    'Technical drawing': 'Drawing', 'Reduce & optimise': 'Reduce', 'Cut / split': 'Cut', 'Place face on floor': 'Lay flat',
    '3D text': '3D text', 'SVG logo': 'SVG logo', 'Combine / subtract': 'Boolean',
  };
  return map[s] || s;
}

function addSwitcher(current: string) {
  const bar = document.createElement('div');
  bar.className = 'lab-switch';
  bar.innerHTML = '<b>Layout</b>' + Object.entries(VARIANTS).map(([k, v]) =>
    `<a href="?${k ? 'layout=' + k : ''}" class="${k === current ? 'on' : ''}">${v}</a>`).join('');
  document.body.appendChild(bar);
}
