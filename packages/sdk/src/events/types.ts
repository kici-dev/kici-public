/**
 * Types for the event emission system.
 */

/**
 * Options for event emission via ctx.emit().
 */
export interface EventEmitOptions {
  /** Target specific repos for cross-repo event delivery. */
  target?: {
    repos?: string[];
  };
}
