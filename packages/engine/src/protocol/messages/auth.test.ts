import { describe, expect, it } from 'vitest';
import { authRequestSchema, authSuccessSchema, authFailureSchema } from './auth.js';

describe('authRequestSchema', () => {
  const validRequest = {
    type: 'auth.request',
    token: 'kici_sk_abc123def456',
    protocolVersion: 1,
    capabilities: { orchRole: 'coordinator' },
  };

  it('validates a well-formed auth request', () => {
    expect(authRequestSchema.parse(validRequest)).toEqual(validRequest);
  });

  it('rejects empty token', () => {
    expect(() => authRequestSchema.parse({ ...validRequest, token: '' })).toThrow();
  });

  it('rejects missing protocolVersion', () => {
    const { protocolVersion, ...rest } = validRequest;
    expect(() => authRequestSchema.parse(rest)).toThrow();
  });

  it('rejects non-positive protocolVersion', () => {
    expect(() => authRequestSchema.parse({ ...validRequest, protocolVersion: 0 })).toThrow();
    expect(() => authRequestSchema.parse({ ...validRequest, protocolVersion: -1 })).toThrow();
  });

  it('rejects non-integer protocolVersion', () => {
    expect(() => authRequestSchema.parse({ ...validRequest, protocolVersion: 1.5 })).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validRequest));
    expect(authRequestSchema.parse(roundTripped)).toEqual(validRequest);
  });

  // fails-when: the schema strips componentVersion, so the Platform never sees the release
  it('carries componentVersion, a release version with an optional prerelease suffix', () => {
    for (const componentVersion of ['0.30.0', '0.30.0-4512']) {
      expect(authRequestSchema.parse({ ...validRequest, componentVersion })).toEqual({
        ...validRequest,
        componentVersion,
      });
    }
  });

  // breaks-if-wrong: every release before the field sends none, and must still parse
  it('accepts an auth request without componentVersion', () => {
    expect(authRequestSchema.parse(validRequest)).not.toHaveProperty('componentVersion');
  });

  // breaks-if-wrong: a later release that widens the form (build metadata, another scheme) must
  // still parse on every Platform at this release, hosted included; only the self-managed
  // refusal reads the form, and it treats a value in another form as absent
  it('accepts a componentVersion that is not a release version', () => {
    for (const componentVersion of ['unknown', '1.2', 'v1.2.3', '0.31.0+abc', '']) {
      expect(authRequestSchema.parse({ ...validRequest, componentVersion })).toEqual({
        ...validRequest,
        componentVersion,
      });
    }
  });

  // breaks-if-wrong: before the field existed, the non-strict object stripped any value, so every
  // Platform accepted it; no value of componentVersion may now refuse the handshake
  it('parses a componentVersion of any length or type', () => {
    for (const componentVersion of ['9'.repeat(65), null, 30, {}, ['0.30.0'], true]) {
      expect(
        authRequestSchema.safeParse({ ...validRequest, componentVersion }).success,
        JSON.stringify(componentVersion),
      ).toBe(true);
    }
  });
});

describe('authSuccessSchema', () => {
  const validSuccess = {
    type: 'auth.success',
    connectionId: 'conn-abc-123',
    orgPublicAlias: 'oal_x',
    orgId: 'org_abc123def456',
    githubWebhookUrl: null,
  };

  it('validates a well-formed success response', () => {
    expect(authSuccessSchema.parse(validSuccess)).toEqual(validSuccess);
  });

  it('rejects missing connectionId', () => {
    const { connectionId, ...rest } = validSuccess;
    expect(() => authSuccessSchema.parse(rest)).toThrow();
  });

  it('strips unknown fields (no appId)', () => {
    const withAppId = { ...validSuccess, appId: 12345 };
    const result = authSuccessSchema.parse(withAppId);
    expect(result).not.toHaveProperty('appId');
    expect(result).toEqual(validSuccess);
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validSuccess));
    expect(authSuccessSchema.parse(roundTripped)).toEqual(validSuccess);
  });

  // fails-when: the schema does not declare dashboardUrl, so z.object strips it and a
  //   newer orchestrator never learns the dashboard base.
  it('carries dashboardUrl when the Platform sends it', () => {
    expect(
      authSuccessSchema.parse({ ...validSuccess, dashboardUrl: 'https://app.kici.dev' })
        .dashboardUrl,
    ).toBe('https://app.kici.dev');
  });

  // breaks-if-wrong: a required dashboardUrl makes every orchestrator refuse an older
  //   Platform's handshake.
  it('accepts an auth.success without dashboardUrl (older Platform)', () => {
    const parsed = authSuccessSchema.parse(validSuccess);
    expect(parsed).not.toHaveProperty('dashboardUrl');
  });

  // fails-when: the field gains .url() or .min(1); an odd Platform value would then
  //   refuse the whole handshake instead of producing an odd link.
  it('accepts any string dashboardUrl', () => {
    expect(
      authSuccessSchema.safeParse({ ...validSuccess, dashboardUrl: 'not a url' }).success,
    ).toBe(true);
    expect(authSuccessSchema.safeParse({ ...validSuccess, dashboardUrl: '' }).success).toBe(true);
  });

  // fails-when: the schema does not declare githubManifestCallbackUrl, so z.object strips
  //   it and kici-admin never learns the Platform's own manifest page.
  it('carries githubManifestCallbackUrl when the Platform sends it', () => {
    const parsed = authSuccessSchema.parse({
      ...validSuccess,
      githubManifestCallbackUrl: 'https://kici.corp.example/github/manifest-callback',
    });
    expect(parsed.githubManifestCallbackUrl).toBe(
      'https://kici.corp.example/github/manifest-callback',
    );
  });

  // breaks-if-wrong: a required field makes every orchestrator refuse the handshake of
  //   a Platform that serves no manifest page.
  it('accepts an auth.success without githubManifestCallbackUrl', () => {
    const parsed = authSuccessSchema.parse(validSuccess);
    expect(parsed).not.toHaveProperty('githubManifestCallbackUrl');
  });

  // The Platform omits the key when it has no base; a null is not a valid value.
  it('refuses a null dashboardUrl', () => {
    expect(authSuccessSchema.safeParse({ ...validSuccess, dashboardUrl: null }).success).toBe(
      false,
    );
  });

  it('carries the canonical orgId and orgPublicAlias', () => {
    const msg = authSuccessSchema.parse(validSuccess);
    expect(msg.orgId).toBe('org_abc123def456');
    expect(msg.orgPublicAlias).toBe('oal_x');
  });

  it('carries no provenance issuer: the Platform publishes none', () => {
    // fails-when: the schema still declares the removed provenanceIssuer field.
    const parsed = authSuccessSchema.parse({ ...validSuccess, provenanceIssuer: 'https://x' });
    expect(parsed).not.toHaveProperty('provenanceIssuer');
  });

  // fails-when: the schema strips githubWebhookUrl, so a newer orchestrator
  //   never learns the Platform's webhook URL and platform-mode manifests abort.
  it('carries githubWebhookUrl as a string and as null', () => {
    const url = 'https://api.kici.dev/webhook/org_abc123def456/github';
    expect(
      authSuccessSchema.parse({ ...validSuccess, githubWebhookUrl: url }).githubWebhookUrl,
    ).toBe(url);
    expect(
      authSuccessSchema.parse({ ...validSuccess, githubWebhookUrl: null }).githubWebhookUrl,
    ).toBeNull();
  });

  it('rejects a non-string githubWebhookUrl', () => {
    expect(authSuccessSchema.safeParse({ ...validSuccess, githubWebhookUrl: 42 }).success).toBe(
      false,
    );
  });
});

describe('authFailureSchema', () => {
  const validFailure = {
    type: 'auth.failure',
    reason: 'Invalid API key',
  };

  it('validates a well-formed failure response', () => {
    expect(authFailureSchema.parse(validFailure)).toEqual(validFailure);
  });

  it('rejects missing reason', () => {
    expect(() => authFailureSchema.parse({ type: 'auth.failure' })).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validFailure));
    expect(authFailureSchema.parse(roundTripped)).toEqual(validFailure);
  });
});
