import { describe, it, expect } from 'vitest';
import { redactConfig, scrubText } from './diagnostics-redaction.js';

// Assembled from parts rather than written as a literal: a whole Slack token
// in the source trips GitHub push protection on the public mirror, which
// blocks the release publish. The sibling fixtures in the scrubText table build
// theirs the same way, with .repeat(). The runtime value is unchanged, so the
// redaction assertion still exercises a real-shaped token.
const SLACK_BOT_TOKEN = ['xoxb', '123456789012', '1234567890123', 'AbCdEfGhIjKlMnOpQrStUvWx'].join(
  '-',
);

describe('redactConfig', () => {
  it('redacts unknown string keys, keeps safe keys and numbers', () => {
    const out = redactConfig({
      host: 'h',
      token: 'secret',
      port: 5432,
      nested: { apiKey: 'k' },
    }) as Record<string, unknown>;
    expect(out.host).toBe('h');
    expect(out.token).toBe('****');
    expect(out.port).toBe(5432);
    expect((out.nested as Record<string, unknown>).apiKey).toBe('****');
  });
});

describe('scrubText', () => {
  // Each case is [label, a line carrying a live-shaped secret, the secret itself].
  // The secret is asserted absent from the output, which is the property that
  // matters — the bundle is uploaded to KiCI object storage.
  const SECRETS: ReadonlyArray<readonly [string, string, string]> = [
    [
      'AWS access key id',
      'creds loaded key=AKIAIOSFODNN7EXAMPLE region=eu-central-1',
      'AKIAIOSFODNN7EXAMPLE',
    ],
    [
      'GitHub personal access token',
      'clone failed for token ghp_0123456789abcdefghijklmnopqrstuvwxyz',
      'ghp_0123456789abcdefghijklmnopqrstuvwxyz',
    ],
    [
      'GitHub app installation token',
      'using ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 for install',
      'ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    ],
    [
      'JWT',
      'id token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    ],
    [
      'Authorization Bearer header',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
      'abcdefghijklmnopqrstuvwxyz012345',
    ],
    [
      'Authorization Basic header',
      'Authorization: Basic dXNlcjpzdXBlcnNlY3JldHBhc3N3b3Jk',
      'dXNlcjpzdXBlcnNlY3JldHBhc3N3b3Jk',
    ],
    [
      'KiCI agent token',
      `agent authenticated with kat_${'a1b2c3d4'.repeat(8)}`,
      `kat_${'a1b2c3d4'.repeat(8)}`,
    ],
    [
      'KiCI local-plane token',
      `plane token kici-local-${'f'.repeat(48)} accepted`,
      `kici-local-${'f'.repeat(48)}`,
    ],
    ['Slack bot token', `posting via ${SLACK_BOT_TOKEN}`, SLACK_BOT_TOKEN],
    [
      'password in a connection URL',
      'connecting to postgres://kici:sup3rs3cr3tp4ss@db.internal:5432/kici',
      'sup3rs3cr3tp4ss',
    ],
    [
      'presigned URL signature',
      'PUT https://s3.example.com/b/k?X-Amz-Signature=9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0&X-Amz-Expires=900',
      '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0',
    ],
    [
      'presigned URL credential',
      'signing with X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260820%2Feu%2Fs3%2Faws4_request next',
      'AKIAIOSFODNN7EXAMPLE',
    ],
    [
      'sops-encrypted value',
      'value ENC[AES256_GCM,data:Tr7oQ2VkZGVk,iv:aBcDeF12,tag:zZyYxX98,type:str] decrypted',
      'Tr7oQ2VkZGVk',
    ],
    [
      'assignment to a secret-named key',
      'starting worker with api_key=8f3c9d2e1a7b4c6d5e0f9a8b7c6d5e4f',
      '8f3c9d2e1a7b4c6d5e0f9a8b7c6d5e4f',
    ],
    [
      'quoted assignment to a secret-named key',
      'env KICI_AGENT_SECRET="q7Wt2ZpL9xR4vN8mK3sD6yB1cF5hJ0gA"',
      'q7Wt2ZpL9xR4vN8mK3sD6yB1cF5hJ0gA',
    ],
    // Credential families this repo actually mints. Each of these reached a
    // bundle byte-identical before they were added to the catalog.
    [
      'Platform API key',
      `auth failed for kici_sk_${'a1b2c3d4'.repeat(4)}`,
      `kici_sk_${'a1b2c3d4'.repeat(4)}`,
    ],
    [
      'Platform service-account key',
      `service account kici_sa_${'9f8e7d6c'.repeat(4)} rejected`,
      `kici_sa_${'9f8e7d6c'.repeat(4)}`,
    ],
    [
      'personal access token',
      `using kici_pat_${'0123abcd'.repeat(4)} for the request`,
      `kici_pat_${'0123abcd'.repeat(4)}`,
    ],
    [
      'cluster join token',
      `joining with kici_join_v1.eyJhIjoxfQ.${'f'.repeat(32)}`,
      `kici_join_v1.eyJhIjoxfQ.${'f'.repeat(32)}`,
    ],
    [
      'fine-grained GitHub token',
      `clone failed for github_pat_11ABCDEFG0${'aBcDeFgH'.repeat(4)}`,
      `github_pat_11ABCDEFG0${'aBcDeFgH'.repeat(4)}`,
    ],
    ['session cookie', 'Cookie: session=abcdef0123456789; theme=dark', 'session=abcdef0123456789'],
    // A real password contains punctuation. An allowlist value class missed
    // these entirely, or masked only the head and left a readable tail.
    [
      'password with punctuation',
      'connect failed: password=A!bcdefghijklmnop',
      'A!bcdefghijklmnop',
    ],
    [
      'password with an ampersand mid-value',
      'env DB_PASSWORD=Tr0ub4dor&3xyzzy',
      'Tr0ub4dor&3xyzzy',
    ],
    ['JSON-shaped secret value', '{"password": "p@ssw0rd-really-long"}', 'p@ssw0rd-really-long'],
  ];

  it.each(SECRETS)('masks a %s', (_label, line, secret) => {
    const out = scrubText(line);
    // Non-vacuity: the assertion below is only meaningful because the raw
    // input DOES contain the secret. A scrubber that returned '' would pass
    // the `not.toContain` on its own.
    expect(line).toContain(secret);
    expect(out).not.toContain(secret);
    expect(out).toContain('***REDACTED');
  });

  it('masks a PEM private key block spanning multiple lines', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj';
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n${body}\n-----END RSA PRIVATE KEY-----`;
    const out = scrubText(`loaded key:\n${pem}\ndone`);
    expect(pem).toContain(body);
    expect(out).not.toContain(body);
    expect(out).toContain('done');
  });

  it('keeps a last-4 breadcrumb on a long secret so a human can tell which one it was', () => {
    const out = scrubText('token ghp_0123456789abcdefghijklmnopqrstuvwxyz');
    expect(out).toContain('wxyz');
    expect(out).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyz');
  });

  it('masks a SHORT secret entirely — 4 trailing chars would be a meaningful fraction', () => {
    // 12-char value: a last-4 breadcrumb would disclose a third of it.
    const out = scrubText('password=abcd1234efgh');
    expect(out).not.toContain('abcd1234efgh');
    expect(out).not.toContain('efgh');
    expect(out).toContain('***REDACTED***');
  });

  // Over-redaction is a real failure mode: a scrubber that masks everything
  // destroys the diagnostic value the bundle exists to carry.
  const NEAR_MISSES: ReadonlyArray<readonly [string, string]> = [
    ['an ordinary run line', 'run 8f3c completed on agent linux-amd64 in 12ms'],
    ['a Prometheus metric name', 'kici_orchestrator_jobs_dispatched_total 42'],
    ['a git commit sha', 'checked out 0ce3a65d4f1b2c3d4e5f60718293a4b5c6d7e8f9'],
    [
      'a bare sha256 digest',
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    ],
    ['a plain URL with no credentials', 'GET https://api.kici.dev/v1/runs/8f3c?limit=50 200'],
    ['a version banner', 'kici-admin 0.1.27 (node v22.11.0, linux x64)'],
    [
      'an error with a stack frame',
      'Error: ENOENT at /srv/kici/packages/orchestrator/dist/server.js:1204:17',
    ],
    ['a bearer-looking word in prose', 'the bearer of this message is the orchestrator'],
    ['a short non-secret assignment', 'timeout=30 retries=3 mode=strict'],
    ['a base64-looking build id that is not a JWT', 'build id QUJDREVGR0hJSktMTU5PUA'],
  ];

  it.each(NEAR_MISSES)('does NOT over-redact %s', (_label, line) => {
    expect(scrubText(line)).toBe(line);
  });

  it('leaves text with no secrets byte-identical', () => {
    const line = 'run 8f3c completed on agent linux-amd64 in 12ms';
    expect(scrubText(line)).toBe(line);
  });

  it('masks every secret when several share one line', () => {
    const out = scrubText(
      'key=AKIAIOSFODNN7EXAMPLE and token ghp_0123456789abcdefghijklmnopqrstuvwxyz',
    );
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyz');
  });
});

describe('scrubText resource safety', () => {
  it('does not backtrack on an unterminated PEM header', () => {
    // A lazy `[\s\S]*?` body rescans to end-of-input at every unterminated
    // BEGIN marker — quadratic, and measured at seconds per megabyte. This
    // runs synchronously inside the orchestrator and agent, so it would wedge
    // the event loop on log content we do not fully control.
    const hostile = `-----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(2 * 1024 * 1024)}`;
    const started = Date.now();
    const out = scrubText(hostile);
    const elapsed = Date.now() - started;
    // Generous: the quadratic form took ~4.6s on 1.4 MB, so anything near
    // linear clears this by orders of magnitude.
    expect(elapsed).toBeLessThan(2000);
    // Nothing to mask — the block never terminates — so it passes through.
    expect(out).toContain('BEGIN RSA PRIVATE KEY');
  });

  it('still masks a terminated PEM block of realistic size', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj\n'.repeat(40);
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}-----END RSA PRIVATE KEY-----`;
    const out = scrubText(`before\n${pem}\nafter`);
    expect(out).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('masks an AWS access key id entirely — its prefix is public', () => {
    // AKIA is 4 public chars plus 16 of key material, so a last-4 breadcrumb
    // would disclose a quarter of the secret half.
    const out = scrubText('key=AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('MPLE');
  });

  it('does not let a header rule reach across a newline', () => {
    const out = scrubText('Authorization: Bearer abcdefghijklmnopqrst\nrunId=8f3c1d2e completed');
    expect(out).toContain('runId=8f3c1d2e completed');
  });
});

describe('scrubText over-redaction guards', () => {
  it('masks only the credential in a presigned URL, keeping the other params', () => {
    // This is the URL the issue-report feature itself mints, so destroying it
    // would blind exactly the diagnostics this bundle exists to carry.
    const url =
      'PUT https://s3.example.com/b/k?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
      '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260831%2Feu-central-1%2Fs3%2Faws4_request' +
      '&X-Amz-Date=20260831T000000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=content-length%3Bhost';
    const out = scrubText(url);

    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    // The surrounding request context survives.
    expect(out).toContain('X-Amz-Date=20260831T000000Z');
    expect(out).toContain('X-Amz-Expires=900');
    expect(out).toContain('X-Amz-SignedHeaders=content-length%3Bhost');
    expect(out).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
  });

  it('does not re-consume a mask a previous rule already placed', () => {
    const out = scrubText('a=1&password=hunter2secret&b=2');
    expect(out).not.toContain('hunter2secret');
    expect(out).toContain('b=2');
  });

  it('leaves prose mentioning a cookie alone', () => {
    const line = 'failed to parse cookie: unexpected token at position 12';
    expect(scrubText(line)).toBe(line);
  });

  it('masks the JSON cookie field a structured logger emits', () => {
    const line = '{"level":"warn","cookie":"session=abcdef0123456789","runId":"8f3c"}';
    const out = scrubText(line);
    expect(out).not.toContain('session=abcdef0123456789');
    expect(out).toContain('"runId":"8f3c"');
  });

  it('does not backtrack on a long JWT-prefixed run with no dot', () => {
    // Same quadratic shape the PEM body had: three unbounded runs over a long
    // stretch of matching characters that never satisfies the dots.
    const hostile = `eyJ${'A'.repeat(200 * 1024)}`;
    const started = Date.now();
    scrubText(hostile);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('still masks a real JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(scrubText(`token ${jwt}`)).not.toContain(jwt);
  });
});
