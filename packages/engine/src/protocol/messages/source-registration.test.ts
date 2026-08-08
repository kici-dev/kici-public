import { describe, it, expect } from 'vitest';
import {
  sourceRegistrationSchema,
  SourceSubtype,
  OrchestratorMode,
  PLATFORM_CONNECTED_MODES,
  RELAY_INGRESS_MODES,
  OWN_INGRESS_MODES,
} from './source-registration.js';

describe('sourceRegistrationSchema slug', () => {
  const base = {
    type: 'source.register' as const,
    messageId: 'm1',
  };

  it('parses a source carrying a slug and round-trips it', () => {
    const parsed = sourceRegistrationSchema.parse({
      ...base,
      sources: [
        {
          provider: 'github',
          routingKey: 'github:42',
          name: 'My KiCI App',
          subtype: SourceSubtype.enum.github_app,
          slug: 'my-kici-app',
        },
      ],
    });
    expect(parsed.sources[0].slug).toBe('my-kici-app');
  });

  it('parses a source without a slug (optional)', () => {
    const parsed = sourceRegistrationSchema.parse({
      ...base,
      sources: [
        {
          provider: 'generic',
          routingKey: 'generic:abc',
          name: 'Internal webhook',
          subtype: SourceSubtype.enum.generic_webhook,
        },
      ],
    });
    expect(parsed.sources[0].slug).toBeUndefined();
  });

  it('rejects an empty-string slug', () => {
    const result = sourceRegistrationSchema.safeParse({
      ...base,
      sources: [
        {
          provider: 'github',
          routingKey: 'github:42',
          name: 'My KiCI App',
          subtype: SourceSubtype.enum.github_app,
          slug: '',
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('sourceRegistrationSchema mode', () => {
  const base = {
    type: 'source.register' as const,
    messageId: 'm1',
    sources: [],
  };

  it.each(OrchestratorMode.options)('accepts mode=%s', (mode) => {
    expect(sourceRegistrationSchema.parse({ ...base, mode }).mode).toBe(mode);
  });

  it('accepts an omitted mode (older orchestrators)', () => {
    expect(sourceRegistrationSchema.parse(base).mode).toBeUndefined();
  });

  it('rejects an unknown mode', () => {
    expect(sourceRegistrationSchema.safeParse({ ...base, mode: 'nope' }).success).toBe(false);
  });

  it('classifies observed as Platform-connected but never a relay ingress target', () => {
    expect(PLATFORM_CONNECTED_MODES).toContain(OrchestratorMode.enum.observed);
    expect(RELAY_INGRESS_MODES).not.toContain(OrchestratorMode.enum.observed);
    expect(OWN_INGRESS_MODES).toContain(OrchestratorMode.enum.observed);
  });

  it('keeps independent off the Platform-connected set', () => {
    expect(PLATFORM_CONNECTED_MODES).not.toContain(OrchestratorMode.enum.independent);
  });
});
