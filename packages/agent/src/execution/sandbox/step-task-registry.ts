import type { StepSecretMountRecord, TrackedStepSecrets } from '@kici-dev/sdk';

/** Per-step secrets handle + its teardown closure, keyed by step index. */
export interface StepTaskSlot {
  secrets: TrackedStepSecrets;
  dispose: () => Promise<void>;
}

/**
 * Keyed by step index so concurrent `parallel()` children keep isolated
 * secrets-audit trails and teardown; a single shared slot would let two
 * running steps clobber each other's.
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
