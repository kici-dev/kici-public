/**
 * @internal — NOT covered by semver.
 *
 * The runtime ABI between `@kici-dev/sdk` and the KiCI agent, compiler, and
 * orchestrator. Everything here is machinery the execution tiers drive on a
 * workflow's behalf: it installs the maps a `.result` proxy reads, builds the
 * step context a workflow body receives, evaluates its rules, and expands its
 * matrix. A workflow author never calls any of it.
 *
 * It lives on its own subpath because the root barrel is a **compat-protected**
 * surface (`.claude/rules/compatibility.md`): every symbol on it is frozen at
 * v1.0.0 and can only be removed at a major bump. Leaving the runtime ABI there
 * would mean a version handshake, or making the outputs map per-job instead of
 * module-global, is a customer-facing SDK deprecation — with a ledger row and a
 * dual-shape window — for a function no customer ever called. Every internal
 * refactor of the runtime would pay the public-API tax forever.
 *
 * These symbols live only here. The agent and the compiler test runner resolve
 * the customer's own SDK copy at run time (`workflow-loader.ts`,
 * `job-executor.ts`) through this subpath, so an SDK that predates it cannot
 * drive a workflow on a current agent.
 *
 * Do not import this from a workflow. It carries no compatibility promise and
 * may change shape in any release.
 */

export { flattenStepInputs } from './parallel.js';
export { normalizeApproval } from './approval.js';
export { evaluateRules, createRuleContext } from './rules/index.js';
export { buildNeedsContext } from './needs-context.js';
export { normalizeCacheSpecs } from './cache-types.js';
export { createFilterContext } from './filter-context.js';
export { buildKiciApi } from './api-types.js';
export { createStepSecrets } from './secrets.js';
export { setStepOutputsMap, setJobOutputsMap, setStepRefMap } from './outputs.js';
export { expandMatrix, applyIncludeExclude } from './matrix/index.js';
