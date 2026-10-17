/**
 * @internal — NOT covered by semver.
 *
 * The runtime ABI between `@kici-dev/sdk` and the KiCI agent, compiler, and
 * orchestrator: it installs the maps a `.result` proxy reads, builds the step
 * context, evaluates rules, and expands matrices. A workflow author never calls
 * any of it.
 *
 * It lives on its own subpath because the root barrel is **compat-protected**
 * (frozen at v1.0.0, removable only at a major bump): there, a version
 * handshake or a per-job outputs map would be a customer-facing deprecation
 * for a function no customer ever called.
 *
 * These symbols live only here. The agent and the compiler test runner resolve
 * the customer's own SDK copy through this subpath (`workflow-loader.ts`,
 * `job-executor.ts`), so an SDK that predates it cannot drive a workflow on a
 * current agent.
 *
 * Do not import this from a workflow: it may change shape in any release.
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
export { normalizeMiseVersion } from './mise-version.js';
export { isAptPackageSpec } from './apt-package.js';
