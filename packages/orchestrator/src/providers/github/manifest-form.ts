/**
 * GitHub's create-from-manifest flow is an HTML form POST (the `manifest`
 * JSON cannot ride in a query string). These helpers render the auto-submitting
 * form and the headless code-display page. Pure string builders — no IO — so
 * both the CLI loopback server and the static marketing-site page can reuse the
 * same shapes.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function manifestCreateUrl(githubOrg?: string): string {
  return githubOrg
    ? `https://github.com/organizations/${githubOrg}/settings/apps/new`
    : 'https://github.com/settings/apps/new';
}

export function renderManifestFormHtml(opts: {
  createUrl: string;
  state: string;
  manifestJson: string;
}): string {
  const action = `${opts.createUrl}?state=${encodeURIComponent(opts.state)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Create your KiCI GitHub App</title></head>
<body>
<p>Redirecting you to GitHub to create your KiCI GitHub App…</p>
<form id="f" method="post" action="${escapeHtml(action)}">
  <input type="hidden" name="manifest" value="${escapeHtml(opts.manifestJson)}">
  <noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<script>document.getElementById('f').submit();</script>
</body></html>`;
}

export function renderCodeDisplayHtml(code: string): string {
  const safe = escapeHtml(code);
  return `<!doctype html><html><head><meta charset="utf-8"><title>KiCI — copy your setup code</title></head>
<body>
<p>App created. Copy this code back into the <code>kici-admin</code> prompt:</p>
<pre id="c" style="font-size:1.2rem;padding:12px;border:1px solid #ccc">${safe}</pre>
<button onclick="navigator.clipboard.writeText(document.getElementById('c').textContent)">Copy</button>
</body></html>`;
}
