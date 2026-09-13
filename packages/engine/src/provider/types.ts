/**
 * Common provider types for the KiCI provider abstraction layer.
 *
 * These types are the foundation for all provider interfaces.
 * Keep this minimal -- only types needed by multiple interfaces belong here.
 */

/** Identifies a git hosting provider, generic webhook source, or local filesystem (`file://`) source. */
export type ProviderType = 'github' | 'gitlab' | 'bitbucket' | 'generic' | 'local';
