export {
  generateLockFile,
  serializeLockFile,
  detectGitRoot,
  computeLockfileHash,
  schemaWindowWarning,
} from './generator.js';
export { computeContentHash, COMPILE_SCHEMA_VERSION } from './hasher.js';
export {
  DynamicValueField,
  analyzeJobPurity,
  collectWorkflowPurityWarnings,
} from './purity-diagnostics.js';
export type { JobPurityWarning } from './purity-diagnostics.js';
