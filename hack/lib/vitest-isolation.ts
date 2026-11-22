/**
 * The three invariants every vitest run in this repository carries.
 *
 * 1. A per-run temp folder. `isolateTestRun()` points `TMPDIR` and
 *    `KICI_TMPDIR` at a fresh `<base>/kici-test/run-XXXXXX`, so every temp file
 *    the run, its workers and its subprocesses create lands in one folder. The
 *    folder is removed when the run passes and kept, stamped, for three days
 *    when it fails (`test-run-dir.ts`). A nested run inherits its parent's
 *    folder. It runs first so the config dir below lands inside the folder.
 * 2. Isolation. Point the run at an isolated, empty KICI_CONFIG_DIR so the CLI
 *    (and any `kici` child it spawns, which inherits this env) can never read
 *    the developer's ambient ~/.kici config, which names a real endpoint and
 *    carries a live PAT. A test that needs its own dir sets KICI_CONFIG_DIR
 *    first; this only fills the default. The directory this module creates is
 *    removed when the process exits (`isolated-config-dir.ts`).
 * 3. A worker ceiling. `claim()` bounds this process's worker count against the
 *    other vitest processes on the box — see `vitest-workers.ts` for why that is
 *    a claim rather than a constant.
 *
 * All three are assigned at config-eval time rather than through vitest's
 * `test.env` so they reach the main vitest process that runs `globalSetup`, its
 * forked workers, and any CLI those spawn. `test.env` reaches workers only.
 *
 * Every vitest config in this repository imports this module, directly or
 * through another module, so the temp folder and the worker ceiling ride the
 * same guarantee.
 */
import { isolateConfigDir } from './isolated-config-dir.ts';
import { isolateTestRun } from './test-run-dir.ts';
import { claim } from './vitest-workers.ts';

isolateTestRun();
isolateConfigDir();
claim();
