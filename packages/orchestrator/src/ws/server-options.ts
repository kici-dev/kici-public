import type { WebSocketServer } from 'ws';
import { WS_MAX_PAYLOAD_BYTES } from '@kici-dev/engine';

/**
 * Applies the security-relevant options to a `ws` `WebSocketServer` instance.
 *
 * Single source of truth for the orchestrator's agent-WS server config. Lives
 * here so it is unit-testable independently of the heavy `createApp` dependency
 * graph.
 *
 * The (`permessage-deflate` compression bombs) invariant lives here: any
 * field added to defend against compression-bomb DoS — `maxPayload`,
 * `serverNoContextTakeover`, etc. — MUST be set inside this helper so the
 * neighbouring test file can assert it.
 */
export function configureSecureWsServer(wss: WebSocketServer): void {
  //: cap maximum decompressed frame size so a fake/compromised agent
  // (A6) cannot OOM the orch with a compression bomb. Without this, ws@8.x
  // defaults to 100 MiB. See `WS_MAX_PAYLOAD_BYTES` doc-comment for sizing
  // rationale (matches `WEBHOOK_RELAY_MAX_BODY_BYTES`).
  wss.options.maxPayload = WS_MAX_PAYLOAD_BYTES;

  // @hono/node-ws creates `WebSocketServer({ noServer: true })` without
  // perMessageDeflate, but the ws library reads this.options.perMessageDeflate
  // during each handshake, so setting it before any connections arrive enables
  // compression for all clients.
  wss.options.perMessageDeflate = {
    concurrencyLimit: 10,
    threshold: 128, // Skip compressing tiny messages like heartbeats
    //: drop the deflate dictionary state between server-sent messages so
    // per-connection memory does not accumulate under sustained traffic.
    // Server-side only; leaving `clientNoContextTakeover` unset preserves
    // compression ratio on patterns with repeated client→server payload
    // shapes (e.g. log.chunk fan-out from many small frames).
    serverNoContextTakeover: true,
  };
}
