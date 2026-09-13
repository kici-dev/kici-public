import { describe, it, expect } from 'vitest';
import {
  manifestCreateUrl,
  renderManifestFormHtml,
  renderCodeDisplayHtml,
} from './manifest-form.js';

describe('manifest form', () => {
  it('targets personal vs org create endpoints', () => {
    expect(manifestCreateUrl()).toBe('https://github.com/settings/apps/new');
    expect(manifestCreateUrl('acme')).toBe(
      'https://github.com/organizations/acme/settings/apps/new',
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
