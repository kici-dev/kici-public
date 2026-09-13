// ESM resolve-hook tracer used by `src/cli-closure.test.ts`.
//
// Registered via `node --import ./hack/trace-loaded-modules.mjs <bin>`. It
// installs a module-customization hook whose `resolve` step records the raw
// specifier of every module the process loads, appending each one to the file
// named by the KICI_TRACE_FILE env var. The spawning test reads that file back
// after the process exits.
//
// A file (rather than stderr) is the channel because commander's `.version()`
// calls `process.exit(0)` synchronously, which truncates async stderr writes
// issued from the hooks thread. See trace-loaded-modules-hooks.mjs for detail.
import { register } from 'node:module';

register('./trace-loaded-modules-hooks.mjs', import.meta.url);
