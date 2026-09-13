import { describe, it, expect } from 'vitest';
import { isMintedRef, type GitCredentialRef, type GitCredentialGrant } from './git-credential.js';

describe('isMintedRef', () => {
  it('classifies an app ref as minted', () => {
    const ref: GitCredentialRef = {
      kind: 'app',
      appIdSecret: 'ci:GH_APP_ID',
      installationIdSecret: 'ci:GH_INSTALL_ID',
      privateKeySecret: 'ci:GH_APP_KEY',
    };
    expect(isMintedRef(ref)).toBe(true);
  });

  it('classifies token and ssh refs as static', () => {
    expect(isMintedRef({ kind: 'token', tokenSecret: 'ci:FORGE_PAT' })).toBe(false);
    expect(isMintedRef({ kind: 'ssh', privateKeySecret: 'ci:DEPLOY_KEY' })).toBe(false);
  });

  it('accepts runtime material through the *Value half of a pair', () => {
    const ref: GitCredentialRef = { kind: 'token', tokenValue: 'ghs_runtime' };
    expect(isMintedRef(ref)).toBe(false);
  });

  it('models an unscoped grant for static credentials', () => {
    const grant: GitCredentialGrant = { scoped: false };
    expect(grant.scoped).toBe(false);
  });
});
