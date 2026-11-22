import { describe, it, expect } from 'vitest';
import { HostWorkspace, hostWorkspaceFor } from './host-workspace.js';

const W = HostWorkspace.enum;
const base = {
  container: true,
  checkout: false,
  sourceCached: false,
  fullRepo: false,
  kiciPresent: false,
};

describe('hostWorkspaceFor', () => {
  it('fetches .kici/ on the host for a checkout: false container job with no other source', () =>
    // fails-when: the job is left to the in-sandbox .kici/ fetch, which needs git and
    // the source credentials inside the customer image
    expect(hostWorkspaceFor(base)).toBe(W['kici-only']));

  it('clones on the host for a container job with a checkout', () => {
    expect(hostWorkspaceFor({ ...base, checkout: true })).toBe(W.clone);
    expect(hostWorkspaceFor({ ...base, checkout: undefined })).toBe(W.clone);
  });

  it.each([
    ['a bare-metal / fork checkout: false job (the runner fetches .kici/)', { container: false }],
    ['a container job with a cached source (the runner restores it)', { sourceCached: true }],
    ['a full-repo container job (the overlay carries .kici/)', { fullRepo: true }],
    ['an in-place container job (.kici/ is already there)', { kiciPresent: true }],
  ])('prepares nothing on the host for %s', (_label, overrides) =>
    // breaks-if-wrong: these jobs keep the workspace path they had
    expect(hostWorkspaceFor({ ...base, ...overrides })).toBe(W.none),
  );
});
