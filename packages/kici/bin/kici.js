#!/usr/bin/env node
// The TypeScript ESM loader hook is registered lazily by the compiler at the
// points that load workflow .ts (compile / run local / test / fixtures), so
// commands that never touch user .ts (login, status, org, …) pay no hook tax.
import { runCli } from '@kici-dev/compiler/cli';

runCli();
