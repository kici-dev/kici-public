import { describe, it, expect } from 'vitest';

import { trustedContributorHoldReason, unknownContributorHoldReason } from './hold-reason.js';

describe('unknownContributorHoldReason', () => {
  it('renders the trust gate sentence for a minimumTrust=known hold', () => {
    expect(unknownContributorHoldReason('production')).toBe(
      "Context 'production' requires known contributors (contributor is unknown)",
    );
  });

  it('interpolates the context name verbatim', () => {
    expect(unknownContributorHoldReason('ci-security-env')).toBe(
      "Context 'ci-security-env' requires known contributors (contributor is unknown)",
    );
  });
});

describe('trustedContributorHoldReason', () => {
  it('renders the trust gate sentence for a minimumTrust=trusted hold', () => {
    expect(trustedContributorHoldReason('production', 'known')).toBe(
      "Context 'production' requires trusted contributors (contributor is known)",
    );
  });

  it('interpolates the contributor tier verbatim', () => {
    expect(trustedContributorHoldReason('production', 'unknown')).toBe(
      "Context 'production' requires trusted contributors (contributor is unknown)",
    );
  });
});
