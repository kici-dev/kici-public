import { AsyncLocalStorage } from 'node:async_hooks';

/** Trace context fields propagated through the request lifecycle. */
export interface RequestContext {
  /** Unique trace ID for a webhook event (UUIDv4). Always present once set. */
  requestId: string;
  /** Workflow run ID, set when a workflow run is created. */
  runId?: string;
  /** Job ID, set when processing a specific job. */
  jobId?: string;
  /** Routing key (e.g. "github:12345"), set when handling a webhook for a source. */
  routingKey?: string;
  /** OTel trace ID, set when telemetry is active. */
  traceId?: string;
  /** OTel span ID, set when telemetry is active. */
  spanId?: string;
}

/**
 * Propagates request context through async call chains.
 *
 * ```ts
 * requestContext.run({ requestId: crypto.randomUUID() }, async () => {
 *   // All code in this callback (and its async descendants) can read the context
 *   log.info('Processing webhook'); // auto-enriched with requestId
 * });
 * ```
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

/** The current request context, or `{}` outside a `run()` scope. Never throws. */
export function getRequestContext(): Partial<RequestContext> {
  return requestContext.getStore() ?? {};
}

/** Merge fields into the current request context; no-op outside a `run()` scope. */
export function enrichRequestContext(fields: Partial<RequestContext>): void {
  const store = requestContext.getStore();
  if (store) {
    Object.assign(store, fields);
  }
}
