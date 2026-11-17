import * as THREE from 'three';
import { ctx, modelMeshes } from '../context';

/**
 * Solid section caps using the stencil buffer: back faces add, front faces subtract, and a plane drawn on the
 * section only where the count is non-zero, i.e. exactly where the cut goes through solid material.
 */
let group: THREE.Group | null = null;
let capPlane: THREE.Mesh | null = null;
let tracked: { src: THREE.Mesh; back: THREE.Mesh; front: THREE.Mesh }[] = [];
export let capsEnabled = true;
export let capColor = '#8c8c8c';

export function setCaps(on: boolean) { capsEnabled = on; rebuild(); }
export function setCapColor(c: string) { capColor = c; if (capPlane) (capPlane.material as THREE.MeshStandardMaterial).color.set(c); }

function clear() {
  if (!group) return;
  group.removeFromParent();
  (capPlane?.material as THREE.Material)?.dispose();
  capPlane?.geometry.dispose();
  for (const t of tracked) { (t.back.material as THREE.Material).dispose(); (t.front.material as THREE.Material).dispose(); }
  group = null; capPlane = null; tracked = [];
}

function stencilMat(side: THREE.Side, op: THREE.StencilOp) {
  return new THREE.MeshBasicMaterial({
    side, colorWrite: false, depthWrite: false, depthTest: false,
    clippingPlanes: [ctx.viewer.clipPlane],
    stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilFail: op, stencilZFail: op, stencilZPass: op,
  });
}

export function rebuild() {
  clear();
  const v = ctx.viewer;
  if (!capsEnabled || !v.section.enabled || !v.model || v.displayMode === 'wireframe' || v.displayMode === 'xray') return;
  group = new THREE.Group();
  group.userData.helper = true;
  for (const src of modelMeshes(v.model, true)) {
    const back = new THREE.Mesh(src.geometry, stencilMat(THREE.BackSide, THREE.IncrementWrapStencilOp));
    const front = new THREE.Mesh(src.geometry, stencilMat(THREE.FrontSide, THREE.DecrementWrapStencilOp));
    for (const m of [back, front]) { m.matrixAutoUpdate = false; m.renderOrder = 10; m.userData.helper = true; m.raycast = () => {}; group.add(m); }
    tracked.push({ src, back, front });
  }
  const size = v.bounds().getSize(new THREE.Vector3()).length() * 2 || 10;
  capPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshStandardMaterial({
      color: capColor, roughness: 0.85, metalness: 0, side: THREE.DoubleSide,
      stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
    }),
  );
  capPlane.renderOrder = 11;
  capPlane.userData.helper = true;
  capPlane.raycast = () => {};
  capPlane.onAfterRender = (r) => r.clearStencil();
  group.add(capPlane);
  v.overlay.add(group);
  sync();
}

function sync() {
  if (!group || !capPlane) return;
  for (const t of tracked) {
    t.src.updateWorldMatrix(true, false);
    t.back.matrix.copy(t.src.matrixWorld); t.front.matrix.copy(t.src.matrixWorld);
    t.back.geometry = t.src.geometry; t.front.geometry = t.src.geometry;
    t.back.visible = t.front.visible = isShown(t.src);
  }
  const p = ctx.viewer.clipPlane;
  const centre = ctx.viewer.bounds().getCenter(new THREE.Vector3());
  p.projectPoint(centre, capPlane.position);
  capPlane.lookAt(capPlane.position.clone().sub(p.normal));
}

function isShown(o: THREE.Object3D | null) { while (o) { if (!o.visible) return false; o = o.parent; } return true; }

export function initCaps() {
  let lastKey = '';
  ctx.viewer.onChange(() => {
    const v = ctx.viewer;
    const key = [v.section.enabled, v.displayMode, capsEnabled, v.model?.uuid, modelMeshes(v.model).length].join('|');
    if (key !== lastKey) { lastKey = key; rebuild(); }
  });
  ctx.viewer.onFrame(() => sync());
  ctx.history.onChange(() => { if (ctx.viewer.section.enabled) rebuild(); });
}
