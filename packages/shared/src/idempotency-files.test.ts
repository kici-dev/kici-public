import { describe, expect, it } from 'vitest';
import {
  type FileDriftEntry,
  parseItemizeLine,
  renderFileDriftBody,
  renderFileDriftWithDiff,
  renderFileDrifts,
  resolveDiffMode,
} from './idempotency-files.js';

describe('parseItemizeLine', () => {
  it('parses a newly-created file (push)', () => {
    const rec = parseItemizeLine('<f+++++++++ subdir/new.txt');
    expect(rec).toEqual({
      itemizeCode: '<f+++++++++',
      relativePath: 'subdir/new.txt',
      category: 'new',
    });
  });

  it('parses a newly-created file (local create)', () => {
    const rec = parseItemizeLine('cf+++++++++ a.txt');
    expect(rec?.category).toBe('new');
  });

  it('categorises a size mismatch as content', () => {
    const rec = parseItemizeLine('<f.s....... larger.txt');
    expect(rec?.category).toBe('content');
  });

  it('categorises a checksum mismatch as content', () => {
    const rec = parseItemizeLine('<fc........ same-size.txt');
    expect(rec?.category).toBe('content');
  });

  it('categorises a checksum + size + time mismatch as content', () => {
    const rec = parseItemizeLine('<fcst...... changed.txt');
    expect(rec?.category).toBe('content');
  });

  it('categorises a perm-only diff as mode', () => {
    const rec = parseItemizeLine('.f...p..... script.sh');
    expect(rec?.category).toBe('mode');
  });

  it('categorises an owner-only diff as mode', () => {
    const rec = parseItemizeLine('.f....o.... owned.txt');
    expect(rec?.category).toBe('mode');
  });

  it('categorises a group-only diff as mode', () => {
    const rec = parseItemizeLine('.f.....g... grouped.txt');
    expect(rec?.category).toBe('mode');
  });

  it('categorises a time-only diff as time-only', () => {
    const rec = parseItemizeLine('<f..t...... touched.txt');
    expect(rec?.category).toBe('time-only');
  });

  it('skips directory entries', () => {
    expect(parseItemizeLine('.d..t...... subdir/')).toBeNull();
    expect(parseItemizeLine('cd+++++++++ newdir/')).toBeNull();
  });

  it('skips deletion / message lines', () => {
    expect(parseItemizeLine('*deleting   gone.txt')).toBeNull();
  });

  it('skips header / summary / blank lines', () => {
    expect(parseItemizeLine('sending incremental file list')).toBeNull();
    expect(parseItemizeLine('')).toBeNull();
    expect(parseItemizeLine('   ')).toBeNull();
    expect(parseItemizeLine('sent 123 bytes  received 45 bytes  168.00 bytes/sec')).toBeNull();
    expect(parseItemizeLine('total size is 0  speedup is 0.00 (DRY RUN)')).toBeNull();
  });

  it('preserves multi-segment relative paths verbatim', () => {
    const rec = parseItemizeLine('<f+++++++++ a/b/c/d.json');
    expect(rec?.relativePath).toBe('a/b/c/d.json');
  });

  it('rejects lines without a space after the 11-char code', () => {
    expect(parseItemizeLine('<f+++++++++path-no-space')).toBeNull();
  });

  it('rejects malformed Y or X positions', () => {
    expect(parseItemizeLine('Zf+++++++++ x.txt')).toBeNull();
    expect(parseItemizeLine('<x+++++++++ x.txt')).toBeNull();
  });
});

describe('renderFileDrifts', () => {
  function entry(category: FileDriftEntry['category'], localPath: string): FileDriftEntry {
    return { localPath, remotePath: '/remote/' + localPath, category, itemizeCode: '<f.s.......' };
  }

  it('returns no lines for an empty input', () => {
    expect(renderFileDrifts([])).toEqual([]);
  });

  it('renders the summary header + aligned category column', () => {
    const lines = renderFileDrifts([
      entry('content', 'haproxy.cfg'),
      entry('new', 'placeholder.html'),
      entry('mode', 'scripts/certbot-pre-stop.sh'),
    ]);
    expect(lines[0]).toBe('3 file(s) drifted: 1 new, 1 content, 1 mode');
    expect(lines).toHaveLength(4);
    // Path column starts at the same byte offset on every line — that's how
    // the category column gets visually aligned regardless of label length.
    const pathOffsets = lines.slice(1).map((l) => l.search(/\S+$/));
    expect(new Set(pathOffsets).size).toBe(1);
  });

  it('orders entries by category (new, content, mode, time-only) then path', () => {
    const lines = renderFileDrifts([
      entry('time-only', 'z.txt'),
      entry('content', 'b.txt'),
      entry('new', 'a.txt'),
      entry('content', 'a-content.txt'),
    ]);
    const paths = lines.slice(1).map((l) => l.trim().split(/\s{2,}/)[1]);
    expect(paths).toEqual(['a.txt', 'a-content.txt', 'b.txt', 'z.txt']);
  });

  it('counts categories in the summary header', () => {
    const lines = renderFileDrifts([entry('new', 'a'), entry('new', 'b'), entry('content', 'c')]);
    expect(lines[0]).toBe('3 file(s) drifted: 2 new, 1 content');
  });

  it('omits empty categories from the summary header', () => {
    const lines = renderFileDrifts([entry('new', 'a'), entry('new', 'b')]);
    expect(lines[0]).toBe('2 file(s) drifted: 2 new');
  });
});

describe('renderFileDriftWithDiff', () => {
  it('renders a unified diff for a CONTENT entry', () => {
    const entry: FileDriftEntry = {
      localPath: 'haproxy.cfg',
      remotePath: '/etc/haproxy/haproxy.cfg',
      category: 'content',
      itemizeCode: '<fcst......',
      remoteContent: 'frontend http\n  bind *:80\n  default_backend app\n',
      localContent: 'frontend http\n  bind *:80\n  default_backend app_v2\n',
    };
    const lines = renderFileDriftWithDiff(entry);
    expect(lines[0]).toBe('--- a/haproxy.cfg');
    expect(lines[1]).toBe('+++ b/haproxy.cfg');
    expect(lines.join('\n')).toContain('-  default_backend app');
    expect(lines.join('\n')).toContain('+  default_backend app_v2');
  });

  it('renders a NEW entry with all lines as additions', () => {
    const entry: FileDriftEntry = {
      localPath: 'new.cfg',
      remotePath: '/etc/new.cfg',
      category: 'new',
      itemizeCode: '<f+++++++++',
      localContent: 'alpha\nbeta\n',
    };
    const lines = renderFileDriftWithDiff(entry);
    const body = lines.join('\n');
    expect(body).toContain('+++ b/new.cfg');
    expect(body).toContain('+alpha');
    expect(body).toContain('+beta');
    // No `-` lines in the diff body (the leading `---` is the header, not a
    // removal). Allow `--- a/...` but no `-foo` content removals.
    const removalLines = lines.filter((l) => /^-[^-]/.test(l));
    expect(removalLines).toEqual([]);
  });

  it('returns empty array for a MODE entry', () => {
    const entry: FileDriftEntry = {
      localPath: 'script.sh',
      remotePath: '/usr/local/bin/script.sh',
      category: 'mode',
      itemizeCode: '.f...p.....',
    };
    expect(renderFileDriftWithDiff(entry)).toEqual([]);
  });

  it('returns empty array for a TIME-ONLY entry', () => {
    const entry: FileDriftEntry = {
      localPath: 'touched.txt',
      remotePath: '/etc/touched.txt',
      category: 'time-only',
      itemizeCode: '<f..t......',
    };
    expect(renderFileDriftWithDiff(entry)).toEqual([]);
  });

  it('explains a binary skip', () => {
    const entry: FileDriftEntry = {
      localPath: 'image.png',
      remotePath: '/srv/image.png',
      category: 'content',
      itemizeCode: '<fcst......',
      contentSkipped: 'binary',
    };
    expect(renderFileDriftWithDiff(entry)).toEqual(['(binary file changed — no inline diff)']);
  });

  it('explains a too-large skip', () => {
    const entry: FileDriftEntry = {
      localPath: 'big.json',
      remotePath: '/srv/big.json',
      category: 'content',
      itemizeCode: '<fcst......',
      contentSkipped: 'too-large',
    };
    expect(renderFileDriftWithDiff(entry)).toEqual(['(file too large for inline diff)']);
  });

  it('colors +/- lines when color=true', () => {
    const entry: FileDriftEntry = {
      localPath: 'a.txt',
      remotePath: '/a.txt',
      category: 'content',
      itemizeCode: '<fcst......',
      remoteContent: 'one\n',
      localContent: 'two\n',
    };
    const lines = renderFileDriftWithDiff(entry, { color: true });
    // ANSI escape sequences for red/green should appear on the +/- bodies.
    const body = lines.join('\n');
    // Match an ANSI escape sequence introducer. Looking for at least one.
    expect(/\x1b\[/.test(body)).toBe(true);
  });

  it('truncates body beyond maxLines', () => {
    const localContent = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const remoteContent = Array.from({ length: 50 }, (_, i) => `LINE ${i}`).join('\n') + '\n';
    const entry: FileDriftEntry = {
      localPath: 'big.txt',
      remotePath: '/big.txt',
      category: 'content',
      itemizeCode: '<fcst......',
      remoteContent,
      localContent,
    };
    const lines = renderFileDriftWithDiff(entry, { maxLines: 5 });
    expect(lines[lines.length - 1]).toMatch(/more lines truncated/);
  });
});

describe('renderFileDrifts with withContent', () => {
  it('appends diff blocks under each CONTENT/NEW entry', () => {
    const entries: FileDriftEntry[] = [
      {
        localPath: 'a.cfg',
        remotePath: '/etc/a.cfg',
        category: 'content',
        itemizeCode: '<fcst......',
        remoteContent: 'old\n',
        localContent: 'new\n',
      },
      {
        localPath: 'b.sh',
        remotePath: '/usr/b.sh',
        category: 'mode',
        itemizeCode: '.f...p.....',
      },
    ];
    const lines = renderFileDrifts(entries, { withContent: true });
    const body = lines.join('\n');
    expect(body).toContain('-old');
    expect(body).toContain('+new');
    // The MODE entry contributes no diff lines.
    expect(body).not.toMatch(/\+.*b\.sh/);
  });

  it('shows skip-reason rows for binary/too-large', () => {
    const entries: FileDriftEntry[] = [
      {
        localPath: 'img.png',
        remotePath: '/srv/img.png',
        category: 'content',
        itemizeCode: '<fcst......',
        contentSkipped: 'binary',
      },
    ];
    const lines = renderFileDrifts(entries, { withContent: true });
    expect(lines.some((l) => l.includes('(binary file changed'))).toBe(true);
  });

  it('is backward-compatible when withContent is false', () => {
    const entry: FileDriftEntry = {
      localPath: 'a.cfg',
      remotePath: '/etc/a.cfg',
      category: 'content',
      itemizeCode: '<fcst......',
      remoteContent: 'old\n',
      localContent: 'new\n',
    };
    const lines = renderFileDrifts([entry]);
    // No diff body when withContent is omitted; only the header + one row.
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('  CONTENT  a.cfg');
  });
});

describe('resolveDiffMode', () => {
  function makeEntry(remotePath: string, diffMode?: FileDriftEntry['diffMode']): FileDriftEntry {
    return {
      localPath: 'x',
      remotePath,
      category: 'content',
      itemizeCode: '<fcst......',
      diffMode,
    };
  }

  it('auto-detects env-semantic for .env paths', () => {
    expect(resolveDiffMode(makeEntry('/etc/kici/patroni.env'))).toBe('env-semantic');
  });

  it('auto-detects yaml-semantic for .yaml paths', () => {
    expect(resolveDiffMode(makeEntry('/etc/kici/keycloak-config.yaml'))).toBe('yaml-semantic');
  });

  it('auto-detects yaml-semantic for .yml paths', () => {
    expect(resolveDiffMode(makeEntry('/etc/kici/something.yml'))).toBe('yaml-semantic');
  });

  it('is case-insensitive on the suffix', () => {
    expect(resolveDiffMode(makeEntry('/etc/FOO.ENV'))).toBe('env-semantic');
    expect(resolveDiffMode(makeEntry('/etc/Foo.Yaml'))).toBe('yaml-semantic');
  });

  it('defaults to unified-text for other extensions', () => {
    expect(resolveDiffMode(makeEntry('/etc/kici/haproxy.cfg'))).toBe('unified-text');
    expect(resolveDiffMode(makeEntry('/etc/kici/login-policy.json'))).toBe('unified-text');
    expect(resolveDiffMode(makeEntry('/usr/local/bin/script.sh'))).toBe('unified-text');
  });

  it('honors an explicit diffMode override regardless of suffix', () => {
    expect(resolveDiffMode(makeEntry('/etc/kici/patroni.env', 'unified-text'))).toBe(
      'unified-text',
    );
    expect(resolveDiffMode(makeEntry('/etc/kici/foo.cfg', 'env-semantic'))).toBe('env-semantic');
    expect(resolveDiffMode(makeEntry('/etc/kici/foo.cfg', 'suppressed'))).toBe('suppressed');
  });
});

describe('renderFileDriftBody (dispatch)', () => {
  it('dispatches env-semantic for .env remote path', () => {
    const entry: FileDriftEntry = {
      localPath: '<generated>/patroni.env',
      remotePath: '/etc/kici/patroni.env',
      category: 'content',
      itemizeCode: '<fcst......',
      remoteContent: 'KICI_PROD_DB_PASSWORD=hunter2\nKICI_OTHER=stable\n',
      localContent: 'KICI_PROD_DB_PASSWORD=tr0ub4dor\nKICI_OTHER=stable\n',
    };
    const lines = renderFileDriftBody(entry);
    const body = lines.join('\n');
    expect(body).toContain('KICI_PROD_DB_PASSWORD: changed');
    expect(body).toContain('1 other key(s) unchanged');
    // Masking invariant: no plaintext value appears in the default render.
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('tr0ub4dor');
  });

  it('reveals env values when revealEnvValues=true', () => {
    const entry: FileDriftEntry = {
      localPath: '<generated>/patroni.env',
      remotePath: '/etc/kici/patroni.env',
      category: 'content',
      itemizeCode: '<fcst......',
      remoteContent: 'KICI_PROD_DB_PASSWORD=hunter2\n',
      localContent: 'KICI_PROD_DB_PASSWORD=tr0ub4dor\n',
    };
    const lines = renderFileDriftBody(entry, { revealEnvValues: true });
    const body = lines.join('\n');
    expect(body).toContain('hunter2');
    expect(body).toContain('tr0ub4dor');
  });

  it('falls back to unified-text for non-special suffixes', () => {
    const entry: FileDriftEntry = {
      localPath: 'haproxy.cfg',
      remotePath: '/etc/haproxy/haproxy.cfg',
      category: 'content',
      itemizeCode: '<fcst......',
      remoteContent: 'foo\nbar\n',
      localContent: 'foo\nBAR\n',
    };
    const lines = renderFileDriftBody(entry);
    const body = lines.join('\n');
    expect(body).toContain('--- a/haproxy.cfg');
    expect(body).toContain('-bar');
    expect(body).toContain('+BAR');
  });

  it('returns the skip-reason marker for suppressed entries', () => {
    const entry: FileDriftEntry = {
      localPath: 'secret.env',
      remotePath: '/etc/secret.env',
      category: 'content',
      itemizeCode: '<fcst......',
      diffMode: 'suppressed',
    };
    expect(renderFileDriftBody(entry)).toEqual(['(sensitive content — diff suppressed)']);
  });

  it('honors contentSkipped over diffMode for env-semantic entries', () => {
    const entry: FileDriftEntry = {
      localPath: 'a.env',
      remotePath: '/etc/a.env',
      category: 'content',
      itemizeCode: '<fcst......',
      contentSkipped: 'binary',
    };
    expect(renderFileDriftBody(entry)).toEqual(['(binary file changed — no inline diff)']);
  });
});

describe('renderFileDriftBody (yaml-semantic dispatch)', () => {
  // Side-effect import: registers the yaml renderer via
  // `setYamlDiffRenderer` so the dispatch in `renderFileDriftBody`
  // routes `.yaml` entries through the dotted-path semantic renderer.
  // The same wire-up happens in `deploy-prod/render.ts` in production;
  // the test imports it explicitly.

  it('routes a .yaml entry through the yaml-semantic renderer (non-sensitive)', async () => {
    await import('./idempotency-yaml-diff.js');
    const entry: FileDriftEntry = {
      localPath: '<generated>/spilo-extra.yaml',
      remotePath: '/etc/kici/patroni/spilo-extra.yaml',
      category: 'content',
      itemizeCode: '<fcst......',
      remoteContent: 'server:\n  port: 80\n',
      localContent: 'server:\n  port: 8080\n',
    };
    const lines = renderFileDriftBody(entry);
    const body = lines.join('\n');
    expect(body).toContain('server.port: changed');
    // Non-sensitive path → values shown.
    expect(body).toContain('- old=80');
    expect(body).toContain('+ new=8080');
  });

  it('masks sensitive yaml paths by default', async () => {
    await import('./idempotency-yaml-diff.js');
    const entry: FileDriftEntry = {
      localPath: '<generated>/config.yaml',
      remotePath: '/etc/kici/config.yaml',
      category: 'content',
      itemizeCode: '<fcst......',
      remoteContent: 'db:\n  password: hunter2\n',
      localContent: 'db:\n  password: tr0ub4dor\n',
    };
    const lines = renderFileDriftBody(entry);
    const body = lines.join('\n');
    expect(body).toContain('db.password: changed');
    expect(body).toContain('masked');
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('tr0ub4dor');
  });

  it('reveals sensitive yaml paths when revealEnvValues=true', async () => {
    await import('./idempotency-yaml-diff.js');
    const entry: FileDriftEntry = {
      localPath: '<generated>/config.yaml',
      remotePath: '/etc/kici/config.yaml',
      category: 'content',
      itemizeCode: '<fcst......',
      remoteContent: 'db:\n  password: hunter2\n',
      localContent: 'db:\n  password: tr0ub4dor\n',
    };
    const lines = renderFileDriftBody(entry, { revealEnvValues: true });
    const body = lines.join('\n');
    expect(body).toContain('hunter2');
    expect(body).toContain('tr0ub4dor');
  });
});

describe('renderFileDrifts (env-semantic dispatch + filter flags)', () => {
  it('routes a .env entry through the env-semantic renderer (masked default)', () => {
    const entries: FileDriftEntry[] = [
      {
        localPath: '<generated>/patroni.env',
        remotePath: '/etc/kici/patroni.env',
        category: 'content',
        itemizeCode: '<fcst......',
        remoteContent: 'KICI_PROD_DB_PASSWORD=hunter2\nKICI_OTHER=stable\n',
        localContent: 'KICI_PROD_DB_PASSWORD=tr0ub4dor\nKICI_OTHER=stable\n',
      },
    ];
    const lines = renderFileDrifts(entries, { withContent: true });
    const body = lines.join('\n');
    expect(body).toContain('KICI_PROD_DB_PASSWORD: changed');
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('tr0ub4dor');
  });

  it('skips diff body for categories outside diffOnlyCategories', () => {
    const entries: FileDriftEntry[] = [
      {
        localPath: 'a.cfg',
        remotePath: '/etc/a.cfg',
        category: 'new',
        itemizeCode: '<f+++++++++',
        localContent: 'alpha\nbeta\n',
      },
      {
        localPath: 'b.cfg',
        remotePath: '/etc/b.cfg',
        category: 'content',
        itemizeCode: '<fcst......',
        remoteContent: 'old\n',
        localContent: 'new\n',
      },
    ];
    const lines = renderFileDrifts(entries, {
      withContent: true,
      diffOnlyCategories: ['content'],
    });
    const body = lines.join('\n');
    // The 'content' entry's diff body renders.
    expect(body).toContain('-old');
    expect(body).toContain('+new');
    // The 'new' entry's diff body does NOT render — only its per-file row.
    expect(body).not.toContain('+alpha');
    expect(body).not.toContain('+beta');
  });
});
