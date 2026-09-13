/**
 * Diagnostics module.
 *
 * Re-exports all diagnostic types, runner, checks, bundle writer, and bundle reader.
 */

export type { DiagnosticResult, DiagnosticDeps, DiagnosticCheck } from './types.js';
export { runDiagnostics } from './runner.js';
export type { RunDiagnosticsOptions } from './runner.js';
export { createDebugBundle, redactConfig } from './bundle-writer.js';
export type { BundleOptions } from './bundle-writer.js';
export { readDebugBundle } from './bundle-reader.js';
export type { BundleSummary, BundleManifest } from './bundle-reader.js';
