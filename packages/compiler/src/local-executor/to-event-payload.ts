import type { SimulatedEvent } from '@kici-dev/engine';
import type { EventPayload } from '@kici-dev/sdk';

/**
 * Map a {@link SimulatedEvent} into the normalized SDK {@link EventPayload}
 * envelope that every user-authored dynamic function (dynamic job generators,
 * `concurrency.group()`) receives as its `event` argument.
 *
 * `SimulatedEvent` already carries the normalized fields (`type`, `action`,
 * `targetBranch`, …) alongside the raw provider body under `payload`, so the
 * single cast at this boundary is a deliberate type assertion over a
 * structurally-identical value: it asserts the discriminated-union view
 * without reshaping anything. Raw provider fields stay nested under
 * `payload.<field>`; normalized fields live at the top level.
 */
export function toEventPayload(event: SimulatedEvent): EventPayload {
  return event as EventPayload;
}
