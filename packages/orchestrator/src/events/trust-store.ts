import { type Kysely } from 'kysely';
import picomatch from 'picomatch';
import type { Database } from '../db/types.js';

/**
 * Trust entry representing a cross-repo trust relationship.
 */
interface TrustEntry {
  id: string;
  sourceRepo: string;
  sourceRoutingKey: string;
  targetRepo: string;
  targetRoutingKey: string;
  allowedEvents: string[] | null;
  enabled: boolean;
}

/**
 * TrustStore enforces bidirectional trust for cross-repo event delivery.
 *
 * Same-repo events (same routing key) are always trusted without a DB lookup.
 * Cross-repo events require an explicit enabled row in the cross_repo_trust table.
 * Glob-based event filtering is supported via the allowed_events column.
 */
export class TrustStore {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Check whether event delivery from source to target is trusted.
   *
   * Same-routing-key events bypass the DB lookup entirely.
   * Cross-repo events require an enabled row with matching event name.
   */
  async isTrusted(
    sourceRepo: string,
    sourceRoutingKey: string,
    targetRepo: string,
    targetRoutingKey: string,
    eventName: string,
  ): Promise<boolean> {
    // Same-repo events are always trusted
    if (sourceRoutingKey === targetRoutingKey) {
      return true;
    }

    // Query cross_repo_trust for an enabled matching row
    const row = await this.db
      .selectFrom('cross_repo_trust')
      .select(['allowed_events'])
      .where('source_repo', '=', sourceRepo)
      .where('source_routing_key', '=', sourceRoutingKey)
      .where('target_repo', '=', targetRepo)
      .where('target_routing_key', '=', targetRoutingKey)
      .where('enabled', '=', true)
      .executeTakeFirst();

    if (!row) {
      return false;
    }

    // null allowed_events = all events allowed
    if (row.allowed_events === null) {
      return true;
    }

    // Parse allowed_events (stored as JSON array of glob patterns)
    const patterns: string[] =
      typeof row.allowed_events === 'string' ? JSON.parse(row.allowed_events) : row.allowed_events;

    if (!Array.isArray(patterns) || patterns.length === 0) {
      return true;
    }

    // Check if eventName matches any allowed glob pattern
    return patterns.some((pattern) => picomatch.isMatch(eventName, pattern));
  }

  /**
   * Add a trust relationship between source and target.
   * Uses ON CONFLICT DO NOTHING for idempotent inserts.
   * Returns the trust entry ID.
   */
  async addTrust(
    source: { repo: string; routingKey: string },
    target: { repo: string; routingKey: string },
    allowedEvents?: string[],
  ): Promise<string> {
    const result = await this.db
      .insertInto('cross_repo_trust')
      .values({
        source_repo: source.repo,
        source_routing_key: source.routingKey,
        target_repo: target.repo,
        target_routing_key: target.routingKey,
        allowed_events: allowedEvents ? JSON.stringify(allowedEvents) : null,
      })
      .onConflict((oc) =>
        oc
          .columns(['source_repo', 'source_routing_key', 'target_repo', 'target_routing_key'])
          .doNothing(),
      )
      .returning('id')
      .executeTakeFirst();

    if (result) {
      return result.id;
    }

    // Conflict: row already exists — return the existing ID
    const existing = await this.db
      .selectFrom('cross_repo_trust')
      .select('id')
      .where('source_repo', '=', source.repo)
      .where('source_routing_key', '=', source.routingKey)
      .where('target_repo', '=', target.repo)
      .where('target_routing_key', '=', target.routingKey)
      .executeTakeFirstOrThrow();

    return existing.id;
  }

  /**
   * Look up a single trust entry by ID. Returns null if the row is
   * missing. Callers (the admin HTTP route, in particular) use this
   * to read a row's source/target routing keys before applying a
   * scope check.
   */
  async getById(id: string): Promise<TrustEntry | null> {
    const row = await this.db
      .selectFrom('cross_repo_trust')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) return null;
    return {
      id: row.id,
      sourceRepo: row.source_repo,
      sourceRoutingKey: row.source_routing_key,
      targetRepo: row.target_repo,
      targetRoutingKey: row.target_routing_key,
      allowedEvents:
        row.allowed_events === null
          ? null
          : typeof row.allowed_events === 'string'
            ? JSON.parse(row.allowed_events)
            : row.allowed_events,
      enabled: row.enabled,
    };
  }

  /**
   * Remove a trust relationship by ID.
   */
  async removeTrust(id: string): Promise<void> {
    await this.db.deleteFrom('cross_repo_trust').where('id', '=', id).execute();
  }

  /**
   * List all trust relationships for a routing key (as source or target).
   */
  async listTrust(routingKey: string): Promise<TrustEntry[]> {
    const rows = await this.db
      .selectFrom('cross_repo_trust')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb('source_routing_key', '=', routingKey),
          eb('target_routing_key', '=', routingKey),
        ]),
      )
      .execute();

    return rows.map((row) => ({
      id: row.id,
      sourceRepo: row.source_repo,
      sourceRoutingKey: row.source_routing_key,
      targetRepo: row.target_repo,
      targetRoutingKey: row.target_routing_key,
      allowedEvents:
        row.allowed_events === null
          ? null
          : typeof row.allowed_events === 'string'
            ? JSON.parse(row.allowed_events)
            : row.allowed_events,
      enabled: row.enabled,
    }));
  }
}
