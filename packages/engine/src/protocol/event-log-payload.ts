/**
 * Constants for the chunked event-log payload streaming transport.
 *
 * The orchestrator slices the decompressed webhook body into 64 KiB chunks,
 * base64-encodes each, and emits a sequence of
 * `dashboard.event-log.payload.chunk` messages. Platform forwards each one to
 * the originating browser as `event-log.payload.chunk`. The dashboard hook
 * accumulates the chunks until `isLast=true` then JSON.parses the result.
 *
 * 64 KiB raw → ~85 KiB base64; with `permessage-deflate` negotiated on the
 * relay the on-wire footprint is similar to the previous "single inline
 * payload" path. The win is that Platform never holds the full body in
 * memory and the dashboard can render progress as bytes arrive.
 */
export const EVENT_LOG_PAYLOAD_CHUNK_BYTES = 64 * 1024;
