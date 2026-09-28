/**
 * Subpath re-export for dashboard global-workflow settings protocol messages.
 *
 * Consumers import from `@kici-dev/engine/protocol/dashboard-global-workflows`.
 * This file is intentionally kept out of the engine barrel so it remains a
 * server-only surface: the barrel must stay browser-safe.
 */
export * from './messages/dashboard-global-workflows.js';
