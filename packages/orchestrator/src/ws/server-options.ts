import type { WebSocketServer } from 'ws';
import { WS_MAX_PAYLOAD_BYTES } from '@kici-dev/engine';

/**
 * Single source of truth for the orchestrator's agent-WS server security
 * options, kept outside the `createApp` graph so it is unit-testable.
 *
 * Compression-bomb invariant: any field that defends against compression-bomb
 * DoS (`maxPayload`, `serverNoContextTakeover`, …) MUST be set inside this
 * helper so the neighbouring test file can assert it.
 */
export function configureSecureWsServer(wss: WebSocketServer): void {
  // Caps the decompressed frame size so a compromised agent cannot OOM the
  // orch with a compression bomb; ws@8.x defaults to 100 MiB. Sizing
  // rationale: the `WS_MAX_PAYLOAD_BYTES` doc-comment.
  wss.options.maxPayload = WS_MAX_PAYLOAD_BYTES;

  // Set before any connection arrives (`noServer: true`); ws reads
  // options.perMessageDeflate during each handshake.
  wss.options.perMessageDeflate = {
    concurrencyLimit: 10,
    threshold: 128, // Skip compressing tiny messages like heartbeats
    // Drops server-side dictionary state between messages so per-connection
    // memory does not grow. `clientNoContextTakeover` stays unset to keep the
    // ratio on repeated client→server shapes (e.g. many small log.chunk frames).
    serverNoContextTakeover: true,
  };
}
