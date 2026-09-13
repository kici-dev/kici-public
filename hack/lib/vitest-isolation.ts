/**
 * The two invariants every vitest run in this repository carries.
 *
 * 1. Isolation. Point the run at an isolated, empty KICI_CONFIG_DIR so the CLI
 *    (and any `kici` child it spawns, which inherits this env) can never read
 *    the developer's ambient ~/.kici config, which names a real endpoint and
 *    carries a live PAT. A test that needs its own dir sets KICI_CONFIG_DIR
 *    first; this only fills the default.
 * 2. A worker ceiling. `claim()` bounds this process's worker count against the
 *    other vitest processes on the box — see `vitest-workers.ts` for why that is
 *    a claim rather than a constant.
 *
 * Both are assigned at config-eval time rather than through vitest's `test.env`
 * so they reach the main vitest process that runs `globalSetup`, its forked
 * workers, and any CLI those spawn. `test.env` reaches workers only — the same
 * asymmetry `e2e/vitest.base.ts` documents for `.env.test.local`.
 *
 * Enforced by `hack/check-vitest-isolation.ts`: every vitest config in this
 * repository must be able to reach this module. The check walks imports
 * transitively, so the worker ceiling rides the same guarantee.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { claim } from './vitest-workers.ts';

if (!process.env.KICI_CONFIG_DIR) {
  process.env.KICI_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-test-config-'));
}
claim();
