/**
 * Where `kici types` reads secret key names from, in order: a direct
 * orchestrator target, the Platform login, then the local secret files
 * `kici run --local` reads (`.kici/.secrets`, `.kici/secrets.yaml`). A key set
 * from an orchestrator or the Platform is never replaced by local files or the
 * offline stub: an offline laptop must not narrow a team's real key set.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export type TypesSource =
  { kind: 'orchestrator'; url: string } | { kind: 'platform'; orgId: string } | { kind: 'local' };

/** The generated file's `// Source:` header label. */
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
 * Classifies by the `// Source:` header. An unrecognized header, an older CLI's
 * Platform-URL header included, counts as remote, so a refresh never discards
 * content it cannot place.
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

export async function hasLocalSecretFiles(kiciDir: string): Promise<boolean> {
  for (const name of ['.secrets', 'secrets.yaml']) {
    try {
      await fs.access(path.join(kiciDir, name));
      return true;
    } catch {
      // Absent: try the next one.
    }
  }
  return false;
}
