import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * True when this module is the process entry point, i.e. it was run directly
 * via `node path/to/file.js` rather than imported by another module.
 *
 * Used so a script like `seed-admin.js` can both export functions for tests and
 * do its work when invoked from the CLI.
 */
export function isEntryPoint(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === resolve(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}