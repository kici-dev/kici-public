/** Only types shared by several provider interfaces belong here. */

/** Identifies a git hosting provider, generic webhook source, or local filesystem (`file://`) source. */
export type ProviderType = 'github' | 'gitlab' | 'bitbucket' | 'generic' | 'local';
