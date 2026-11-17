import * as THREE from 'three';
import { ctx } from '../context';
import { registerPanel, registerCommand } from '../registry';
import { download } from '../exporters';

/**
 * 360° turntable capture (OV-096): video (MP4 / WebM) or GIF at an exact size and frame rate. Frames are rendered
 * one by one at fixed angles, so the loop has no jump and slow devices don't drop frames. Cancel or a failure
 * always restores the camera, size and overlays.
 */
const opts = { seconds: 6, format: 'video' as 'video' | 'gif', size: '1280x720', fps: 30, dir: 1 as 1 | -1, ease: 'linear' as 'linear' | 'smooth', anim: true };
let busy = false;
let cancel = false;

const SIZES: Record<string, [number, number]> = { view: [0, 0], '1280x720': [1280, 720], '1920x1080': [1920, 1080], '1080x1080': [1080, 1080], '1080x1350': [1080, 1350], '720x1280': [720, 1280], '640x480': [640, 480], '480x480': [480, 480] };

function orbitSetup() {
  const v = ctx.viewer;
  const target = v.controls.target.clone();
  const offset = v.camera.position.clone().sub(target);
  const start = v.camera.position.clone();
  const up = v.camera.up.clone();
  return {
    place(angle: number) { v.camera.position.copy(target).add(offset.clone().applyAxisAngle(up, angle)); v.camera.lookAt(target); },
    restore() { v.camera.position.copy(start); v.camera.lookAt(target); v.controls.target.copy(target); v.controls.update(); },
  };
}

function hideChrome() {
  const v = ctx.viewer;
  const hidden: THREE.Object3D[] = [];
  v.overlay.traverse((o) => { if (o.visible && (o === v.grid || o === v.axes || o.userData.noShot)) { hidden.push(o); o.visible = false; } });
  v.recording = true;
  return () => { hidden.forEach((o) => (o.visible = true)); v.recording = false; };
}

export function pickMime() {
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  return types.find((t) => (window as any).MediaRecorder?.isTypeSupported?.(t)) || '';
}

const angleAt = (k: number) => opts.dir * (opts.ease === 'smooth' ? (1 - Math.cos(Math.PI * k)) / 2 : k) * Math.PI * 2;

async function capture(onFrame: (i: number, frames: number, canvas: HTMLCanvasElement) => Promise<void> | void, fps: number) {
  const v = ctx.viewer;
  const [sw, sh] = SIZES[opts.size] ?? [0, 0];
  const w = sw || v.container.clientWidth, h = sh || v.container.clientHeight;
  const frames = Math.max(2, Math.round(opts.seconds * fps));
  const orbit = orbitSetup();
  const restoreChrome = hideChrome();
  const restoreSize = v.beginFixedSize(w, h);
  const wasControls = v.controls.enabled;
  const playing = !!v.activeAction && !v.activeAction.paused;
  v.controls.enabled = false;
  v.hold = true;
  cancel = false;
  try {
    for (let i = 0; i < frames; i++) {
      if (cancel) throw new DOMException('Cancelled', 'AbortError');
      orbit.place(angleAt(i / frames));
      if (opts.anim && v.mixer && v.activeAction) { v.activeAction.paused = false; v.mixer.update(1 / fps); }
      v.renderOnce();
      await onFrame(i, frames, v.renderer.domElement);
      ctx.setLoading(`Recording turntable… frame ${i + 1} of ${frames}`, (i + 1) / frames);
    }
  } finally {
    v.hold = false;
    restoreSize();
    restoreChrome();
    orbit.restore();
    if (v.activeAction) v.activeAction.paused = !playing;
    v.controls.enabled = wasControls;
    v.requestRender();
  }
  return { w, h };
}

async function recordVideo() {
  const mime = pickMime();
  if (!mime) throw new Error('Video recording is not supported in this browser. Try the GIF option.');
  const [sw, sh] = SIZES[opts.size] ?? [0, 0];
  const w = sw || ctx.viewer.container.clientWidth, h = sh || ctx.viewer.container.clientHeight;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  const stream = (c as any).captureStream(0) as MediaStream;
  const track: any = stream.getVideoTracks()[0];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.round(w * h * opts.fps * 0.15) });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
  rec.start();
  try {
    await capture(async (_i, _n, src) => {
      g.drawImage(src, 0, 0, w, h);
      track.requestFrame?.();
      await new Promise((r) => setTimeout(r, 1000 / opts.fps)); // the recorder timestamps in real time
    }, opts.fps);
  } finally {
    rec.stop();
    await done;
    stream.getTracks().forEach((tr) => tr.stop()); // release the capture track (OV-096)
  }
  if (cancel) return;
  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  download(new Blob(chunks, { type: mime.split(';')[0] }), `${ctx.baseFileName()}-turntable.${ext}`);
  ctx.toast(`Saved ${w}×${h} turntable video (${ext.toUpperCase()}, ${opts.fps} fps)`);
}

async function recordGif() {
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
  const fps = Math.min(opts.fps, 25);
  const [sw, sh] = SIZES[opts.size] ?? [0, 0];
  const maxW = 800;
  let w = sw || ctx.viewer.container.clientWidth, h = sh || ctx.viewer.container.clientHeight;
  if (w > maxW) { h = Math.round((h * maxW) / w); w = maxW; }
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const gif = GIFEncoder();
  await capture(async (i, _n, src) => {
    g.drawImage(src, 0, 0, w, h);
    const { data } = g.getImageData(0, 0, w, h);
    const palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), w, h, { palette, delay: Math.round(1000 / fps) });
    if (i % 4 === 0) await new Promise((r) => setTimeout(r, 0));
  }, fps);
  gif.finish();
  download(new Blob([gif.bytes() as BlobPart], { type: 'image/gif' }), `${ctx.baseFileName()}-turntable.gif`);
  ctx.toast(`Saved ${w}×${h} turntable GIF (${fps} fps)`);
}

registerPanel({
  id: 'turntable', label: 'Turntable video / GIF', icon: 'video',
  hint: 'Frame the model how you like it, then record a 360° spin',
  render() {
    const mime = pickMime();
    const hasAnim = !!ctx.viewer.clips.length;
    return `<div class="seg" style="margin-bottom:8px"><button class="${opts.format === 'video' ? 'active' : ''}" data-ttf="video">Video</button><button class="${opts.format === 'gif' ? 'active' : ''}" data-ttf="gif">GIF</button></div>
      <p class="note" style="margin-top:0">${opts.format === 'video' ? (mime ? `This browser records ${mime.includes('mp4') ? 'MP4 (H.264)' : 'WebM'}.` : 'This browser cannot record video; use GIF.') : 'GIFs are limited to 256 colours and 800 px wide.'}</p>
      <div class="row"><label>Size</label><select data-ttsize>${Object.keys(SIZES).map((k) => `<option value="${k}" ${k === opts.size ? 'selected' : ''}>${k === 'view' ? 'Same as the view' : k.replace('x', ' × ')}</option>`).join('')}</select></div>
      <div class="row"><label>Length</label><input type="range" min="2" max="30" step="1" value="${opts.seconds}" data-tts aria-label="Length in seconds"/><span class="cost-val" data-ttsl>${opts.seconds}s</span></div>
      <div class="row"><label>Frame rate</label><select data-ttfps>${(opts.format === 'gif' ? [10, 15, 20, 25] : [24, 30, 60]).map((f) => `<option ${f === opts.fps ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
      <div class="row"><label>Direction</label><div class="seg"><button class="${opts.dir === 1 ? 'active' : ''}" data-ttdir="1">↺ Left</button><button class="${opts.dir === -1 ? 'active' : ''}" data-ttdir="-1">↻ Right</button></div></div>
      <div class="row"><label>Speed</label><div class="seg"><button class="${opts.ease === 'linear' ? 'active' : ''}" data-ttease="linear">Constant (loops)</button><button class="${opts.ease === 'smooth' ? 'active' : ''}" data-ttease="smooth">Ease in / out</button></div></div>
      ${hasAnim ? `<label class="check"><input type="checkbox" data-ttanim ${opts.anim ? 'checked' : ''}/> Play the animation while spinning</label>` : ''}
      <div class="btn-row">${busy ? '<button class="btn-solid danger" data-ttcancel>Cancel</button>' : '<button class="btn-solid" data-ttgo>Record</button>'}</div>
      <p class="note">Spins the camera once around the current target, frame by frame, and ends where it started. Set up lighting, background and shadow first (Settings). The grid and gizmos are hidden while recording.</p>`;
  },
  bind(host) {
    host.querySelectorAll<HTMLElement>('[data-ttf]').forEach((b) => b.addEventListener('click', () => { opts.format = b.dataset.ttf as any; opts.fps = opts.format === 'gif' ? 15 : 30; ctx.renderDetails(); }));
    host.querySelector('[data-tts]')?.addEventListener('input', (e) => { opts.seconds = Number((e.target as HTMLInputElement).value); host.querySelector('[data-ttsl]')!.textContent = opts.seconds + 's'; });
    host.querySelector('[data-ttsize]')?.addEventListener('change', (e) => { opts.size = (e.target as HTMLSelectElement).value; });
    host.querySelector('[data-ttfps]')?.addEventListener('change', (e) => { opts.fps = Number((e.target as HTMLSelectElement).value); });
    host.querySelector('[data-ttanim]')?.addEventListener('change', (e) => { opts.anim = (e.target as HTMLInputElement).checked; });
    host.querySelectorAll<HTMLElement>('[data-ttdir]').forEach((b) => b.addEventListener('click', () => { opts.dir = Number(b.dataset.ttdir) as 1 | -1; ctx.renderDetails(); }));
    host.querySelectorAll<HTMLElement>('[data-ttease]').forEach((b) => b.addEventListener('click', () => { opts.ease = b.dataset.ttease as any; ctx.renderDetails(); }));
    host.querySelector('[data-ttcancel]')?.addEventListener('click', () => { cancel = true; });
    host.querySelector('[data-ttgo]')?.addEventListener('click', async () => {
      if (busy) return;
      busy = true; ctx.renderDetails();
      try { await (opts.format === 'gif' ? recordGif() : recordVideo()); }
      catch (e: any) { if (e?.name === 'AbortError') ctx.toast('Recording cancelled. The view is back where it was.'); else ctx.toast(e?.message || String(e), true); }
      finally { busy = false; ctx.setLoading(null); ctx.renderDetails(); }
    });
  },
});

export function initTurntable() {
  registerCommand({ id: 'turntable', label: 'Turntable video / GIF', group: 'Present', keywords: 'record spin 360 animation mp4 webm gif', run: () => ctx.setTool('turntable'), enabled: () => !!ctx.viewer.model });
}
