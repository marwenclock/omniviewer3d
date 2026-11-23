import * as THREE from 'three';
import { ctx } from '../context';
import { icon } from '../icons';
import { t } from '../i18n';

// A small floating tool bar that follows the selected part (like the heads-up bars in Fusion and SolidWorks):
// click a part and Move / Rotate / Scale, Focus, Hide, Duplicate and Delete are right next to it, instead of
// somewhere in a side rail. Move / Rotate / Scale reuse the app's own [data-gizmo] buttons, so their active state,
// shortcuts (W / E / R) and undo stay exactly as before. Plain DOM, so screenshots and recordings never include it.

export type SelBarAction = 'focus' | 'hide' | 'isolate' | 'dup' | 'delete' | 'details' | 'snap' | 'deselect';

export function initSelectionBar(run: (a: SelBarAction) => void) {
  const stage = document.getElementById('stage');
  if (!stage) return;
  const { viewer, editor } = ctx;
  const bar = document.createElement('div');
  bar.className = 'selbar hidden';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', t('Selected part'));
  bar.innerHTML = `
    <span class="sb-name" id="sbName"></span>
    <div class="sb-group">
      <button class="sb-btn sb-main" data-gizmo="translate" data-tip="${t('Move')} (W)" aria-label="${t('Move')}">${icon('move')}<span>${t('Move')}</span></button>
      <button class="sb-btn sb-main" data-gizmo="rotate" data-tip="${t('Rotate')} (E)" aria-label="${t('Rotate')}">${icon('rotate')}<span>${t('Rotate')}</span></button>
      <button class="sb-btn sb-main" data-gizmo="scale" data-tip="${t('Scale')} (R)" aria-label="${t('Scale')}">${icon('scale')}<span>${t('Scale')}</span></button>
      <button class="sb-btn sb-snap" data-sb="snap" data-tip="${t('Snap to steps')}" aria-label="${t('Snap to steps')}" aria-pressed="false">${icon('target')}</button>
    </div>
    <div class="sb-group">
      <button class="sb-btn" data-sb="focus" data-tip="${t('Zoom to part')} (F)" aria-label="${t('Zoom to part')}">${icon('fit')}</button>
      <button class="sb-btn" data-sb="hide" data-tip="${t('Hide')} (H)" aria-label="${t('Hide')}">${icon('eyeoff')}</button>
      <button class="sb-btn" data-sb="isolate" data-tip="${t('Show only this')}" aria-label="${t('Show only this')}">${icon('isolate')}</button>
      <button class="sb-btn sb-part" data-sb="dup" data-tip="${t('Duplicate')} (Ctrl+D)" aria-label="${t('Duplicate')}">${icon('copy')}</button>
      <button class="sb-btn sb-part sb-danger" data-sb="delete" data-tip="${t('Delete')} (Del)" aria-label="${t('Delete')}">${icon('trash')}</button>
    </div>
    <div class="sb-group">
      <button class="sb-btn" data-sb="details" data-tip="${t('Size, position and material')}" aria-label="${t('Properties')}">${icon('info')}</button>
      <button class="sb-btn" data-sb="deselect" data-tip="${t('Deselect')} (Esc)" aria-label="${t('Deselect')}">${icon('x')}</button>
    </div>`;
  stage.appendChild(bar);
  const nameEl = bar.querySelector<HTMLElement>('#sbName')!;
  const snapBtn = bar.querySelector<HTMLElement>('.sb-snap')!;

  bar.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-sb]');
    if (b) run(b.dataset.sb as SelBarAction);
    // [data-gizmo] clicks are handled by the app's global click handler.
  });
  // Keep pointer presses on the bar from reaching the canvas (no orbit, no re-pick).
  bar.addEventListener('pointerdown', (e) => e.stopPropagation());

  // World-space box of the selection, recomputed only when the selection or its transform changes
  // (traversing a big assembly every frame would be wasteful); the camera only needs a re-projection.
  const box = new THREE.Box3();
  let boxDirty = true;
  const corners = Array.from({ length: 8 }, () => new THREE.Vector3());
  let visible = false;
  let lastCss = '';

  const shouldShow = () => {
    const o = editor.selected;
    if (!o || !viewer.model || !o.visible) return false;
    const tool = ctx.activeTool();
    // Tools that use clicks on the model for themselves (measure, paint) or float their own panels: stay out of the way.
    if (tool && tool !== 'none') return false;
    return !ctx.isPhone();
  };

  const sync = () => {
    const show = shouldShow();
    boxDirty = true;
    if (show !== visible) { visible = show; bar.classList.toggle('hidden', !show); lastCss = ''; }
    if (!show) return;
    const o = editor.selected!;
    const many = editor.selection.length;
    nameEl.textContent = many > 1 ? `${many} ${t('parts')}` : (o.name || t('Part'));
    nameEl.title = nameEl.textContent;
    const isRoot = o === viewer.model;
    bar.classList.toggle('is-root', isRoot);
    bar.classList.toggle('gizmo-on', editor.gizmo !== 'none');
    snapBtn.classList.toggle('active', editor.snap);
    snapBtn.setAttribute('aria-pressed', String(editor.snap));
    const hide = bar.querySelector<HTMLElement>('[data-sb="hide"]')!;
    hide.innerHTML = icon(o.visible ? 'eyeoff' : 'eye');
    place();
  };

  const place = () => {
    if (!visible) return;
    const o = editor.selected;
    if (!o) return;
    if (boxDirty) { box.setFromObject(o); boxDirty = false; }
    if (box.isEmpty()) return;
    const cam = viewer.camera;
    const r = viewer.renderer.domElement.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, behind = 0;
    const { min, max } = box;
    for (let i = 0; i < 8; i++) {
      const c = corners[i].set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z).project(cam);
      if (c.z > 1) behind++;
      const x = (c.x * 0.5 + 0.5) * r.width + r.left - s.left;
      const y = (-c.y * 0.5 + 0.5) * r.height + r.top - s.top;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const w = bar.offsetWidth, h = bar.offsetHeight;
    const gap = 14, pad = 10, top = 72; // top: clear of the output buttons in the top-right corner
    // Above the part; below it if there is no room above; pinned to the top edge when the part fills the view.
    let y = minY - h - gap;
    if (y < top) y = maxY + gap <= s.height - h - pad - 70 ? maxY + gap : top;
    if (behind === 8) y = top;
    let x = (minX + maxX) / 2 - w / 2;
    x = Math.max(pad, Math.min(s.width - w - pad, x));
    const css = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    if (css !== lastCss) { bar.style.transform = css; lastCss = css; }
  };

  editor.onChange(sync);
  viewer.onChange(() => { boxDirty = true; });
  editor.transform.addEventListener('objectChange', () => { boxDirty = true; });
  // While dragging a gizmo handle the bar fades, so it never sits under the cursor.
  editor.transform.addEventListener('dragging-changed', (e: any) => bar.classList.toggle('dragging', !!e.value));
  viewer.onFrame(place);
  window.addEventListener('resize', () => { lastCss = ''; place(); });

  return { sync };
}
