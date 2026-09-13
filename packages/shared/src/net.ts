/**
 * Node-only network primitives, kept off the main barrel.
 *
 * `nftables.ts` promisifies `child_process.execFile` at module scope, so
 * exporting it from `index.ts` would pull `node:child_process` into the module
 * graph of every `@kici-dev/shared` consumer — including ones that only wanted
 * a logger. Importers ask for it explicitly: `@kici-dev/shared/net`.
 */

export * from './net/nftables.js';
