// Module-customization hooks for the CLI-closure tracer.
//
// Runs on the hooks thread. The `resolve` hook fires for every module
// specifier the process tries to load (bare imports like `commander`,
// relative `./foo.js`, builtins like `node:fs`, …). We record the RAW
// specifier; recording the raw specifier is enough to catch forbidden bare
// imports such as `@opentelemetry/api` or `pg`.
//
// Why we append to a file (env var KICI_TRACE_FILE) with a SYNCHRONOUS
// `fs.appendFileSync` instead of writing to stderr: commander's `.version()`
// prints and then calls `process.exit(0)` synchronously on the main thread.
// stderr writes issued from the hooks thread are asynchronous relative to that
// exit and get truncated — the process tears down before they flush, so the
// trace comes back empty. A synchronous append to an O_APPEND fd completes the
// write syscall before returning, so every resolved specifier is durably on
// disk regardless of how fast the main thread exits.
import { appendFileSync } from 'node:fs';

const traceFile = process.env.KICI_TRACE_FILE;

export async function resolve(specifier, context, nextResolve) {
  if (traceFile) {
    appendFileSync(traceFile, `${specifier}\n`);
  }
  return nextResolve(specifier, context);
}
