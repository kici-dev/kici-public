import { describe, it, expect } from 'vitest';
import { WebSocketServer } from 'ws';
import { WS_MAX_PAYLOAD_BYTES } from '@kici-dev/engine';
import { configureSecureWsServer } from './server-options.js';

// ── `permessage-deflate` compression bombs (security invariant) ──
//
// Invariant (per the pentest catalog at
// every WS endpoint that negotiates `permessage-deflate` MUST cap the maximum
// decompressed message size via `maxPayload` (sized to `WS_MAX_PAYLOAD_BYTES`,
// 25 MiB) and MUST set `serverNoContextTakeover: true` so per-message
// dictionary state does not accumulate across messages.
//
// The orchestrator's agent-WS server is single-tenant data plane, so the
// blast radius here is narrower than the Platform branch — A6 (fake or
// compromised agent) DoSes its own orchestrator, not other tenants. Same
// fix shape, same helper.
//
// These tests assert the EXACT configured values so any regression that
// changes the cap or drops the flag is loud.
describe(' compression bomb defense — orchestrator agent-WS server (security invariant)', () => {
  it('caps maxPayload to bound decompressed frame size (= WS_MAX_PAYLOAD_BYTES)', () => {
    const wss = new WebSocketServer({ noServer: true });
    configureSecureWsServer(wss);

    expect(wss.options.maxPayload).toBe(WS_MAX_PAYLOAD_BYTES);
  });

  it('sets serverNoContextTakeover to drop dictionary state per message', () => {
    const wss = new WebSocketServer({ noServer: true });
    configureSecureWsServer(wss);

    const opts = wss.options.perMessageDeflate;
    expect(opts).toBeTruthy();
    expect(typeof opts).toBe('object');
    expect((opts as Record<string, unknown>).serverNoContextTakeover).toBe(true);
  });

  it('leaves clientNoContextTakeover unset to preserve compression on repeated payload shapes', () => {
    // Defense-in-depth pin: enabling clientNoContextTakeover would kill
    // compression for log.chunk fan-out (many small frames with repeated
    // structure). Future change to enable it must be accompanied by a
    // measurement of the compression-ratio impact.
    const wss = new WebSocketServer({ noServer: true });
    configureSecureWsServer(wss);

    const opts = wss.options.perMessageDeflate as Record<string, unknown>;
    expect(opts.clientNoContextTakeover).toBeUndefined();
  });
});
