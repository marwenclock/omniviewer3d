import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { Viewer } from './viewer';
import type { History } from './history';
import { defaultMaterial } from './loaders';

export type GizmoMode = 'none' | 'translate' | 'rotate' | 'scale';
export const PRIMITIVES = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'plane', 'capsule', 'icosahedron'] as const;
export type Primitive = (typeof PRIMITIVES)[number];

interface TRS { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }
const trs = (o: THREE.Object3D): TRS => ({ p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() });
const setTrs = (o: THREE.Object3D, t: TRS) => { o.position.copy(t.p); o.quaternion.copy(t.q); o.scale.copy(t.s); o.updateMatrixWorld(true); };

/** Lightweight editing: selection gizmo, primitives, duplicate/delete, mirror, materials and scaling. */
export class Editor {
  selected: THREE.Object3D | null = null;
  gizmo: GizmoMode = 'none';
  snap = false;
  readonly transform: TransformControls;
  private boxHelper: THREE.BoxHelper;
  private dragStart: TRS | null = null;
  private listeners = new Set<() => void>();
  /** Called after any change to the scene structure or geometry. */
  onEdited: () => void = () => {};

  constructor(private viewer: Viewer, private history: History) {
    this.transform = new TransformControls(viewer.camera, viewer.renderer.domElement);
    this.transform.setSize(0.9);
    const helper = this.transform.getHelper();
    helper.userData.helper = true;
    helper.userData.noShot = true;
    viewer.overlay.add(helper);
    this.transform.addEventListener('dragging-changed', (e: any) => {
      viewer.controls.enabled = !e.value;
      const obj = this.transform.object;
      if (!obj) return;
      if (e.value) this.dragStart = trs(obj);
      else if (this.dragStart) {
        const before = this.dragStart, after = trs(obj);
        this.dragStart = null;
        this.history.push({
          label: `${this.gizmo === 'translate' ? 'Move' : this.gizmo === 'rotate' ? 'Rotate' : 'Scale'} ${obj.name || 'object'}`,
          undo: () => { setTrs(obj, before); this.changed(); },
          redo: () => { setTrs(obj, after); this.changed(); },
        });
        this.changed();
      }
    });
    this.transform.addEventListener('objectChange', () => this.boxHelper.update());

    this.boxHelper = new THREE.BoxHelper(new THREE.Object3D(), 0xffffff);
    (this.boxHelper.material as THREE.LineBasicMaterial).transparent = true;
    (this.boxHelper.material as THREE.LineBasicMaterial).opacity = 0.8;
    (this.boxHelper.material as THREE.LineBasicMaterial).depthTest = false;
    this.boxHelper.renderOrder = 997;
    this.boxHelper.userData.helper = true;
    this.boxHelper.userData.noShot = true;
    this.boxHelper.visible = false;
    this.boxHelper.raycast = () => {};
    viewer.overlay.add(this.boxHelper);
    viewer.onFrame(() => { if (this.selected && this.boxHelper.visible) this.boxHelper.update(); });
    viewer.onChange(() => {
      // Keep the gizmo on the active camera after projection switches.
      if (this.transform.camera !== viewer.camera) this.transform.camera = viewer.camera;
    });
  }

  onChange(fn: () => void) { this.listeners.add(fn); }
  private emit() { this.listeners.forEach((f) => f()); }
  private changed() { this.viewer.rebaseExplode(); this.onEdited(); this.emit(); }

  select(obj: THREE.Object3D | null) {
    this.selected = obj;
    if (obj) { this.boxHelper.setFromObject(obj); this.boxHelper.visible = true; }
    else this.boxHelper.visible = false;
    this.attachGizmo();
    this.emit();
  }

  setGizmo(mode: GizmoMode) {
    this.gizmo = mode;
    this.attachGizmo();
    this.emit();
  }

  setSnap(on: boolean) {
    this.snap = on;
    const size = this.viewer.bounds().getSize(new THREE.Vector3()).length() || 1;
    const step = Math.pow(10, Math.floor(Math.log10(size / 20)));
    this.transform.setTranslationSnap(on ? step : null);
    this.transform.setRotationSnap(on ? THREE.MathUtils.degToRad(15) : null);
    this.transform.setScaleSnap(on ? 0.1 : null);
    this.emit();
  }

  private attachGizmo() {
    if (this.gizmo !== 'none' && this.selected) {
      if (this.viewer.explode !== 0) this.viewer.setExplode(0);
      this.transform.setMode(this.gizmo);
      this.transform.attach(this.selected);
    } else this.transform.detach();
  }

  /** Makes sure there is a model to add things to (for building from scratch). */
  ensureModel(): THREE.Object3D {
    if (!this.viewer.model) {
      const g = new THREE.Group();
      g.name = 'Untitled scene';
      this.viewer.setModel(g);
    }
    return this.viewer.model!;
  }

  addPrimitive(kind: Primitive) {
    const root = this.ensureModel();
    const box = this.viewer.bounds();
    // An empty scene starts with 20-unit shapes (20 mm in a new scene).
    const span = box.isEmpty() ? 20 : Math.max(...box.getSize(new THREE.Vector3()).toArray()) * 0.35;
    const s = span || 20;
    const geos: Record<Primitive, () => THREE.BufferGeometry> = {
      box: () => new THREE.BoxGeometry(s, s, s),
      sphere: () => new THREE.SphereGeometry(s / 2, 48, 32),
      cylinder: () => new THREE.CylinderGeometry(s / 2, s / 2, s, 48),
      cone: () => new THREE.ConeGeometry(s / 2, s, 48),
      torus: () => new THREE.TorusGeometry(s / 2.6, s / 8, 24, 64),
      plane: () => new THREE.PlaneGeometry(s * 2, s * 2).rotateX(-Math.PI / 2),
      capsule: () => new THREE.CapsuleGeometry(s / 3, s / 2, 8, 24),
      icosahedron: () => new THREE.IcosahedronGeometry(s / 2, 0),
    };
    const mesh = new THREE.Mesh(geos[kind](), defaultMaterial());
    (mesh.material as THREE.MeshStandardMaterial).color.setHSL(Math.random(), 0.15, 0.7);
    mesh.name = kind[0].toUpperCase() + kind.slice(1);
    // Drop it next to the existing model, resting on the same floor.
    const world = new THREE.Vector3();
    if (!box.isEmpty()) world.set(box.max.x + s * 0.8, box.min.y + (kind === 'plane' ? 0 : s / 2), box.getCenter(new THREE.Vector3()).z);
    else world.set(0, kind === 'plane' ? 0 : s / 2, 0);
    root.updateMatrixWorld(true);
    const inv = root.matrixWorld.clone().invert();
    const rootScale = new THREE.Vector3(); root.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), rootScale);
    mesh.position.copy(world.applyMatrix4(inv));
    mesh.scale.divide(rootScale);
    mesh.quaternion.copy(root.getWorldQuaternion(new THREE.Quaternion()).invert());
    mesh.userData.explodeBase = mesh.position.clone();
    this.history.run({
      label: `Add ${mesh.name}`,
      redo: () => { root.add(mesh); this.viewer.refreshMaterials(); this.select(mesh); this.changed(); },
      undo: () => { root.remove(mesh); if (this.selected === mesh) this.select(null); this.changed(); },
    });
    this.viewer.fit();
  }

  /**
   * Adds a ready-made object (3D text, logo…) beside the model, resting on its floor.
   * The object's own geometry should sit on y = 0 and be centred in x/z.
   */
  addObject(obj: THREE.Object3D, label: string) {
    const root = this.ensureModel();
    const box = this.viewer.bounds();
    const own = new THREE.Box3().setFromObject(obj);
    const w = own.isEmpty() ? 1 : own.getSize(new THREE.Vector3()).x;
    const world = box.isEmpty() ? new THREE.Vector3() : new THREE.Vector3(box.max.x + w * 0.6 + (box.getSize(new THREE.Vector3()).x * 0.05), box.min.y, box.getCenter(new THREE.Vector3()).z);
    root.updateMatrixWorld(true);
    const rootScale = new THREE.Vector3(); root.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), rootScale);
    obj.position.copy(world.applyMatrix4(root.matrixWorld.clone().invert()));
    obj.scale.divide(rootScale);
    obj.quaternion.copy(root.getWorldQuaternion(new THREE.Quaternion()).invert());
    obj.traverse((o) => { o.userData.explodeBase = o.position.clone(); });
    this.history.run({
      label,
      redo: () => { root.add(obj); this.viewer.refreshMaterials(); this.select(obj); this.changed(); },
      undo: () => { root.remove(obj); if (this.selected === obj) this.select(null); this.changed(); },
    });
    this.viewer.fit();
  }

  deleteSelected() {
    const obj = this.selected;
    if (!obj || !obj.parent) return;
    if (obj === this.viewer.model) return; // use "close model" for that
    const parent = obj.parent;
    const index = parent.children.indexOf(obj);
    this.history.run({
      label: `Delete ${obj.name || 'object'}`,
      redo: () => { parent.remove(obj); this.select(null); this.changed(); },
      undo: () => { parent.children.splice(index, 0, obj); obj.parent = parent; this.select(obj); this.changed(); },
    });
  }

  duplicateSelected() {
    const obj = this.selected;
    if (!obj || !obj.parent || obj === this.viewer.model) return;
    const copy = obj.clone(true);
    // Give the copy its own materials so painting one does not paint both.
    copy.traverse((o: any) => {
      if (o.material) o.material = Array.isArray(o.material) ? o.material.map((m: THREE.Material) => m.clone()) : o.material.clone();
      if (o.geometry && o.userData.paintReady) o.geometry = o.geometry.clone();
    });
    copy.name = (obj.name || 'Object') + ' copy';
    const size = this.viewer.bounds(obj).getSize(new THREE.Vector3());
    const parent = obj.parent;
    // Offset along world X by its own width, converted into parent space.
    const worldPos = obj.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(size.x * 1.1 || 1, 0, 0));
    copy.position.copy(parent.worldToLocal(worldPos));
    copy.traverse((o: any) => { o.userData.explodeBase = o.position.clone(); });
    this.history.run({
      label: `Duplicate ${obj.name || 'object'}`,
      redo: () => { parent.add(copy); this.viewer.refreshMaterials(); this.select(copy); this.changed(); },
      undo: () => { parent.remove(copy); this.select(obj); this.changed(); },
    });
  }

  rename(obj: THREE.Object3D, name: string) {
    const old = obj.name;
    if (old === name) return;
    this.history.run({
      label: 'Rename',
      redo: () => { obj.name = name; this.emit(); this.onEdited(); },
      undo: () => { obj.name = old; this.emit(); this.onEdited(); },
    });
  }

  /** Applies a transform change to an object with undo. */
  transformObject(obj: THREE.Object3D, label: string, fn: (o: THREE.Object3D) => void) {
    const before = trs(obj);
    fn(obj);
    obj.updateMatrixWorld(true);
    const after = trs(obj);
    this.history.push({
      label,
      undo: () => { setTrs(obj, before); this.changed(); },
      redo: () => { setTrs(obj, after); this.changed(); },
    });
    this.changed();
  }

  mirror(axis: 'x' | 'y' | 'z') {
    const obj = this.selected ?? this.viewer.model;
    if (!obj) return;
    this.transformObject(obj, `Mirror ${axis.toUpperCase()}`, (o) => { o.scale[axis] *= -1; });
  }

  resetTransform() {
    const obj = this.selected;
    if (!obj) return;
    this.transformObject(obj, 'Reset transform', (o) => {
      o.position.copy(o.userData.explodeBase ?? new THREE.Vector3());
      o.quaternion.identity();
      o.scale.set(1, 1, 1);
    });
  }

  /** Moves the object so it sits on the floor (lowest point at Y = 0 in view space). */
  dropToFloor() {
    const obj = this.selected ?? this.viewer.model;
    if (!obj) return;
    const box = this.viewer.bounds(obj);
    if (box.isEmpty()) return;
    this.translateWorld(obj, new THREE.Vector3(0, -box.min.y, 0), 'Drop to floor');
  }

  /** Centres the object on the origin (X/Z) and puts it on the floor. */
  centerOnOrigin() {
    const obj = this.selected ?? this.viewer.model;
    if (!obj) return;
    const box = this.viewer.bounds(obj);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    this.translateWorld(obj, new THREE.Vector3(-c.x, -box.min.y, -c.z), 'Centre on origin');
  }

  private translateWorld(obj: THREE.Object3D, worldDelta: THREE.Vector3, label: string) {
    const parent = obj.parent!;
    const a = parent.worldToLocal(new THREE.Vector3());
    const b = parent.worldToLocal(worldDelta.clone());
    this.transformObject(obj, label, (o) => o.position.add(b.sub(a)));
    this.viewer.fit();
  }

  /**
   * Scales the object (selection or whole model) by per-axis factors around its own bounding-box centre/floor.
   */
  scaleBy(fx: number, fy: number, fz: number, target?: THREE.Object3D) {
    const obj = target ?? this.selected ?? this.viewer.model;
    if (!obj || !isFinite(fx * fy * fz) || fx * fy * fz === 0) return;
    const before = this.viewer.bounds(obj);
    const anchor = new THREE.Vector3(before.getCenter(new THREE.Vector3()).x, before.min.y, before.getCenter(new THREE.Vector3()).z);
    this.transformObject(obj, 'Scale', (o) => {
      // Scale is applied in the object's local axes; for a whole model that is what users expect.
      o.scale.multiply(new THREE.Vector3(fx, fy, fz));
      o.updateMatrixWorld(true);
      const after = this.viewer.bounds(o);
      const anchorAfter = new THREE.Vector3(after.getCenter(new THREE.Vector3()).x, after.min.y, after.getCenter(new THREE.Vector3()).z);
      const parent = o.parent!;
      const a = parent.worldToLocal(anchorAfter.clone());
      const b = parent.worldToLocal(anchor.clone());
      o.position.add(b.sub(a));
    });
  }

  /** Changes one material property with undo; clones shared materials first so only this mesh changes. */
  setMaterial(mesh: THREE.Mesh, index: number, patch: Record<string, any>, label = 'Edit material') {
    const beforeMat = mesh.material;
    const list = Array.isArray(mesh.material) ? mesh.material.slice() : [mesh.material];
    const m: any = list[index].clone();
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'color' || k === 'emissive') m[k]?.set(v);
      else m[k] = v;
    }
    if (patch.opacity !== undefined) {
      m.transparent = patch.opacity < 1;
      m.userData.orig = { ...(m.userData.orig || {}), opacity: patch.opacity, transparent: patch.opacity < 1 };
    }
    m.needsUpdate = true;
    list[index] = m;
    const afterMat = Array.isArray(mesh.material) ? list : list[0];
    this.history.run({
      label,
      redo: () => { mesh.material = afterMat; this.viewer.refreshMaterials(); this.emit(); this.onEdited(); },
      undo: () => { mesh.material = beforeMat; this.viewer.refreshMaterials(); this.emit(); this.onEdited(); },
    });
  }

  toggleVisibility(obj: THREE.Object3D) {
    obj.visible = !obj.visible;
    this.emit();
    this.onEdited();
  }
}
