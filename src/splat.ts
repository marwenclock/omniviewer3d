import * as THREE from 'three';

/**
 * Gaussian splats (.splat, .ksplat, .spz and 3DGS .ply) via @mkkellogg/gaussian-splats-3d, which renders with
 * the regular WebGL renderer. Splats are view-only: they can be measured and screenshotted, not edited or converted.
 */
export async function loadSplat(file: File, ext: string, onProgress: (m: string) => void): Promise<THREE.Object3D> {
  const GS: any = await import('@mkkellogg/gaussian-splats-3d');
  onProgress('Loading Gaussian splats…');
  const url = URL.createObjectURL(file);
  const format = ext === 'ksplat' ? GS.SceneFormat.KSplat : ext === 'spz' ? GS.SceneFormat.Spz : ext === 'ply' ? GS.SceneFormat.Ply : GS.SceneFormat.Splat;
  const dropIn = new GS.DropInViewer({ gpuAcceleratedSort: false, sharedMemoryForWorkers: false, dynamicScene: false, sceneRevealMode: GS.SceneRevealMode?.Instant ?? 2 });
  try {
    await dropIn.addSplatScene(url, { showLoadingUI: false, progressiveLoad: false, format, splatAlphaRemovalThreshold: 5 });
  } finally { URL.revokeObjectURL(url); }
  dropIn.name = file.name;
  dropIn.traverse((o: any) => { o.userData.splat = true; o.raycast = () => {}; o.frustumCulled = false; });

  // The splat mesh has no useful bounding box, so add an invisible box over the bulk of the splats
  // (2nd–98th percentile, ignoring stray "floaters") for framing, the grid and measuring size.
  const mesh = dropIn.splatMesh;
  const count = mesh?.getSplatCount?.() || 0;
  const step = Math.max(1, Math.floor(count / 20000));
  const xs: number[] = [], ys: number[] = [], zs: number[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i += step) { mesh.getSplatCenter(i, v, true); xs.push(v.x); ys.push(v.y); zs.push(v.z); }
  const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)] ?? 0; };
  const min = new THREE.Vector3(pct(xs, 0.02), pct(ys, 0.02), pct(zs, 0.02));
  const max = new THREE.Vector3(pct(xs, 0.98), pct(ys, 0.98), pct(zs, 0.98));
  const size = max.clone().sub(min), centre = min.clone().add(max).multiplyScalar(0.5);
  const proxy = new THREE.Mesh(new THREE.BoxGeometry(size.x || 1, size.y || 1, size.z || 1), new THREE.MeshBasicMaterial({ visible: false }));
  proxy.position.copy(centre);
  proxy.userData.proxy = true;
  proxy.raycast = () => {};
  proxy.name = 'Splat bounds';
  dropIn.add(proxy);
  dropIn.userData.splatCount = count;
  // .splat / .ksplat / 3DGS .ply use a Y-down camera convention (COLMAP); SPZ is already Y-up.
  if (ext !== 'spz') dropIn.rotation.x = Math.PI;
  return dropIn;
}

/** 3D Gaussian Splatting .ply files carry spherical-harmonic colour fields. */
export async function isSplatPly(file: File): Promise<boolean> {
  const head = await file.slice(0, 4096).text();
  return /property\s+\w+\s+f_dc_0/.test(head) && /property\s+\w+\s+scale_0/.test(head);
}
