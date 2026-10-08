/**
 * Static import checker.
 *
 * Vite/esbuild only fails on missing *modules*, not on named imports that do not
 * exist. A bad named import builds cleanly and then throws
 * "X is not defined" the first time the component renders. This walks every
 * relative import in src/ and verifies each requested name is actually exported.
 *
 * Run: node scripts/check-imports.mjs
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const srcDir = join(root, 'src');

/** Every .jsx/.js file under src/. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.jsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Names a module exports, from all the declaration forms in use here. */
function exportsOf(source) {
  const names = new Set();

  for (const m of source.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/g)) {
    names.add(m[1]);
  }
  for (const m of source.matchAll(/export\s+class\s+([A-Za-z0-9_$]+)/g)) {
    names.add(m[1]);
  }
  for (const m of source.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(m[1]);
  }
  // export const { a, b } = ...  /  export let [a] = ...
  for (const m of source.matchAll(/export\s+(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().trim();
      if (name) names.add(name);
    }
  }
  // export { a, b as c }
  for (const m of source.matchAll(/export\s*\{([^}]*)\}\s*(?!from)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  // export default function Name(...)  -> also callable as a default import
  names.add('default');

  return names;
}

const problems = [];
let checked = 0;

for (const file of walk(srcDir)) {
  const source = readFileSync(file, 'utf8');

  // Only relative imports are resolvable from disk; package imports are the
  // bundler's business.
  const importRe = /import\s+([^'"]+?)\s+from\s+['"](\.[^'"]+)['"]/g;
  for (const match of source.matchAll(importRe)) {
    const [, clause, specifier] = match;

    const target = resolve(dirname(file), specifier);
    if (!existsSync(target)) {
      problems.push(`${file}: cannot resolve ${specifier}`);
      continue;
    }

    const available = exportsOf(readFileSync(target, 'utf8'));

    // Named imports: import { a, b as c } from '...'
    const named = clause.match(/\{([^}]*)\}/);
    if (named) {
      for (const part of named[1].split(',')) {
        const name = part.split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        checked += 1;
        if (!available.has(name)) {
          problems.push(
            `${file}\n    imports { ${name} } from ${specifier}\n    but ${specifier} does not export it`,
          );
        }
      }
    }
  }
}

if (problems.length) {
  console.error(`Found ${problems.length} import problem(s):\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`All ${checked} named imports resolve to a real export.`);
