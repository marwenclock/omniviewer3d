import * as THREE from 'three';
import { ctx } from '../context';

// The active tool's main control floats as a pill under the model (explode amount, section position, paint colour,
// measure mode…), so using the tool you just picked never means hunting for a slider in a side panel. The Details
// panel keeps the full settings. Placed under the model's on-screen box when the tool starts and when the camera
// moves, but not while its own slider changes the model (exploding grows the box: the pill must not run away from
// the cursor). Phones: docked above the bottom bar.

export interface ToolPill { sync(): void; el: HTMLElement }

export function initToolPill(opts: {
  /** inner HTML for the active tool, or '' for no pill */
  html(): string;
  /** wires up controls after each render */
  bind(host: HTMLElement): void;
}): ToolPill | null {
  const stage = document.getElementById('stage');
  if (!stage) return null;
  const { viewer } = ctx;
  const el = document.createElement('div');
  el.className = 'toolpill hidden';
  el.setAttribute('role', 'toolbar');
  stage.appendChild(el);

  let lastHtml = '';
  let lastTool = '';
  let lastModel: THREE.Object3D | null = null;
  let pressed = false;
  let pending = false;
  let visible = false;
  let docked = false;
  let lastCss = '';
  const box = new THREE.Box3();
  const corners = Array.from({ length: 8 }, () => new THREE.Vector3());

  el.addEventListener('pointerdown', (e) => { e.stopPropagation(); pressed = true; });
  const release = () => { if (!pressed) return; pressed = false; if (pending) { pending = false; sync(); } };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

  const measureBox = () => { box.makeEmpty(); if (viewer.model) box.setFromObject(viewer.model); };

  function sync() {
    // Re-rendering under a finger or a mouse button would drop the slider mid-drag.
    if (pressed) { pending = true; return; }
    const html = viewer.model ? opts.html() : '';
    const tool = ctx.activeTool();
    const show = !!html;
    if (show !== visible) { visible = show; el.classList.toggle('hidden', !show); lastCss = ''; }
    document.body.classList.toggle('has-toolpill', show);
    if (!show) { lastHtml = ''; return; }
    if (tool !== lastTool || viewer.model !== lastModel) { lastTool = tool; lastModel = viewer.model; measureBox(); lastCss = ''; }
    if (html !== lastHtml) {
      const focused = document.activeElement && el.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset : null;
      el.innerHTML = html;
      lastHtml = html;
      opts.bind(el);
      // Keyboard users keep their place after a re-render.
      if (focused) {
        const key = Object.keys(focused)[0];
        if (key) el.querySelector<HTMLElement>(`[data-${key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}]`)?.focus();
      }
      lastCss = '';
    }
    const phone = ctx.isPhone();
    if (phone !== docked) { docked = phone; el.classList.toggle('docked', phone); el.style.transform = ''; lastCss = ''; }
    place();
  }

  function place() {
    if (!visible || docked) return;
    if (box.isEmpty()) measureBox();
    const s = stage!.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    const pad = 12, bottomPad = 78; // clear of the camera dock / status line
    let x = s.width / 2 - w / 2, y = s.height - h - bottomPad;
    if (!box.isEmpty()) {
      const r = viewer.renderer.domElement.getBoundingClientRect();
      let minX = Infinity, maxX = -Infinity, maxY = -Infinity, behind = 0;
      const { min, max } = box;
      for (let i = 0; i < 8; i++) {
        const c = corners[i].set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z).project(viewer.camera);
        if (c.z > 1) behind++;
        const px = (c.x * 0.5 + 0.5) * r.width + r.left - s.left;
        const py = (-c.y * 0.5 + 0.5) * r.height + r.top - s.top;
        minX = Math.min(minX, px); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
      }
      if (behind < 8) {
        x = (minX + maxX) / 2 - w / 2;
        y = Math.min(maxY + 16, s.height - h - bottomPad);
      }
    }
    x = Math.max(pad, Math.min(s.width - w - pad, x));
    y = Math.max(pad + 60, y);
    const css = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    if (css !== lastCss) { el.style.transform = css; lastCss = css; }
  }

  viewer.onFrame(place);
  window.addEventListener('resize', () => { lastCss = ''; sync(); });
  return { sync, el };
}
