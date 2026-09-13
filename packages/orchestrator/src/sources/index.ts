/**
 * Source management module for the orchestrator.
 *
 * Provides CRUD operations (SourceStore), LISTEN/NOTIFY hot reload (SourceManager),
 * and credential validation (validateGitHubSource) for webhook sources.
 */
export { SourceStore, type AddSourceParams, type SourceWithSecrets } from './source-store.js';
export { SourceManager, type SourceManagerOptions } from './source-manager.js';
export { validateGitHubSource, type ValidationResult } from './source-validator.js';
