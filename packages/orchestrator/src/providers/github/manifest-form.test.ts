import { describe, it, expect } from 'vitest';
import { DEFAULT_GITHUB_URL } from './github-host.js';
import {
  manifestCreateUrl,
  renderManifestFormHtml,
  renderCodeDisplayHtml,
} from './manifest-form.js';

describe('manifest form', () => {
  it('targets personal vs org create endpoints', () => {
    // breaks-if-wrong: github.com operators keep today's URL
    expect(manifestCreateUrl()).toBe('https://github.com/settings/apps/new');
    expect(manifestCreateUrl('acme')).toBe(
      'https://github.com/organizations/acme/settings/apps/new',
    );
    expect(manifestCreateUrl(undefined, DEFAULT_GITHUB_URL)).toBe(
      'https://github.com/settings/apps/new',
    );
  });

  it('targets a GitHub Enterprise Server host', () => {
    // fails-when: --github-url stops reaching the create URL
    expect(manifestCreateUrl(undefined, 'https://ghe.corp.example')).toBe(
      'https://ghe.corp.example/settings/apps/new',
    );
    expect(manifestCreateUrl('acme', 'https://ghe.corp.example')).toBe(
      'https://ghe.corp.example/organizations/acme/settings/apps/new',
    );
  });

  it('renders an auto-submitting form carrying the manifest + state', () => {
    const html = renderManifestFormHtml({
      createUrl: 'https://github.com/settings/apps/new',
      state: 'st8',
      manifestJson: '{"name":"x"}',
    });
    expect(html).toContain('action="https://github.com/settings/apps/new?state=st8"');
    expect(html).toContain('name="manifest"');
    expect(html).toContain('{&quot;name&quot;:&quot;x&quot;}'); // HTML-escaped
    expect(html).toContain('.submit()');
  });

  it('escapes the create url to prevent attribute-injection', () => {
    const html = renderManifestFormHtml({
      createUrl: 'https://github.com/settings/apps/new',
      state: 'a"><script>x',
      manifestJson: '{}',
    });
    expect(html).not.toContain('"><script>');
  });

  it('renders the code-display page with the code', () => {
    expect(renderCodeDisplayHtml('abc123')).toContain('abc123');
  });

  it('escapes the code in the display page', () => {
    expect(renderCodeDisplayHtml('<img src=x>')).not.toContain('<img src=x>');
  });
});
