/**
 * Postgres-backed Raft state persistence.
 *
 * Stores the minimal Raft persistent state (currentTerm, votedFor, leaderId)
 * in the raft_state table. One row per cluster (default cluster_id = 'default').
 * State is loaded on node startup and saved on term/vote/leader transitions.
 */

import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

export interface RaftPersistentState {
  currentTerm: number;
  votedFor: string | null;
  leaderId: string | null;
}

export class RaftStateStore {
  private readonly db: Kysely<Database>;
  private readonly clusterId: string;

  constructor(deps: { db: Kysely<Database>; clusterId?: string }) {
    this.db = deps.db;
    this.clusterId = deps.clusterId ?? 'default';
  }

  /**
   * Load persisted Raft state from the DB.
   * Returns defaults (term=0, votedFor=null, leaderId=null) if no row exists.
   */
  async load(): Promise<RaftPersistentState> {
    const row = await this.db
      .selectFrom('raft_state')
      .select(['current_term', 'voted_for', 'leader_id'])
      .where('cluster_id', '=', this.clusterId)
      .executeTakeFirst();

    if (!row) {
      return { currentTerm: 0, votedFor: null, leaderId: null };
    }

    return {
      currentTerm: row.current_term,
      votedFor: row.voted_for,
      leaderId: row.leader_id,
    };
  }

  /**
   * Upsert full Raft state into the DB.
   */
  async save(state: RaftPersistentState): Promise<void> {
    await this.db
      .insertInto('raft_state')
      .values({
        cluster_id: this.clusterId,
        current_term: state.currentTerm,
        voted_for: state.votedFor,
        leader_id: state.leaderId,
      })
      .onConflict((oc) =>
        oc.column('cluster_id').doUpdateSet({
          current_term: state.currentTerm,
          voted_for: state.votedFor,
          leader_id: state.leaderId,
        }),
      )
      .execute();
  }

  /**
   * Update just the leader and term fields (lightweight update for heartbeat acceptance).
   */
  async updateLeader(leaderId: string, term: number): Promise<void> {
    await this.db
      .insertInto('raft_state')
      .values({
        cluster_id: this.clusterId,
        current_term: term,
        voted_for: null,
        leader_id: leaderId,
      })
      .onConflict((oc) =>
        oc.column('cluster_id').doUpdateSet({
          current_term: term,
          leader_id: leaderId,
        }),
      )
      .execute();
  }
}
