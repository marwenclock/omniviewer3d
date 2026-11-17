// Runs the fixture regression tests in Node (no browser needed): bundles tests/*.test.ts with esbuild, then node --test.
import { build } from 'esbuild';
import { readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'node_modules', '.omniviewer-tests');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const entries = readdirSync(join(root, 'tests')).filter((f) => f.endsWith('.test.ts')).map((f) => join(root, 'tests', f));
await build({
  entryPoints: entries,
  outdir: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
});
const files = readdirSync(out).filter((f) => f.endsWith('.mjs')).map((f) => join(out, f));
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
