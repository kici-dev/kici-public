import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * `containerRegistryAuth` carries a RESOLVED registry password. It rides on
 * `jobConfig` from the dispatch builder to the send site — which is how every
 * other resolved secret travels here — and must be lifted to a top-level
 * dispatch field and stripped from `jobConfig` before the message goes out.
 *
 * There are two independent send sites (the coordinator and the worker) with
 * two separately-maintained strip lists that already differ from each other,
 * so a field added to one and forgotten in the other is a live failure mode.
 * Asserting against the sources catches that without standing up a dispatch
 * harness on either path.
 */
const SRC = dirname(fileURLToPath(import.meta.url));

const SEND_SITES = [
  { label: 'coordinator', file: join(SRC, 'orchestrator-core.ts') },
  { label: 'worker', file: join(SRC, 'worker-core.ts') },
];

describe('containerRegistryAuth never reaches the agent inside jobConfig', () => {
  it.each(SEND_SITES)('$label strips it from jobConfig', ({ file }) => {
    const src = readFileSync(file, 'utf-8');
    // Positive control: if the strip block itself moved, this test is
    // asserting nothing and should fail rather than pass silently.
    expect(src).toContain("k !== 'npmRegistries'");
    expect(src).toContain("k !== 'containerRegistryAuth'");
  });

  it.each(SEND_SITES)('$label lifts it to a top-level dispatch field', ({ file }) => {
    const src = readFileSync(file, 'utf-8');
    expect(src).toContain('containerRegistryAuth: dispatchContainerRegistryAuth');
  });
});
