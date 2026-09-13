// Covers surface: cli:kici-admin:attestations list
import { describe, expect, it, vi } from 'vitest';
import { runAttestationList, type AttestationListDbRow } from './attestations-list.js';

const row = (over: Partial<AttestationListDbRow> = {}): AttestationListDbRow => ({
  id: 'at1',
  run_id: 'run1',
  job_id: 'job1',
  subject_name: 'pkg@1.0.0',
  verify_status: 'verified',
  created_at: new Date('2026-07-04T00:00:00.000Z'),
  ...over,
});

describe('runAttestationList', () => {
  it('maps DB rows to the camelCase JSON envelope', async () => {
    const read = vi.fn(async () => [row()]);
    const res = await runAttestationList(read, { limit: 20 });
    expect(res).toEqual({
      attestations: [
        {
          id: 'at1',
          runId: 'run1',
          jobId: 'job1',
          subjectName: 'pkg@1.0.0',
          verifyStatus: 'verified',
          createdAt: '2026-07-04T00:00:00.000Z',
        },
      ],
    });
  });

  it('returns an empty envelope for no rows', async () => {
    const read = vi.fn(async () => []);
    const res = await runAttestationList(read, { limit: 20 });
    expect(res).toEqual({ attestations: [] });
  });

  it('threads limit and run/job filters to the read fn', async () => {
    const read = vi.fn(async () => []);
    await runAttestationList(read, { limit: 5, runId: 'r9', jobId: 'j9' });
    expect(read).toHaveBeenCalledWith({ limit: 5, runId: 'r9', jobId: 'j9' });
  });
});
