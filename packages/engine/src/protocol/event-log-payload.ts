/**
 * Constants for the chunked event-log payload streaming transport.
 *
 * The orchestrator slices the decompressed webhook body into base64-encoded
 * `dashboard.event-log.payload.chunk` messages; the Platform forwards each to
 * the originating browser as `event-log.payload.chunk`, and the dashboard
 * accumulates them until `isLast=true`, then JSON.parses the result.
 *
 * 64 KiB raw → ~85 KiB base64; with `permessage-deflate` on the relay the
 * on-wire footprint stays close to one inline payload. The Platform never
 * holds the full body in memory, and the dashboard renders progress as bytes
 * arrive.
 */
export const EVENT_LOG_PAYLOAD_CHUNK_BYTES = 64 * 1024;
