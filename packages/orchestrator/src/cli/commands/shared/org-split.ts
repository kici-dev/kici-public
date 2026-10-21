/**
 * The note kici-admin prints when a source belongs to an org other than the
 * one this orchestrator is attached to. Such a source keeps working, under its
 * own org's contexts, secrets and trust policy; the note names the split and
 * the command that moves a GitHub source to the attached org.
 */
export function orgSplitNote(attachedOrgId: string, foreignOrgs: readonly string[]): string {
  const orgs = foreignOrgs.map((o) => `'${o}'`).join(', ');
  return (
    `Note: sources in org(s) ${orgs} run under that org's contexts, secrets and trust policy, ` +
    `not under '${attachedOrgId}', the org this orchestrator is attached to. Move a GitHub ` +
    `source with: kici-admin source update <routingKey> --org ${attachedOrgId}`
  );
}
