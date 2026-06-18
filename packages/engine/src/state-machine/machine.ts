import type { ExecutionState, ExecutionEvent } from './types.js';
import { TERMINAL_STATES } from './types.js';

/**
 * Runtime transition table mapping each state to its valid event->nextState pairs.
 * Terminal states have no entries (empty objects).
 */
const TRANSITIONS: Record<ExecutionState, Partial<Record<ExecutionEvent, ExecutionState>>> = {
  pending: {
    ENQUEUE: 'queued',
    CANCEL: 'cancelled',
    SKIP: 'skipped',
    HOLD: 'held',
    WAIT: 'waiting',
  },
  queued: {
    START: 'running',
    FAIL: 'failed',
    CANCEL: 'cancelled',
  },
  running: {
    SUCCEED: 'success',
    FAIL: 'failed',
    CANCEL: 'cancelled',
    CANCEL_GRACEFUL: 'cancelling',
    RECOVER: 'recovering',
  },
  recovering: {
    START: 'running',
    FAIL: 'failed',
    CANCEL: 'cancelled',
  },
  cancelling: {
    CANCEL_FORCE: 'cancelled',
    COMPLETE: 'cancelled',
    FAIL: 'failed',
  },
  held: {
    APPROVE: 'queued',
    REJECT: 'cancelled',
    EXPIRE: 'cancelled',
    CANCEL: 'cancelled',
  },
  waiting: {
    TIMER_DONE: 'queued',
    CANCEL: 'cancelled',
  },
  success: {},
  failed: {},
  cancelled: {},
  skipped: {},
};

/**
 * Error thrown when an invalid state transition is attempted.
 */
export class InvalidTransitionError extends Error {
  readonly state: ExecutionState;
  readonly event: ExecutionEvent;

  constructor(state: ExecutionState, event: ExecutionEvent) {
    super(`Invalid transition: cannot apply event '${event}' in state '${state}'`);
    this.name = 'InvalidTransitionError';
    this.state = state;
    this.event = event;
  }
}

/**
 * Attempt a state transition. Returns the new state or throws InvalidTransitionError.
 *
 * Pure function - no internal state.
 */
export function transition(state: ExecutionState, event: ExecutionEvent): ExecutionState {
  const nextState = TRANSITIONS[state][event];
  if (nextState === undefined) {
    throw new InvalidTransitionError(state, event);
  }
  return nextState;
}

/**
 * Check whether a transition is valid without throwing.
 *
 * Pure function - no internal state.
 */
export function canTransition(state: ExecutionState, event: ExecutionEvent): boolean {
  return TRANSITIONS[state][event] !== undefined;
}

/**
 * Check whether a state is terminal (no further transitions possible).
 *
 * Pure function - no internal state.
 */
export function isTerminal(state: ExecutionState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * Get the list of valid events for a given state.
 *
 * Pure function - no internal state.
 */
export function validEvents(state: ExecutionState): ExecutionEvent[] {
  return Object.keys(TRANSITIONS[state]) as ExecutionEvent[];
}
