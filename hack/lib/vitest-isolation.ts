/**
 * The two invariants every vitest run in this repository carries.
 *
 * 1. Isolation. Point the run at an isolated, empty KICI_CONFIG_DIR so the CLI
 *    (and any `kici` child it spawns, which inherits this env) can never read
 *    the developer's ambient ~/.kici config, which names a real endpoint and
 *    carries a live PAT. A test that needs its own dir sets KICI_CONFIG_DIR
 *    first; this only fills the default. The directory this module creates is
 *    removed when the process exits (`isolated-config-dir.ts`).
 * 2. A worker ceiling. `claim()` bounds this process's worker count against the
 *    other vitest processes on the box — see `vitest-workers.ts` for why that is
 *    a claim rather than a constant.
 *
 * Both are assigned at config-eval time rather than through vitest's `test.env`
 * so they reach the main vitest process that runs `globalSetup`, its forked
 * workers, and any CLI those spawn. `test.env` reaches workers only.
 *
 * Every vitest config in this repository imports this module, directly or
 * through another module, so the worker ceiling rides the same guarantee.
 */
import { isolateConfigDir } from './isolated-config-dir.ts';
import { claim } from './vitest-workers.ts';

isolateConfigDir();
claim();
