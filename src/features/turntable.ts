import * as THREE from 'three';
import { ctx } from '../context';
import { registerPanel, registerCommand } from '../registry';
import { download } from '../exporters';

/** 360° turntable capture: a video (MP4 or WebM, real time) or an animated GIF (frame by frame). */
let seconds = 6;
let format: 'video' | 'gif' = 'video';
let gifWidth = 480;
let busy = false;

function orbitSetup() {
  const v = ctx.viewer;
  const target = v.controls.target.clone();
  const offset = v.camera.position.clone().sub(target);
  const up = v.camera.up.clone();
  return { target, offset, up, place(angle: number) {
    const o = offset.clone().applyAxisAngle(up, angle);
    v.camera.position.copy(target).add(o);
    v.camera.lookAt(target);
  } };
}

function hideChrome() {
  const v = ctx.viewer;
  const hidden: THREE.Object3D[] = [];
  // Grid, axes, gizmos and the corner XYZ helper stay out of the recording.
  v.overlay.traverse((o) => { if (o.visible && (o === v.grid || o === v.axes || o.userData.noShot)) { hidden.push(o); o.visible = false; } });
  v.recording = true;
  return () => { hidden.forEach((o) => (o.visible = true)); v.recording = false; };
}

function pickMime() {
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  return types.find((t) => (window as any).MediaRecorder?.isTypeSupported?.(t)) || '';
}

async function recordVideo() {
  const v = ctx.viewer;
  const mime = pickMime();
  if (!mime) throw new Error('Video recording is not supported in this browser. Try the GIF option.');
  const stream = (v.renderer.domElement as HTMLCanvasElement).captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const orbit = orbitSetup();
  const restore = hideChrome();
  v.controls.enabled = false;
  const done = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
  const start = performance.now();
  rec.start();
  await new Promise<void>((resolve) => {
    const off = v.onFrame(() => {
      const k = (performance.now() - start) / (seconds * 1000);
      orbit.place(Math.min(1, k) * Math.PI * 2);
      ctx.setLoading(`Recording turntable… ${Math.round(Math.min(1, k) * 100)}%`, Math.min(1, k));
      if (k >= 1) { off(); resolve(); }
    });
  });
  rec.stop();
  await done;
  restore();
  orbit.place(0);
  v.controls.enabled = true;
  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  download(new Blob(chunks, { type: mime.split(';')[0] }), `${ctx.baseFileName()}-turntable.${ext}`);
  ctx.toast(`Saved turntable video (.${ext})`);
}

async function recordGif() {
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
  const v = ctx.viewer;
  const fps = 15, frames = Math.round(seconds * fps);
  const src = v.renderer.domElement;
  const w = Math.min(gifWidth, src.width), h = Math.round((w * src.height) / src.width);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const gif = GIFEncoder();
  const orbit = orbitSetup();
  const restore = hideChrome();
  v.controls.enabled = false;
  for (let i = 0; i < frames; i++) {
    orbit.place((i / frames) * Math.PI * 2);
    v.renderer.render(v.scene, v.camera);
    g.drawImage(src, 0, 0, w, h);
    const { data } = g.getImageData(0, 0, w, h);
    const palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), w, h, { palette, delay: 1000 / fps });
    ctx.setLoading(`Making GIF… frame ${i + 1} of ${frames}`, (i + 1) / frames);
    if (i % 4 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  gif.finish();
  restore();
  orbit.place(0);
  v.controls.enabled = true;
  download(new Blob([gif.bytes() as BlobPart], { type: 'image/gif' }), `${ctx.baseFileName()}-turntable.gif`);
  ctx.toast('Saved turntable GIF');
}

registerPanel({
  id: 'turntable', label: 'Turntable video / GIF', icon: 'video',
  hint: 'Frame the model how you like it, then record a 360° spin',
  render() {
    return `<div class="seg" style="margin-bottom:8px"><button class="${format === 'video' ? 'active' : ''}" data-ttf="video">Video (MP4/WebM)</button><button class="${format === 'gif' ? 'active' : ''}" data-ttf="gif">GIF</button></div>
      <div class="row"><label>Length</label><input type="range" min="2" max="20" step="1" value="${seconds}" data-tts/><span class="cost-val" data-ttsl>${seconds}s</span></div>
      ${format === 'gif' ? `<div class="row"><label>Width</label><select data-ttw>${[320, 480, 640, 800].map((x) => `<option ${x === gifWidth ? 'selected' : ''}>${x}</option>`).join('')}</select></div>` : ''}
      <div class="btn-row"><button class="btn-solid" data-ttgo ${busy ? 'disabled' : ''}>Record</button></div>
      <p class="note">Spins the camera once around the current target. Set up lighting, background and shadow first (Settings). The grid and gizmos are hidden while recording.</p>`;
  },
  bind(host) {
    host.querySelectorAll<HTMLElement>('[data-ttf]').forEach((b) => b.addEventListener('click', () => { format = b.dataset.ttf as any; ctx.renderDetails(); }));
    host.querySelector('[data-tts]')?.addEventListener('input', (e) => { seconds = Number((e.target as HTMLInputElement).value); host.querySelector('[data-ttsl]')!.textContent = seconds + 's'; });
    host.querySelector('[data-ttw]')?.addEventListener('change', (e) => { gifWidth = Number((e.target as HTMLSelectElement).value); });
    host.querySelector('[data-ttgo]')?.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      try { await (format === 'gif' ? recordGif() : recordVideo()); }
      catch (e: any) { ctx.toast(e?.message || String(e), true); }
      finally { busy = false; ctx.viewer.recording = false; ctx.viewer.controls.enabled = true; ctx.setLoading(null); ctx.renderDetails(); }
    });
  },
});

export function initTurntable() {
  registerCommand({ id: 'turntable', label: 'Turntable video / GIF', group: 'File', keywords: 'record spin 360 animation mp4 webm gif', run: () => ctx.setTool('turntable'), enabled: () => !!ctx.viewer.model });
}
