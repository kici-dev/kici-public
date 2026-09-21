import { describe, it, expect } from 'vitest';

import * as holdReason from './hold-reason.js';
import { trustedContributorHoldReason } from './hold-reason.js';

describe('trustedContributorHoldReason', () => {
  it('renders the trust gate sentence for a minimumTrust=trusted hold', () => {
    expect(trustedContributorHoldReason('production', 'unknown')).toBe(
      "Context 'production' requires trusted contributors (contributor is unknown)",
    );
  });

  it('interpolates the context name verbatim', () => {
    expect(trustedContributorHoldReason('ci-security-env', 'unknown')).toBe(
      "Context 'ci-security-env' requires trusted contributors (contributor is unknown)",
    );
  });

  // fails-when: a second hold-reason template for a removed trust floor is exported again
  it('is the only hold-reason template', () => {
    expect(Object.keys(holdReason)).toEqual(['trustedContributorHoldReason']);
  });
});
