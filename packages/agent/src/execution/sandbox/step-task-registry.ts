import type { StepSecretMountRecord, TrackedStepSecrets } from '@kici-dev/sdk';

/** Per-step secrets handle + its teardown closure, keyed by step index. */
export interface StepTaskSlot {
  secrets: TrackedStepSecrets;
  dispose: () => Promise<void>;
}

/**
 * Per-task replacement for the runner's former `currentStepSecrets` /
 * `currentStepDispose` single-slots.
 *
 * The runner used to remember only the *most recent* step's secrets handle and
 * dispose closure; the access-log / mount-record / dispose reader callbacks read
 * that single slot. Under sequential execution that is correct (one step at a
 * time), but two concurrently-running steps would clobber each other's
 * secrets-audit trail. Keying every slot by the step's index keeps each step's
 * audit trail and teardown isolated — sequential behavior is identical, Phase 1
 * concurrency is correct.
 */
export class StepTaskRegistry {
  #slots = new Map<number, StepTaskSlot>();

  set(stepIndex: number, slot: StepTaskSlot): void {
    this.#slots.set(stepIndex, slot);
  }

  getAccessLog(stepIndex: number): string[] {
    return this.#slots.get(stepIndex)?.secrets.getAccessLog() ?? [];
  }

  getMountRecords(stepIndex: number): StepSecretMountRecord[] {
    const slot = this.#slots.get(stepIndex);
    return slot ? [...slot.secrets.getMountRecords()] : [];
  }

  async dispose(stepIndex: number): Promise<void> {
    const slot = this.#slots.get(stepIndex);
    if (!slot) return;
    this.#slots.delete(stepIndex);
    await slot.dispose();
  }
}
