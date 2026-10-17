/**
 * The one interface `kici run remote` drives a run through, relayed by the KiCI
 * Platform or direct. The run loop calls `initUpload` → `uploadTarball` →
 * `trigger`, polls `status` and `logs`, cancels on Ctrl-C and answers `holds`.
 */
import pc from 'picocolors';
import { logger } from '@kici-dev/core';
import { ApprovalDecision, type HeldRunSummary } from '@kici-dev/engine';
import {
  listHeldRunsForRun,
  postApprove,
  postReject,
  type HeldRunContext,
} from '../commands/held-run-client.js';
import type {
  ClusterTarget,
  PlatformCancelResponse,
  PlatformRunClient,
  PlatformRunLogsResponse,
  PlatformRunStatusResponse,
  PlatformTriggerInput,
  PlatformTriggerResponse,
  PlatformUploadInitInput,
  PlatformUploadInitResponse,
  RunLogPosition,
} from './platform-client.js';
import { HoldsUnavailableError, type DirectRunClient, type DirectWhoami } from './direct-client.js';
import { uploadTarball, type UploadResult } from './uploader.js';
import { describeUploadFailure } from './upload-failure.js';

interface RunHoldAccess {
  list(runId: string): Promise<HeldRunSummary[]>;
  /** The decision context, or null when holds cannot be answered from here. */
  context(): Promise<HeldRunContext | null>;
  approve(ctx: HeldRunContext, heldRunId: string, autoApprove?: boolean): Promise<boolean>;
  reject(ctx: HeldRunContext, heldRunId: string, reason: string): Promise<boolean>;
  /** The command that answers `hold` out of band. */
  answerHint(hold: HeldRunSummary): string;
}

export interface RunRemoteTransport {
  readonly kind: 'platform' | 'direct';
  /** Platform API or orchestrator base URL. */
  readonly endpoint: string;
  /** Printed before the run starts, naming where it goes. */
  readonly banner: string[];
  initUpload(body: PlatformUploadInitInput): Promise<PlatformUploadInitResponse>;
  uploadTarball(opts: {
    tarballPath: string;
    signedUrl: string;
    orchestratorPublicKey: Buffer;
  }): Promise<UploadResult>;
  trigger(body: PlatformTriggerInput): Promise<PlatformTriggerResponse>;
  status(runId: string): Promise<PlatformRunStatusResponse>;
  logs(runId: string, position: RunLogPosition): Promise<PlatformRunLogsResponse>;
  cancel(runId: string): Promise<PlatformCancelResponse>;
  readonly holds: RunHoldAccess;
}

/** A failed PUT names the address and the setting to check. */
async function uploadWithDiagnosis(opts: {
  tarballPath: string;
  signedUrl: string;
  orchestratorPublicKey: Buffer;
}): Promise<UploadResult> {
  try {
    return await uploadTarball(opts);
  } catch (err) {
    // An empty URL already carries its own message about missing storage.
    if (!opts.signedUrl) throw err;
    throw describeUploadFailure(err, opts.signedUrl);
  }
}

/**
 * The run goes through the Platform relay, to a cluster of the run's org (the
 * active org, or `--org`). Its holds are listed and answered in that same org.
 */
export function createPlatformTransport(opts: {
  client: PlatformRunClient;
  orgId: string;
  target: ClusterTarget;
  endpoint: string;
  /** The PAT the held-run routes are called with. */
  token: string;
}): RunRemoteTransport {
  const { client, orgId, target, endpoint, token } = opts;
  const holdContext: HeldRunContext = { endpoint, token, orgId };
  return {
    kind: 'platform',
    endpoint,
    banner: [`Platform: ${endpoint}`, `Organization: ${orgId}`],
    initUpload: (body) => client.initUpload(orgId, target, body),
    uploadTarball: uploadWithDiagnosis,
    trigger: (body) => client.trigger(orgId, target, body),
    status: (runId) => client.runStatus(orgId, runId, target),
    logs: (runId, position) => client.runLogs(orgId, runId, position, target),
    cancel: (runId) => client.cancel(orgId, runId, target),
    holds: {
      list: (runId) => listHeldRunsForRun(holdContext, runId),
      context: async () => holdContext,
      approve: postApprove,
      reject: postReject,
      answerHint: (hold) => `kici approve ${hold.runId} --hold ${hold.id}`,
    },
  };
}

/** The run goes straight to an orchestrator's `/api/v1/test` routes. */
export function createDirectTransport(opts: {
  client: DirectRunClient;
  whoami: DirectWhoami;
}): RunRemoteTransport {
  const { client, whoami } = opts;
  const orgId = whoami.orgId;
  const caller = whoami.subject ? `${whoami.label} (${whoami.subject})` : whoami.label;
  const decide = async (
    heldRunId: string,
    decision: ApprovalDecision,
    reason?: string,
    autoApprove = false,
  ): Promise<boolean> => {
    if (!orgId) return false;
    const ok = await client.decideHold(orgId, heldRunId, decision, reason, autoApprove);
    if (!ok && client.lastDecisionError) logger.error(pc.red(client.lastDecisionError));
    return ok;
  };
  return {
    kind: 'direct',
    endpoint: client.url,
    banner: [
      `Target: orchestrator ${client.url} (direct, ${whoami.mode} mode)`,
      `Caller: ${caller}, role ${whoami.role}; the orchestrator chooses the organization (${orgId ?? 'not assigned yet'})`,
    ],
    initUpload: (body) => client.initUpload(body),
    uploadTarball: uploadWithDiagnosis,
    trigger: (body) => client.trigger(body),
    status: (runId) => client.runStatus(runId),
    logs: (runId, position) => client.runLogs(runId, position),
    cancel: (runId) => client.cancel(runId),
    holds: {
      list: async (runId) => {
        if (!orgId) return [];
        try {
          return await client.listHolds(orgId, runId);
        } catch (err) {
          // Missing trust-policy permissions or routes: name the operator command.
          if (err instanceof HoldsUnavailableError && err.status !== 409) {
            throw new HoldsUnavailableError(
              `${err.message}. An operator answers this run's holds with \`kici-admin held-run approve --org ${orgId} --run-id ${runId}\`.`,
              err.status,
            );
          }
          throw err;
        }
      },
      context: async () => (orgId ? { endpoint: client.url, token: '', orgId } : null),
      approve: (_ctx, heldRunId, autoApprove) =>
        decide(heldRunId, ApprovalDecision.enum.approve, undefined, autoApprove === true),
      reject: (_ctx, heldRunId, reason) => decide(heldRunId, ApprovalDecision.enum.reject, reason),
      answerHint: (hold) =>
        `kici-admin held-run approve --org ${orgId ?? '<org>'} --run-id ${hold.runId} --hold ${hold.id}`,
    },
  };
}
