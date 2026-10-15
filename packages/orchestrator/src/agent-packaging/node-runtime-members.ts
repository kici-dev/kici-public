/**
 * The members of an official Node.js Linux or macOS archive that a KiCI payload
 * vendors, relative to the archive's `node-v<version>-<os>-<arch>/` directory:
 * with them the agent's `resolveNpm()` finds npm beside the vendored `node`, so
 * the builder role needs no npm on the host.
 *
 * No imports, so repository tooling can read the list:
 * `scripts/lib/node-dist.mjs` (the standalone package builder) keeps its own
 * copy, and its test pins the two lists equal.
 */
export const NODE_RUNTIME_MEMBERS = [
  'bin/node',
  'bin/npm',
  'bin/npx',
  'lib/node_modules/npm',
] as const;
