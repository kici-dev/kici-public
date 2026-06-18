// Public API for programmatic use
export { executeConfig } from './execution/index.js';
export type { ExecutionResult } from './execution/index.js';

export { validateConfig } from './validation/index.js';
export type { ValidationResult } from './validation/index.js';

export { generateLockFile, serializeLockFile } from './lockfile/index.js';

// Lock file types
export { SCHEMA_VERSION, isLockStaticJob } from './types.js';
export type {
  LockFile,
  LockWorkflow,
  LockJob,
  LockDynamicJobFn,
  LockJobOrFactory,
  LockTrigger,
  LockPrTrigger,
  LockPushTrigger,
  LockMatrix,
  LockRule,
  LockStep,
  LockApproval,
  LockSource,
  LockBranchPattern,
} from './types.js';

// Error types
export { formatError, compilerError, isCompilerError } from './errors/index.js';
export type { SourceLocation, CompilerError } from './errors/index.js';
export { CapabilityGapError, formatCapabilityGapError } from './errors/index.js';
export type { CapabilityGapInfo } from './errors/index.js';
