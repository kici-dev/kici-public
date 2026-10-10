/**
 * Where `kici types` reads secret key names from, how the generated file
 * records it, and when a refresh may replace an existing file.
 *
 * The sources, in order: a direct orchestrator target, the Platform login,
 * then the local secret files `kici run --local` reads (`.kici/.secrets`,
 * `.kici/secrets.yaml`). A key set read from an orchestrator or the Platform
 * is never replaced by one built from local files or by the offline stub: an
 * offline laptop must not narrow a team's real key set to whatever happens to
 * be in its local files.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export type TypesSource =
  { kind: 'orchestrator'; url: string } | { kind: 'platform'; orgId: string } | { kind: 'local' };

/** The label the generated file's `// Source:` header carries. */
export function sourceHeaderLabel(source: TypesSource): string {
  switch (source.kind) {
    case 'orchestrator':
      return `orchestrator ${source.url}`;
    case 'platform':
      return `Platform org ${source.orgId}`;
    case 'local':
      return 'local files';
  }
}

export type ExistingTypesSource = 'remote' | 'local' | 'offline' | 'none';

const SOURCE_HEADER = /^\/\/ Source: (.*)$/m;

/**
 * Classify an existing declaration file by its `// Source:` header. A file
 * with no recognizable header counts as remote, so a refresh never discards
 * content it cannot place; so does an older CLI's header, which named the
 * Platform URL.
 */
export function existingTypesSource(content: string | null): ExistingTypesSource {
  if (content === null) return 'none';
  const label = SOURCE_HEADER.exec(content)?.[1] ?? '';
  if (label.startsWith('offline stub')) return 'offline';
  if (label === 'local files') return 'local';
  return 'remote';
}

/** Whether a refresh from `incoming` may overwrite a file from `existing`. */
export function mayReplace(
  existing: ExistingTypesSource,
  incoming: 'remote' | 'local' | 'offline',
): boolean {
  switch (incoming) {
    case 'remote':
      return true;
    case 'local':
      return existing !== 'remote';
    case 'offline':
      return existing === 'none' || existing === 'offline';
  }
}

/** Whether the project has a local secret file `kici types` can read. */
export async function hasLocalSecretFiles(kiciDir: string): Promise<boolean> {
  for (const name of ['.secrets', 'secrets.yaml']) {
    try {
      await fs.access(path.join(kiciDir, name));
      return true;
    } catch {
      // absent — try the next one
    }
  }
  return false;
}
