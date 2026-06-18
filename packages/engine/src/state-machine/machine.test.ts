import { describe, it, expect } from 'vitest';
import {
  transition,
  canTransition,
  isTerminal,
  validEvents,
  InvalidTransitionError,
} from './machine.js';
import type { ExecutionState, ExecutionEvent } from './types.js';

describe('execution state machine', () => {
  describe('transition()', () => {
    describe('valid transitions', () => {
      it('pending + ENQUEUE -> queued', () => {
        expect(transition('pending', 'ENQUEUE')).toBe('queued');
      });

      it('pending + CANCEL -> cancelled', () => {
        expect(transition('pending', 'CANCEL')).toBe('cancelled');
      });

      it('pending + SKIP -> skipped', () => {
        expect(transition('pending', 'SKIP')).toBe('skipped');
      });

      it('queued + START -> running', () => {
        expect(transition('queued', 'START')).toBe('running');
      });

      it('queued + FAIL -> failed', () => {
        expect(transition('queued', 'FAIL')).toBe('failed');
      });

      it('queued + CANCEL -> cancelled', () => {
        expect(transition('queued', 'CANCEL')).toBe('cancelled');
      });

      it('running + SUCCEED -> success', () => {
        expect(transition('running', 'SUCCEED')).toBe('success');
      });

      it('running + FAIL -> failed', () => {
        expect(transition('running', 'FAIL')).toBe('failed');
      });

      it('running + CANCEL -> cancelled', () => {
        expect(transition('running', 'CANCEL')).toBe('cancelled');
      });

      it('running + RECOVER -> recovering', () => {
        expect(transition('running', 'RECOVER')).toBe('recovering');
      });

      it('recovering + START -> running (agent reconnected)', () => {
        expect(transition('recovering', 'START')).toBe('running');
      });

      it('recovering + FAIL -> failed (grace period expired)', () => {
        expect(transition('recovering', 'FAIL')).toBe('failed');
      });

      it('recovering + CANCEL -> cancelled', () => {
        expect(transition('recovering', 'CANCEL')).toBe('cancelled');
      });
    });

    describe('invalid transitions from pending', () => {
      it('pending + START throws InvalidTransitionError', () => {
        expect(() => transition('pending', 'START')).toThrow(InvalidTransitionError);
      });

      it('pending + SUCCEED throws InvalidTransitionError', () => {
        expect(() => transition('pending', 'SUCCEED')).toThrow(InvalidTransitionError);
      });

      it('pending + FAIL throws InvalidTransitionError', () => {
        expect(() => transition('pending', 'FAIL')).toThrow(InvalidTransitionError);
      });
    });

    describe('invalid transitions from queued', () => {
      it('queued + ENQUEUE throws InvalidTransitionError', () => {
        expect(() => transition('queued', 'ENQUEUE')).toThrow(InvalidTransitionError);
      });

      it('queued + SUCCEED throws InvalidTransitionError', () => {
        expect(() => transition('queued', 'SUCCEED')).toThrow(InvalidTransitionError);
      });

      it('queued + SKIP throws InvalidTransitionError', () => {
        expect(() => transition('queued', 'SKIP')).toThrow(InvalidTransitionError);
      });
    });

    describe('invalid transitions from running', () => {
      it('running + ENQUEUE throws InvalidTransitionError', () => {
        expect(() => transition('running', 'ENQUEUE')).toThrow(InvalidTransitionError);
      });

      it('running + START throws InvalidTransitionError', () => {
        expect(() => transition('running', 'START')).toThrow(InvalidTransitionError);
      });

      it('running + SKIP throws InvalidTransitionError', () => {
        expect(() => transition('running', 'SKIP')).toThrow(InvalidTransitionError);
      });
    });

    describe('invalid transitions from recovering', () => {
      it('recovering + SUCCEED throws InvalidTransitionError (cannot succeed from recovering)', () => {
        expect(() => transition('recovering', 'SUCCEED')).toThrow(InvalidTransitionError);
      });

      it('recovering + RECOVER throws InvalidTransitionError (cannot double-recover)', () => {
        expect(() => transition('recovering', 'RECOVER')).toThrow(InvalidTransitionError);
      });

      it('recovering + ENQUEUE throws InvalidTransitionError', () => {
        expect(() => transition('recovering', 'ENQUEUE')).toThrow(InvalidTransitionError);
      });

      it('recovering + SKIP throws InvalidTransitionError', () => {
        expect(() => transition('recovering', 'SKIP')).toThrow(InvalidTransitionError);
      });
    });

    describe('held state transitions', () => {
      it('pending + HOLD -> held', () => {
        expect(transition('pending', 'HOLD')).toBe('held');
      });

      it('held + APPROVE -> queued', () => {
        expect(transition('held', 'APPROVE')).toBe('queued');
      });

      it('held + REJECT -> cancelled', () => {
        expect(transition('held', 'REJECT')).toBe('cancelled');
      });

      it('held + EXPIRE -> cancelled', () => {
        expect(transition('held', 'EXPIRE')).toBe('cancelled');
      });

      it('held + CANCEL -> cancelled', () => {
        expect(transition('held', 'CANCEL')).toBe('cancelled');
      });
    });

    describe('waiting state transitions', () => {
      it('pending + WAIT -> waiting', () => {
        expect(transition('pending', 'WAIT')).toBe('waiting');
      });

      it('waiting + TIMER_DONE -> queued', () => {
        expect(transition('waiting', 'TIMER_DONE')).toBe('queued');
      });

      it('waiting + CANCEL -> cancelled', () => {
        expect(transition('waiting', 'CANCEL')).toBe('cancelled');
      });
    });

    describe('terminal states reject all events', () => {
      const terminalStates: ExecutionState[] = ['success', 'failed', 'cancelled', 'skipped'];
      const allEvents: ExecutionEvent[] = [
        'ENQUEUE',
        'START',
        'SUCCEED',
        'FAIL',
        'CANCEL',
        'CANCEL_GRACEFUL',
        'CANCEL_FORCE',
        'COMPLETE',
        'SKIP',
        'RECOVER',
        'HOLD',
        'APPROVE',
        'REJECT',
        'EXPIRE',
        'WAIT',
        'TIMER_DONE',
      ];

      for (const state of terminalStates) {
        for (const event of allEvents) {
          it(`${state} + ${event} throws InvalidTransitionError`, () => {
            expect(() => transition(state, event)).toThrow(InvalidTransitionError);
          });
        }
      }
    });

    describe('error message quality', () => {
      it('includes state and event in error message', () => {
        try {
          transition('pending', 'SUCCEED');
          expect.fail('should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(InvalidTransitionError);
          const error = err as InvalidTransitionError;
          expect(error.message).toContain('pending');
          expect(error.message).toContain('SUCCEED');
          expect(error.state).toBe('pending');
          expect(error.event).toBe('SUCCEED');
        }
      });
    });
  });

  describe('canTransition()', () => {
    it('returns true for valid transitions', () => {
      expect(canTransition('pending', 'ENQUEUE')).toBe(true);
      expect(canTransition('pending', 'CANCEL')).toBe(true);
      expect(canTransition('pending', 'SKIP')).toBe(true);
      expect(canTransition('pending', 'HOLD')).toBe(true);
      expect(canTransition('pending', 'WAIT')).toBe(true);
      expect(canTransition('queued', 'START')).toBe(true);
      expect(canTransition('queued', 'FAIL')).toBe(true);
      expect(canTransition('queued', 'CANCEL')).toBe(true);
      expect(canTransition('running', 'SUCCEED')).toBe(true);
      expect(canTransition('running', 'FAIL')).toBe(true);
      expect(canTransition('running', 'CANCEL')).toBe(true);
      expect(canTransition('running', 'RECOVER')).toBe(true);
      expect(canTransition('recovering', 'START')).toBe(true);
      expect(canTransition('recovering', 'FAIL')).toBe(true);
      expect(canTransition('recovering', 'CANCEL')).toBe(true);
      expect(canTransition('held', 'APPROVE')).toBe(true);
      expect(canTransition('held', 'REJECT')).toBe(true);
      expect(canTransition('held', 'EXPIRE')).toBe(true);
      expect(canTransition('held', 'CANCEL')).toBe(true);
      expect(canTransition('waiting', 'TIMER_DONE')).toBe(true);
      expect(canTransition('waiting', 'CANCEL')).toBe(true);
    });

    it('returns false for invalid transitions', () => {
      expect(canTransition('pending', 'START')).toBe(false);
      expect(canTransition('pending', 'SUCCEED')).toBe(false);
      expect(canTransition('pending', 'FAIL')).toBe(false);
      expect(canTransition('queued', 'ENQUEUE')).toBe(false);
      expect(canTransition('queued', 'SUCCEED')).toBe(false);
      expect(canTransition('queued', 'SKIP')).toBe(false);
      expect(canTransition('running', 'ENQUEUE')).toBe(false);
      expect(canTransition('running', 'START')).toBe(false);
      expect(canTransition('running', 'SKIP')).toBe(false);
      expect(canTransition('recovering', 'SUCCEED')).toBe(false);
      expect(canTransition('recovering', 'RECOVER')).toBe(false);
    });

    it('returns false for all events on terminal states', () => {
      const terminalStates: ExecutionState[] = ['success', 'failed', 'cancelled', 'skipped'];
      const allEvents: ExecutionEvent[] = [
        'ENQUEUE',
        'START',
        'SUCCEED',
        'FAIL',
        'CANCEL',
        'CANCEL_GRACEFUL',
        'CANCEL_FORCE',
        'COMPLETE',
        'SKIP',
        'RECOVER',
        'HOLD',
        'APPROVE',
        'REJECT',
        'EXPIRE',
        'WAIT',
        'TIMER_DONE',
      ];

      for (const state of terminalStates) {
        for (const event of allEvents) {
          expect(canTransition(state, event)).toBe(false);
        }
      }
    });
  });

  describe('isTerminal()', () => {
    it('returns true for terminal states', () => {
      expect(isTerminal('success')).toBe(true);
      expect(isTerminal('failed')).toBe(true);
      expect(isTerminal('cancelled')).toBe(true);
      expect(isTerminal('skipped')).toBe(true);
    });

    it('returns false for non-terminal states', () => {
      expect(isTerminal('pending')).toBe(false);
      expect(isTerminal('queued')).toBe(false);
      expect(isTerminal('running')).toBe(false);
      expect(isTerminal('recovering')).toBe(false);
      expect(isTerminal('held')).toBe(false);
      expect(isTerminal('waiting')).toBe(false);
    });
  });

  describe('validEvents()', () => {
    it('returns correct events for pending', () => {
      const events = validEvents('pending');
      expect(events).toContain('ENQUEUE');
      expect(events).toContain('CANCEL');
      expect(events).toContain('SKIP');
      expect(events).toContain('HOLD');
      expect(events).toContain('WAIT');
      expect(events).toHaveLength(5);
    });

    it('returns correct events for queued', () => {
      const events = validEvents('queued');
      expect(events).toContain('START');
      expect(events).toContain('FAIL');
      expect(events).toContain('CANCEL');
      expect(events).toHaveLength(3);
    });

    it('returns correct events for running', () => {
      const events = validEvents('running');
      expect(events).toContain('SUCCEED');
      expect(events).toContain('FAIL');
      expect(events).toContain('CANCEL');
      expect(events).toContain('CANCEL_GRACEFUL');
      expect(events).toContain('RECOVER');
      expect(events).toHaveLength(5);
    });

    it('returns correct events for recovering', () => {
      const events = validEvents('recovering');
      expect(events).toContain('START');
      expect(events).toContain('FAIL');
      expect(events).toContain('CANCEL');
      expect(events).toHaveLength(3);
    });

    it('returns correct events for held', () => {
      const events = validEvents('held');
      expect(events).toContain('APPROVE');
      expect(events).toContain('REJECT');
      expect(events).toContain('EXPIRE');
      expect(events).toContain('CANCEL');
      expect(events).toHaveLength(4);
    });

    it('returns correct events for waiting', () => {
      const events = validEvents('waiting');
      expect(events).toContain('TIMER_DONE');
      expect(events).toContain('CANCEL');
      expect(events).toHaveLength(2);
    });

    it('returns empty array for terminal states', () => {
      expect(validEvents('success')).toEqual([]);
      expect(validEvents('failed')).toEqual([]);
      expect(validEvents('cancelled')).toEqual([]);
      expect(validEvents('skipped')).toEqual([]);
    });
  });

  describe('full lifecycle paths', () => {
    it('happy path: pending -> queued -> running -> success', () => {
      let state: ExecutionState = 'pending';
      state = transition(state, 'ENQUEUE');
      expect(state).toBe('queued');
      state = transition(state, 'START');
      expect(state).toBe('running');
      state = transition(state, 'SUCCEED');
      expect(state).toBe('success');
      expect(isTerminal(state)).toBe(true);
    });

    it('failure path: pending -> queued -> running -> failed', () => {
      let state: ExecutionState = 'pending';
      state = transition(state, 'ENQUEUE');
      state = transition(state, 'START');
      state = transition(state, 'FAIL');
      expect(state).toBe('failed');
      expect(isTerminal(state)).toBe(true);
    });

    it('cancel from running: pending -> queued -> running -> cancelled', () => {
      let state: ExecutionState = 'pending';
      state = transition(state, 'ENQUEUE');
      state = transition(state, 'START');
      state = transition(state, 'CANCEL');
      expect(state).toBe('cancelled');
      expect(isTerminal(state)).toBe(true);
    });

    it('skip from pending: pending -> skipped', () => {
      let state: ExecutionState = 'pending';
      state = transition(state, 'SKIP');
      expect(state).toBe('skipped');
      expect(isTerminal(state)).toBe(true);
    });

    it('queue failure: pending -> queued -> failed', () => {
      let state: ExecutionState = 'pending';
      state = transition(state, 'ENQUEUE');
      state = transition(state, 'FAIL');
      expect(state).toBe('failed');
      expect(isTerminal(state)).toBe(true);
    });

    it('recovery path: pending -> queued -> running -> recovering -> running -> success', () => {
      let state: ExecutionState = 'pending';
      state = transition(state, 'ENQUEUE');
      expect(state).toBe('queued');
      state = transition(state, 'START');
      expect(state).toBe('running');
      state = transition(state, 'RECOVER');
      expect(state).toBe('recovering');
      expect(isTerminal(state)).toBe(false);
      state = transition(state, 'START');
      expect(state).toBe('running');
      state = transition(state, 'SUCCEED');
      expect(state).toBe('success');
      expect(isTerminal(state)).toBe(true);
    });

    it('recovery timeout: running -> recovering -> failed', () => {
      let state: ExecutionState = 'running';
      state = transition(state, 'RECOVER');
      expect(state).toBe('recovering');
      state = transition(state, 'FAIL');
      expect(state).toBe('failed');
      expect(isTerminal(state)).toBe(true);
    });

    it('cancel during recovery: running -> recovering -> cancelled', () => {
      let state: ExecutionState = 'running';
      state = transition(state, 'RECOVER');
      expect(state).toBe('recovering');
      state = transition(state, 'CANCEL');
      expect(state).toBe('cancelled');
      expect(isTerminal(state)).toBe(true);
    });

    it('hold and approve: pending -> held -> queued -> running -> success', () => {
      let state: ExecutionState = 'pending';
      state = transition(state, 'HOLD');
      expect(state).toBe('held');
      expect(isTerminal(state)).toBe(false);
      state = transition(state, 'APPROVE');
      expect(state).toBe('queued');
      state = transition(state, 'START');
      expect(state).toBe('running');
      state = transition(state, 'SUCCEED');
      expect(state).toBe('success');
      expect(isTerminal(state)).toBe(true);
    });

    it('hold and reject: pending -> held -> cancelled', () => {
      let state: ExecutionState = 'pending';
      state = transition(state, 'HOLD');
      expect(state).toBe('held');
      state = transition(state, 'REJECT');
      expect(state).toBe('cancelled');
      expect(isTerminal(state)).toBe(true);
    });

    it('hold and expire: pending -> held -> cancelled', () => {
      let state: ExecutionState = 'pending';
      state = transition(state, 'HOLD');
      state = transition(state, 'EXPIRE');
      expect(state).toBe('cancelled');
      expect(isTerminal(state)).toBe(true);
    });

    it('wait timer: pending -> waiting -> queued -> running -> success', () => {
      let state: ExecutionState = 'pending';
      state = transition(state, 'WAIT');
      expect(state).toBe('waiting');
      expect(isTerminal(state)).toBe(false);
      state = transition(state, 'TIMER_DONE');
      expect(state).toBe('queued');
      state = transition(state, 'START');
      expect(state).toBe('running');
      state = transition(state, 'SUCCEED');
      expect(state).toBe('success');
    });

    it('cancel during wait: pending -> waiting -> cancelled', () => {
      let state: ExecutionState = 'pending';
      state = transition(state, 'WAIT');
      state = transition(state, 'CANCEL');
      expect(state).toBe('cancelled');
      expect(isTerminal(state)).toBe(true);
    });

    it('graceful cancel with hooks: running -> cancelling -> cancelled', () => {
      let state: ExecutionState = 'pending';
      state = transition(state, 'ENQUEUE');
      state = transition(state, 'START');
      state = transition(state, 'CANCEL_GRACEFUL');
      expect(state).toBe('cancelling');
      expect(isTerminal(state)).toBe(false);
      state = transition(state, 'COMPLETE');
      expect(state).toBe('cancelled');
      expect(isTerminal(state)).toBe(true);
    });

    it('force cancel from cancelling: running -> cancelling -> cancelled', () => {
      let state: ExecutionState = 'running';
      state = transition(state, 'CANCEL_GRACEFUL');
      expect(state).toBe('cancelling');
      state = transition(state, 'CANCEL_FORCE');
      expect(state).toBe('cancelled');
      expect(isTerminal(state)).toBe(true);
    });

    it('hook failure during cancelling: cancelling -> failed', () => {
      let state: ExecutionState = 'running';
      state = transition(state, 'CANCEL_GRACEFUL');
      state = transition(state, 'FAIL');
      expect(state).toBe('failed');
      expect(isTerminal(state)).toBe(true);
    });
  });

  describe('cancelling state transitions', () => {
    it('transition(running, CANCEL_GRACEFUL) returns cancelling', () => {
      expect(transition('running', 'CANCEL_GRACEFUL')).toBe('cancelling');
    });

    it('transition(cancelling, CANCEL_FORCE) returns cancelled', () => {
      expect(transition('cancelling', 'CANCEL_FORCE')).toBe('cancelled');
    });

    it('transition(cancelling, COMPLETE) returns cancelled (hooks finished normally)', () => {
      expect(transition('cancelling', 'COMPLETE')).toBe('cancelled');
    });

    it('transition(cancelling, FAIL) returns failed (hook failed)', () => {
      expect(transition('cancelling', 'FAIL')).toBe('failed');
    });

    it('isTerminal(cancelling) returns false', () => {
      expect(isTerminal('cancelling')).toBe(false);
    });

    it('transition(running, CANCEL) still returns cancelled (backward compat)', () => {
      expect(transition('running', 'CANCEL')).toBe('cancelled');
    });

    it('transition(pending, CANCEL) still returns cancelled', () => {
      expect(transition('pending', 'CANCEL')).toBe('cancelled');
    });

    it('transition(queued, CANCEL) still returns cancelled', () => {
      expect(transition('queued', 'CANCEL')).toBe('cancelled');
    });

    it('transition(cancelling, CANCEL) throws InvalidTransitionError (must use CANCEL_FORCE)', () => {
      expect(() => transition('cancelling', 'CANCEL')).toThrow(InvalidTransitionError);
    });

    it('validEvents(cancelling) returns CANCEL_FORCE, COMPLETE, and FAIL', () => {
      const events = validEvents('cancelling');
      expect(events).toContain('CANCEL_FORCE');
      expect(events).toContain('COMPLETE');
      expect(events).toContain('FAIL');
      expect(events).toHaveLength(3);
    });

    it('pending + COMPLETE throws InvalidTransitionError', () => {
      expect(() => transition('pending', 'COMPLETE')).toThrow(InvalidTransitionError);
    });

    it('running + COMPLETE throws InvalidTransitionError', () => {
      expect(() => transition('running', 'COMPLETE')).toThrow(InvalidTransitionError);
    });

    it('queued + CANCEL_GRACEFUL throws InvalidTransitionError', () => {
      expect(() => transition('queued', 'CANCEL_GRACEFUL')).toThrow(InvalidTransitionError);
    });

    it('success + CANCEL_FORCE throws InvalidTransitionError', () => {
      expect(() => transition('success', 'CANCEL_FORCE')).toThrow(InvalidTransitionError);
    });
  });
});
