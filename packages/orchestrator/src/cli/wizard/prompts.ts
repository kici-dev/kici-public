/**
 * Shared prompt utilities for the setup wizards.
 *
 * Wraps @inquirer/prompts with consistent formatting and
 * validation for common input types (DB URLs, ports, etc.).
 */

import { input, select, confirm, password } from '@inquirer/prompts';

/** Prompt for a PostgreSQL database URL with validation. */
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

/** Prompt for a port number with validation. */
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

/** Prompt for a yes/no confirmation. */
export async function promptConfirm(message: string, defaultValue = true): Promise<boolean> {
  return confirm({ message, default: defaultValue });
}

/** Prompt for a URL with http(s):// validation. */
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

/** Prompt for a secret/password (masked input). */
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

/** Prompt for a selection from a list of options. */
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
