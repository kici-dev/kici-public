/**
 * Workspace-member wiring for `kici init --workspace`: add `.kici` to the
 * workspace package list, and name the specifier a `.kici/package.json` uses
 * to depend on a sibling workspace package.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isSeq, parseDocument } from 'yaml';
import { WorkspaceKind, YarnFlavor } from '@kici-dev/core/package-manager';
import { isWorkspaceMember } from '../lockfile/workspace-siblings.js';

/** What registering `.kici` in the workspace changed. */
export enum MemberRegistration {
  AlreadyMember = 'already-member',
  Added = 'added',
}

/** The POSIX path of `kiciDir` relative to the workspace root, as a workspace entry. */
export function memberEntry(workspaceRoot: string, kiciDir: string): string {
  return path.relative(workspaceRoot, kiciDir).split(path.sep).join('/');
}

/**
 * Append `entry` to the `packages:` list of a `pnpm-workspace.yaml`, keeping
 * every comment, entry, quote style and other key. Creates the list when the
 * file declares none.
 */
export function addPnpmWorkspacePackage(raw: string, entry: string): string {
  const doc = parseDocument(raw);
  const packages = doc.get('packages', true);
  if (isSeq(packages)) packages.add(doc.createNode(entry));
  else doc.set('packages', doc.createNode([entry]));
  return doc.toString();
}

/**
 * Append `entry` to the `workspaces` list of a root `package.json` (the array
 * form or the `{ packages: [] }` form), keeping the manifest's indentation and
 * its trailing newline.
 */
export function addManifestWorkspace(raw: string, entry: string): string {
  const pkg = JSON.parse(raw) as { workspaces?: string[] | { packages?: string[] } };
  if (Array.isArray(pkg.workspaces)) pkg.workspaces.push(entry);
  else if (pkg.workspaces && Array.isArray(pkg.workspaces.packages)) {
    pkg.workspaces.packages.push(entry);
  } else pkg.workspaces = [entry];
  const indent = /^([ \t]+)"/m.exec(raw)?.[1] ?? '  ';
  return JSON.stringify(pkg, null, indent) + (raw.endsWith('\n') ? '\n' : '');
}

/**
 * Add `"version": "0.0.0"` after the name of a package.json that declares no
 * version, keeping its indentation and trailing newline. yarn classic ignores a
 * workspace member with no version. A manifest that has one is returned as is.
 */
export function addMissingVersion(raw: string): string {
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  if (pkg.version !== undefined) return raw;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(pkg)) {
    out[key] = value;
    if (key === 'name') out.version = '0.0.0';
  }
  if (out.version === undefined) out.version = '0.0.0';
  const indent = /^([ \t]+)"/m.exec(raw)?.[1] ?? '  ';
  return JSON.stringify(out, null, indent) + (raw.endsWith('\n') ? '\n' : '');
}

/**
 * Make `kiciDir` a member of the workspace at `workspaceRoot`: `pnpm-workspace.yaml`
 * for pnpm, the root `package.json` `workspaces` for npm and yarn. Does nothing
 * when a workspace glob already covers it.
 */
export async function registerKiciWorkspaceMember(
  workspaceRoot: string,
  kind: WorkspaceKind,
  kiciDir: string,
): Promise<MemberRegistration> {
  const entry = memberEntry(workspaceRoot, kiciDir);
  if (isWorkspaceMember(workspaceRoot, entry)) return MemberRegistration.AlreadyMember;
  if (kind === WorkspaceKind.Pnpm) {
    const file = path.join(workspaceRoot, 'pnpm-workspace.yaml');
    await writeFile(file, addPnpmWorkspacePackage(await readFile(file, 'utf-8'), entry), 'utf-8');
  } else {
    const file = path.join(workspaceRoot, 'package.json');
    await writeFile(file, addManifestWorkspace(await readFile(file, 'utf-8'), entry), 'utf-8');
  }
  return MemberRegistration.Added;
}

/**
 * The specifier `.kici/package.json` uses for a sibling workspace package:
 * `workspace:*` where the manager has the workspace protocol (pnpm, yarn
 * berry), the sibling's own version range where it links by version (npm,
 * yarn classic).
 */
export function memberSiblingSpecifier(kind: WorkspaceKind, yarnFlavor: YarnFlavor): string {
  if (kind === WorkspaceKind.Pnpm) return 'workspace:*';
  if (kind === WorkspaceKind.Yarn && yarnFlavor === YarnFlavor.Berry) return 'workspace:*';
  return '^<version>';
}
