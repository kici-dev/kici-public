import { register } from 'node:module';

// The oxc-transform ESM loader hook loads workflow .ts (enums, parameter
// properties and namespaces included) and rewrites `./foo.js` to `./foo.ts` when
// only the .ts exists. Every later import then goes through its resolve(), so it
// registers lazily, once, only for commands that load user .ts.
let registered = false;

export function ensureTsLoaderHook(): void {
  if (registered) return;
  registered = true;
  register('@kici-dev/core/ts-loader-hook', import.meta.url);
}
