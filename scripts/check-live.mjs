// Release check (audit F30): the live site must not load third-party scripts. "No tracking" is a promise on the
// home page, and Cloudflare can inject its Web Analytics beacon at the edge without any change in this repository.
// Usage: node scripts/check-live.mjs [base-url]   (exit code 1 when a third-party script is found)
const base = (process.argv[2] || process.env.SITE_URL || 'https://omniviewer3d.com/').replace(/\/?$/, '/');
const host = new URL(base).host;
const paths = ['', 'stl-to-glb/', 'stl-viewer/', 'measure/', 'de/'];
let bad = 0;
for (const p of paths) {
  // Ask like a browser: the edge injects the beacon only into responses for browser-style HTML requests.
  const res = await fetch(base + p, { headers: { accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US', 'user-agent': 'Mozilla/5.0 (omniviewer release check) AppleWebKit/537.36 Chrome/130.0 Safari/537.36' } });
  const html = await res.text();
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  const third = srcs.filter((s) => /^(https?:)?\/\//.test(s) && new URL(s, base).host !== host);
  const inline = /cloudflareinsights|beacon\.min\.js|googletagmanager|google-analytics/.test(html);
  if (third.length || inline) { bad++; console.log(`::warning::/${p} loads third-party scripts: ${[...third, inline ? '(analytics snippet in HTML)' : ''].filter(Boolean).join(', ')}`); }
  else console.log(`ok /${p} (${res.status})`);
}
if (bad) { console.log('Turn off Web Analytics / RUM for this site in the Cloudflare dashboard (Analytics & Logs → Web Analytics).'); process.exit(1); }
