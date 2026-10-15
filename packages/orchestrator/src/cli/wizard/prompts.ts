/** Validated @inquirer/prompts wrappers shared by the setup wizards. */

import { input, select, confirm, password } from '@inquirer/prompts';

export async function promptDbUrl(): Promise<string> {
  return input({
    message: 'PostgreSQL database URL:',
    validate: (value: string) => {
      const v = value.trim();
      if (!v.startsWith('postgresql://') && !v.startsWith('postgres://')) {
        return 'Must start with postgresql:// or postgres://';
      }
      return true;
    },
  });
}

export async function promptPort(defaultPort: number): Promise<number> {
  const value = await input({
    message: 'Port:',
    default: String(defaultPort),
    validate: (value: string) => {
      const n = parseInt(value.trim(), 10);
      if (isNaN(n) || n < 1 || n > 65535) {
        return 'Must be a number between 1 and 65535';
      }
      return true;
    },
  });
  return parseInt(value.trim(), 10);
}

export async function promptConfirm(message: string, defaultValue = true): Promise<boolean> {
  return confirm({ message, default: defaultValue });
}

/** Requires an http(s):// URL. */
export async function promptUrl(message: string, defaultValue?: string): Promise<string> {
  return input({
    message,
    default: defaultValue,
    validate: (value: string) => {
      const v = value.trim();
      if (
        !v.startsWith('http://') &&
        !v.startsWith('https://') &&
        !v.startsWith('wss://') &&
        !v.startsWith('ws://')
      ) {
        return 'Must start with http://, https://, ws://, or wss://';
      }
      return true;
    },
  });
}

/**
 * Blank returns undefined; anything else needs an http(s)/ws(s) scheme. For a
 * URL that may stay unset (the hybrid public ingress base), which `promptUrl`
 * rejects.
 */
export async function promptOptionalUrl(message: string): Promise<string | undefined> {
  const value = await input({
    message,
    validate: (value: string) => {
      const v = value.trim();
      if (!v) return true;
      if (
        !v.startsWith('http://') &&
        !v.startsWith('https://') &&
        !v.startsWith('wss://') &&
        !v.startsWith('ws://')
      ) {
        return 'Must start with http://, https://, ws://, or wss:// (or leave blank to skip)';
      }
      return true;
    },
  });
  return value.trim() || undefined;
}

/** Masked input. */
export async function promptSecret(message: string): Promise<string> {
  return password({
    message,
    mask: '*',
    validate: (value: string) => {
      if (!value.trim()) return 'This field is required';
      return true;
    },
  });
}

export async function promptSelect<T extends string>(
  message: string,
  choices: { name: string; value: T; description?: string }[],
  defaultValue?: T,
): Promise<T> {
  return select({
    message,
    choices,
    default: defaultValue,
  });
}
