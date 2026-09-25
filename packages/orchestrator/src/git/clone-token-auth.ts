/**
 * The structured clone auth a bare clone token stands for.
 */
import type { ProviderGitAuth } from '@kici-dev/engine';

/** Basic-auth envelope for a provider clone token (`x-access-token` user, GitHub convention). */
export function cloneTokenGitAuth(token: string): ProviderGitAuth {
  return { kind: 'basic', user: 'x-access-token', secret: token };
}
