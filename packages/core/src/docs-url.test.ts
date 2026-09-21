import { describe, it, expect } from 'vitest';
import { DOCS_SITE_URL, docsUrl } from './docs-url.js';

describe('docsUrl', () => {
  it('is rooted on the docs host, not the marketing apex', () => {
    // fails-when: the constant regresses to the marketing apex (kici.dev) — every
    // /docs/* path there serves the SPA shell and 404s client-side.
    expect(DOCS_SITE_URL).toBe('https://docs.kici.dev');
    expect(docsUrl('')).toBe('https://docs.kici.dev/');
  });

  it('normalises a page path to the canonical trailing-slash form', () => {
    expect(docsUrl('user/quickstart')).toBe('https://docs.kici.dev/user/quickstart/');
    expect(docsUrl('/user/quickstart/')).toBe('https://docs.kici.dev/user/quickstart/');
  });

  it('keeps a fragment or query after the page slash', () => {
    // fails-when: the slash is appended after the fragment — `…#part-1/` names
    // no heading, and the docs site treats it as an unknown anchor.
    expect(docsUrl('user/quickstart#part-1')).toBe('https://docs.kici.dev/user/quickstart/#part-1');
    expect(docsUrl('user/quickstart/?v=1')).toBe('https://docs.kici.dev/user/quickstart/?v=1');
  });

  it('leaves a file path without a trailing slash', () => {
    // breaks-if-wrong: llms.txt must stay a file URL a fetch can read.
    expect(docsUrl('llms.txt')).toBe('https://docs.kici.dev/llms.txt');
  });
});
