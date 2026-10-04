#!/usr/bin/env -S node --
// The `--` ends node's own options. Node reads `--env-file` from anywhere in its
// argv, script arguments included, so without it `kici-admin join --env-file <new
// file>` exits before this script runs and `orchestrator install --env-file` loads
// the file into this process.
// Route the orchestrator CLI's diagnostic logs to stderr so `--json` output
// (and any other machine-parsed stdout, e.g. direct-DB `source` reads) stays
// pure data. Set before the dynamic import so it takes effect when the command
// modules construct their loggers at import time. A statement before a dynamic
// import() runs first (unlike a hoisted static `import`), so the env is present
// when the module graph loads.
process.env.KICI_LOG_STDERR ??= '1';

const { runCli } = await import('@kici-dev/orchestrator/cli');

runCli();
