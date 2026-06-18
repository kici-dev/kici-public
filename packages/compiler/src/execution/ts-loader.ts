import { register } from 'node:module';

// The oxc-transform ESM loader hook lets the CLI load workflow .ts files on the
// fly (full TypeScript coverage: enums, parameter properties, namespaces) and
// rewrites `./foo.js` specifiers to `./foo.ts` when only the .ts sibling exists.
// Registering it makes every subsequent import in this process round-trip
// through the hook's resolve(), so we register lazily — only the commands that
// actually load user .ts pay the cost, and only once per process.
let registered = false;

export function ensureTsLoaderHook(): void {
  if (registered) return;
  registered = true;
  register('@kici-dev/core/ts-loader-hook', import.meta.url);
}
