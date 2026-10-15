/**
 * Node-only network primitives, imported as `@kici-dev/shared/net`. Kept off
 * the main barrel because `nftables.ts` promisifies `child_process.execFile` at
 * module scope, which would pull `node:child_process` into every consumer's
 * module graph.
 */

export * from './net/nftables.js';
