import type * as THREE from 'three';
import type { Viewer } from './viewer';
import type { Editor } from './editor';
import type { History } from './history';
import type { Unit } from './stats';

/** Shared app services, filled in by main.ts so feature modules can use them without circular imports. */
export interface AppContext {
  viewer: Viewer;
  editor: Editor;
  history: History;
  toast(msg: string, error?: boolean): void;
  setLoading(msg: string | null, progress?: number | null): void;
  /** recompute stats and re-render panels after a geometry change */
  refresh(): void;
  renderDetails(): void;
  unit(): Unit;
  fmtLen(v: number, digits?: number): string;
  setTool(id: string): void;
  activeTool(): string;
  selectObject(o: THREE.Object3D | null): void;
  openFiles(files: File[], urls?: string[] | null): Promise<void>;
  modelName(): string;
  baseFileName(): string;
  openModal(html: string): void;
  closeModal(): void;
}

export const ctx = {} as AppContext;

/** Every mesh in the model (skipping viewer helpers), optionally only visible ones. */
export function modelMeshes(root: THREE.Object3D | null, visibleOnly = false): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root?.traverse((o: any) => {
    if (o.isMesh && !o.userData.helper && (!visibleOnly || isVisibleChain(o))) out.push(o);
  });
  return out;
}

function isVisibleChain(o: THREE.Object3D | null): boolean {
  while (o) { if (!o.visible) return false; o = o.parent; }
  return true;
}

/** Meshes the tool should act on: the selection if one is picked, otherwise the whole model. */
export function targetMeshes(): THREE.Mesh[] {
  const sel = ctx.editor.selected;
  return modelMeshes(sel ?? ctx.viewer.model, true);
}

export const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
