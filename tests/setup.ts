// Minimal browser shims so three.js exporters and loaders run in Node.
if (typeof (globalThis as any).FileReader === 'undefined') {
  (globalThis as any).FileReader = class {
    result: any = null;
    onloadend: ((e: any) => void) | null = null;
    onload: ((e: any) => void) | null = null;
    readAsArrayBuffer(blob: Blob) { blob.arrayBuffer().then((b) => { this.result = b; this.onload?.({ target: this }); this.onloadend?.({ target: this }); }); }
    readAsDataURL(blob: Blob) {
      blob.arrayBuffer().then((b) => {
        this.result = `data:${blob.type || 'application/octet-stream'};base64,` + Buffer.from(b).toString('base64');
        this.onload?.({ target: this }); this.onloadend?.({ target: this });
      });
    }
  };
}
if (typeof (globalThis as any).requestAnimationFrame === 'undefined') {
  (globalThis as any).requestAnimationFrame = (fn: (t: number) => void) => setTimeout(() => fn(Date.now()), 0);
}
export {};
