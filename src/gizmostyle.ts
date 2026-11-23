import * as THREE from 'three';
import type { TransformControls } from 'three/addons/controls/TransformControls.js';

// Monochrome move / rotate / scale handles that match the app's black-and-white look, instead of three.js's
// red / green / blue / yellow. Every handle is drawn in one ink colour (near-white on the dark theme, near-black
// on the light one) with a thin outline in the opposite colour, so the handles stay readable over a light-grey
// model as well as the dark background. The hovered / dragged handle turns fully solid.

const THEMES = {
  dark: { ink: 0xf4f4f1, active: 0xffffff, halo: 0x0a0a0a, haloOpacity: 0.6 },
  light: { ink: 0x141414, active: 0x000000, halo: 0xffffff, haloOpacity: 0.85 },
};
const BASE_OPACITY = 0.78; // idle handles; the hovered one goes to 1 (TransformControls does that itself)
const PLANE_OPACITY = 0.14;
const HALO_WIDTH = 0.011; // in gizmo units (the gizmo keeps a constant size on screen, so this does too)

/** Inflates the mesh along its normals and draws only its back faces: a cheap, constant-width outline. */
function haloMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color() }, opacity: { value: 0.6 }, width: { value: HALO_WIDTH } },
    vertexShader: `uniform float width;
      void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position + normal * width, 1.0); }`,
    fragmentShader: `uniform vec3 color; uniform float opacity;
      void main() { gl_FragColor = vec4(color, opacity); }`,
    side: THREE.BackSide, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
  });
}

export function styleGizmo(transform: TransformControls) {
  const gizmo = (transform as any)._gizmo;
  if (!gizmo?.materialLib) return; // three.js internals changed: keep the stock look rather than break
  const lib = gizmo.materialLib;
  const solid = new Set<THREE.Material>([lib.xAxis, lib.yAxis, lib.zAxis]);
  const planes = new Set<THREE.Material>([lib.xAxisTransparent, lib.yAxisTransparent, lib.zAxisTransparent]);
  const others = new Set<THREE.Material>(); // centre handles, screen ring, trackball ring, drag guide lines
  // One outline material per axis, so an axis and its outline fade together.
  const halos = new Map<THREE.Material, THREE.ShaderMaterial>([...solid].map((m) => [m, haloMaterial()]));

  for (const group of ['gizmo', 'helper'] as const) {
    for (const mode of ['translate', 'rotate', 'scale']) {
      gizmo[group][mode]?.children.forEach((h: any) => {
        const m = h.material as THREE.Material;
        if (!m || solid.has(m) || planes.has(m)) {
          // Solid axis handles (arrows, shafts, rings, cubes) get the outline.
          if (m && solid.has(m) && h.isMesh && h.geometry?.attributes.normal) {
            const o = new THREE.Mesh(h.geometry, halos.get(m)!);
            o.renderOrder = 1e9; // just before the handles themselves (Infinity)
            o.raycast = () => {};
            o.userData.helper = true;
            h.add(o);
          }
          return;
        }
        others.add(m);
      });
    }
  }

  const apply = () => {
    const t = THEMES[document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'];
    const set = (m: any, color: number, opacity: number) => {
      m.color.setHex(color); m.opacity = opacity;
      // TransformControls caches the idle look on first draw and restores it after a hover.
      if (m._color) m._color.setHex(color);
      m._opacity = opacity;
    };
    solid.forEach((m) => set(m, t.ink, BASE_OPACITY));
    planes.forEach((m) => set(m, t.ink, PLANE_OPACITY));
    others.forEach((m: any) => set(m, t.ink, m.isLineBasicMaterial ? 0.35 : PLANE_OPACITY));
    lib.active.color.setHex(t.active);
    lib.activeTransparent.color.setHex(t.active);
    if (lib.active._color) lib.active._color.setHex(t.active);
    if (lib.activeTransparent._color) lib.activeTransparent._color.setHex(t.active);
    haloOpacity = t.haloOpacity;
    halos.forEach((h) => { h.uniforms.color.value.setHex(t.halo); h.uniforms.opacity.value = haloOpacity; });
  };
  let haloOpacity = THEMES.dark.haloOpacity;
  apply();

  // In one colour, "slightly brighter" doesn't read as a hover. Instead, while a handle is hovered or dragged,
  // every other axis fades back, so the one you're about to move stands out clearly.
  const byAxis: [string, any][] = [['X', lib.xAxis], ['Y', lib.yAxis], ['Z', lib.zAxis]];
  transform.addEventListener('axis-changed' as any, (e: any) => {
    const axis: string | null = e.value;
    for (const [a, m] of byAxis) {
      const on = !axis || axis.includes(a);
      m._opacity = on ? BASE_OPACITY : 0.22;
      halos.get(m)!.uniforms.opacity.value = on ? haloOpacity : haloOpacity * 0.25;
    }
    planes.forEach((m: any) => (m._opacity = axis ? 0.06 : PLANE_OPACITY));
  });
  new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
