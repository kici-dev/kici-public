import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface ParsedSecrets {
  flat: Record<string, string>;
  contexts: Record<string, Record<string, string>>;
}

/**
 * Parse an INI-style secrets file:
 *   # comment
 *   KEY=VALUE             -> flat secrets (before any section)
 *   [sectionName]         -> starts a context section
 *   KEY=VALUE             -> context secrets (within a section)
 *
 * Values are everything after the first `=`, trimmed. Section names may contain
 * hyphens, underscores, etc. Lines without `=` are ignored.
 */
export function parseSecretsFile(content: string): ParsedSecrets {
  const flat: Record<string, string> = {};
  const contexts: Record<string, Record<string, string>> = {};
  let currentSection: string | null = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();

    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (!contexts[currentSection]) {
        contexts[currentSection] = {};
      }
      continue;
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();

    if (currentSection === null) {
      flat[key] = value;
    } else {
      contexts[currentSection][key] = value;
    }
  }

  return { flat, contexts };
}

/** Load `.kici/.secrets`; empty secrets when the file does not exist. */
export async function loadSecretsFile(kiciDir: string): Promise<ParsedSecrets> {
  const secretsPath = path.join(kiciDir, '.secrets');
  try {
    const content = await readFile(secretsPath, 'utf-8');
    return parseSecretsFile(content);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { flat: {}, contexts: {} };
    }
    throw err;
  }
}
