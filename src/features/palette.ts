import * as THREE from 'three';
import { ctx, escHtml } from '../context';
import { commands, type Command } from '../registry';
import { icon } from '../icons';
import { t } from '../i18n';

// ------------------------------------------------------------------ command palette (Ctrl+K)
let el: HTMLDivElement | null = null;
let items: Command[] = [];
let active = 0;

function score(c: Command, q: string): number {
  if (!q) return 1;
  // English and the page language both match, so "capture" finds Save screenshot on French pages (D08).
  const hay = `${c.label} ${t(c.label)} ${c.group} ${t(c.group)} ${c.keywords || ''}`.toLowerCase();
  const label = t(c.label).toLowerCase();
  const STOP = new Set(['to', 'a', 'an', 'the', 'as', 'into', 'in', 'my', 'file', 'model', 'for', 'of']);
  const words = q.toLowerCase().split(/\s+/).filter((w) => w && !STOP.has(w));
  if (!words.length) return 1;
  let s = 0;
  for (const w of words) {
    const i = hay.indexOf(w);
    if (i < 0) return 0;
    s += label.startsWith(w) || c.label.toLowerCase().startsWith(w) ? 5 : label.includes(w) || c.label.toLowerCase().includes(w) ? 3 : 1;
  }
  return s;
}

function render(q: string) {
  if (!el) return;
  items = commands
    .map((c) => ({ c, s: score(c, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || Number(b.c.enabled?.() ?? true) - Number(a.c.enabled?.() ?? true))
    .slice(0, 60)
    .map((x) => x.c);
  active = Math.min(active, Math.max(0, items.length - 1));
  const list = el.querySelector('.pal-list')!;
  let lastGroup = '';
  list.innerHTML = items.length ? items.map((c, i) => {
    const head = !q && c.group !== lastGroup ? `<div class="pal-group">${escHtml(t(c.group))}</div>` : '';
    lastGroup = c.group;
    const off = c.enabled && !c.enabled();
    return `${head}<button class="pal-item ${i === active ? 'active' : ''} ${off ? 'off' : ''}" data-i="${i}"><span>${escHtml(t(c.label))}</span>${q ? `<span class="pal-g">${escHtml(t(c.group))}</span>` : ''}${c.shortcut ? `<kbd>${escHtml(c.shortcut)}</kbd>` : ''}</button>`;
  }).join('') : `<div class="pal-empty">${t('No matching command')}</div>`;
  list.querySelector('.pal-item.active')?.scrollIntoView({ block: 'nearest' });
}

function run(i: number) {
  const c = items[i];
  if (!c) return;
  if (c.enabled && !c.enabled()) { ctx.toast(t('Open a model first (or select a part) to use this')); return; }
  closePalette();
  c.run();
}

export function openPalette() {
  if (el) return;
  el = document.createElement('div');
  el.className = 'palette-wrap';
  el.innerHTML = `<div class="palette-box" role="dialog" aria-label="${t('Command palette')}">
    <div class="pal-search">${icon('search')}<input type="text" placeholder="${t('Search tools and actions… (e.g. to stl, repair, wireframe)')}" aria-label="${t('Search commands')}"/><kbd>Esc</kbd></div>
    <div class="pal-list"></div></div>`;
  document.body.appendChild(el);
  const input = el.querySelector('input')!;
  active = 0;
  render('');
  input.focus();
  input.addEventListener('input', () => { active = 0; render(input.value); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); render(input.value); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(input.value); e.preventDefault(); }
    else if (e.key === 'Enter') { run(active); e.preventDefault(); }
    else if (e.key === 'Escape') { closePalette(); e.preventDefault(); }
  });
  el.addEventListener('mousedown', (e) => { if (e.target === el) closePalette(); });
  el.querySelector('.pal-list')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (b) run(Number(b.dataset.i));
  });
}

export function closePalette() { el?.remove(); el = null; }

// ------------------------------------------------------------------ right-click menu
export interface ContextAction {
  label: string;
  icon: string;
  /** shown when this returns true; `hit` is null for empty space */
  when(hit: THREE.Intersection | null): boolean;
  run(hit: THREE.Intersection | null): void;
  danger?: boolean;
}
export const contextActions: ContextAction[] = [];
export const registerContextAction = (...a: ContextAction[]) => contextActions.push(...a);

let menu: HTMLDivElement | null = null;
function closeMenu() { menu?.remove(); menu = null; }

function openMenu(x: number, y: number, hit: THREE.Intersection | null) {
  closeMenu();
  const list = contextActions.filter((a) => a.when(hit));
  if (!list.length) return;
  menu = document.createElement('div');
  menu.className = 'ctx-menu';
  const name = hit ? (hit.object.name || 'Part') : '';
  menu.innerHTML = (hit ? `<div class="menu-label">${escHtml(name)}</div>` : '') +
    list.map((a, i) => `<button data-i="${i}" class="${a.danger ? 'danger' : ''}">${icon(a.icon)}${escHtml(a.label)}</button>`).join('');
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  menu.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (!b) return;
    const a = list[Number(b.dataset.i)];
    closeMenu();
    a.run(hit);
  });
}

export function initPaletteAndMenu() {
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); el ? closePalette() : openPalette(); }
    else if (e.key === '/' && !(e.target as HTMLElement).closest('input,textarea,select') && !el) { e.preventDefault(); openPalette(); }
    else if (e.key === 'Escape') closeMenu();
  }, true);

  const canvas = ctx.viewer.renderer.domElement;
  let rightDown: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => { if (e.button === 2) rightDown = { x: e.clientX, y: e.clientY }; closeMenu(); });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // Right-drag pans the camera; only a still right-click opens the menu.
    if (rightDown && Math.hypot(e.clientX - rightDown.x, e.clientY - rightDown.y) > 5) return;
    const hit = ctx.viewer.pick(e);
    if (hit) ctx.selectObject(hit.object);
    openMenu(e.clientX, e.clientY, hit);
  });
  window.addEventListener('pointerdown', (e) => { if (menu && !menu.contains(e.target as Node)) closeMenu(); });
  window.addEventListener('blur', closeMenu);
}
