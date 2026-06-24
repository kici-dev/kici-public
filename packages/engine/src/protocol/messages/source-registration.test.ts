import { describe, it, expect } from 'vitest';
import { sourceRegistrationSchema, SourceSubtype } from './source-registration.js';

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
