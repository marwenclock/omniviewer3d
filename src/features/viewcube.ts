import * as THREE from 'three';
import { ctx } from '../context';
import type { ViewName } from '../viewer';
import { t } from '../i18n';

// A labelled view cube in the corner of the 3D view (CAD-style): it turns with the camera, and clicking a face
// frames the model from that side. It replaces the canvas-drawn axis gizmo; it is plain DOM, so screenshots,
// turntable videos and GIFs never include it.

const FACES: [ViewName, string, string][] = [
  ['front', 'Front', 'translateZ(var(--vc-h))'],
  ['back', 'Back', 'rotateY(180deg) translateZ(var(--vc-h))'],
  ['right', 'Right', 'rotateY(90deg) translateZ(var(--vc-h))'],
  ['left', 'Left', 'rotateY(-90deg) translateZ(var(--vc-h))'],
  ['top', 'Top', 'rotateX(90deg) translateZ(var(--vc-h))'],
  ['bottom', 'Bottom', 'rotateX(-90deg) translateZ(var(--vc-h))'],
];

export function initViewCube() {
  const stage = document.getElementById('stage');
  if (!stage) return;
  const wrap = document.createElement('div');
  wrap.className = 'viewcube';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', t('View cube'));
  wrap.innerHTML = `<div class="vc-cube">${FACES.map(([v, label, tf]) => `<button class="vc-face" data-vcview="${v}" style="transform:${tf}" aria-label="${t(label)} ${t('view')}">${t(label)}</button>`).join('')}</div>
    <button class="vc-iso" data-vcview="iso" aria-label="${t('Isometric view')}" title="${t('Isometric view')} · ${t('Shift-click a face to turn without re-framing')}">ISO</button>`;
  stage.appendChild(wrap);
  ctx.viewer.showAxisHelper = false;
  ctx.viewer.requestRender();
  wrap.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-vcview]');
    if (!b || !ctx.viewer.model) return;
    // Shift-click turns to that side but keeps the current zoom (inspecting a small part); a plain click frames the model.
    if ((e as MouseEvent).shiftKey) ctx.viewer.orient(b.dataset.vcview as ViewName);
    else ctx.viewer.fit(ctx.viewer.model, b.dataset.vcview as ViewName);
  });
  const cube = wrap.querySelector<HTMLElement>('.vc-cube')!;
  const m = new THREE.Matrix4();
  let last = '';
  const tick = () => {
    const cam = ctx.viewer.camera;
    cam.updateMatrixWorld();
    m.extractRotation(cam.matrixWorldInverse);
    const e = m.elements;
    // three.js is Y-up, CSS is Y-down: flip the Y row and column.
    const css = `matrix3d(${e[0]},${-e[1]},${e[2]},0,${-e[4]},${e[5]},${-e[6]},0,${e[8]},${-e[9]},${e[10]},0,0,0,0,1)`;
    if (css !== last) { cube.style.transform = css; last = css; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
