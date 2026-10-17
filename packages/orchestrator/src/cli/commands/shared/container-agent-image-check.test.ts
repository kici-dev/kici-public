/**
 * The scaler configs are real YAML files read through the orchestrator's own
 * loader, so the defaults (`imagePullPolicy: IfNotPresent`) are the ones the
 * service applies.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadScalerConfig } from '../../../scaler/config.js';
import {
  AgentImageIssue,
  checkContainerAgentImages,
  parseImageRef,
  warnAboutContainerAgentImages,
} from './container-agent-image-check.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-agent-image-check-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A container scaler `cont` with one `[linux, container]` label set. */
function containerScalerYaml(image: string, pullPolicy?: string): string {
  return [
    'version: 1',
    'scalers:',
    '  - name: cont',
    '    type: container',
    '    maxAgents: 1',
    '    labelSets:',
    '      - labels: [linux, container]',
    `        image: ${image}`,
    ...(pullPolicy ? [`        imagePullPolicy: ${pullPolicy}`] : []),
    '',
  ].join('\n');
}

async function findings(image: string, targetVersion: string | null, pullPolicy?: string) {
  const file = path.join(tmp, 'scalers.yaml');
  fs.writeFileSync(file, containerScalerYaml(image, pullPolicy));
  const config = await loadScalerConfig(file);
  return checkContainerAgentImages({ config, targetVersion, scalerConfigPath: file });
}

describe('parseImageRef', () => {
  it('splits a registry port from the tag and the digest', () => {
    // fails-when: the first `:` is read as the tag separator, so a mirror on
    // a port is never recognised as the agent image.
    expect(parseImageRef('registry.local:5000/kici-agent:0.19.0@sha256:abc')).toEqual({
      repository: 'registry.local:5000/kici-agent',
      tag: '0.19.0',
      digest: 'sha256:abc',
    });
    expect(parseImageRef('registry.local:5000/kici-agent')).toEqual({
      repository: 'registry.local:5000/kici-agent',
      tag: null,
      digest: null,
    });
  });
});

describe('checkContainerAgentImages', () => {
  it('warns on :latest with the default pull policy, naming the scaler, label set and the edit', async () => {
    const out = await findings('quay.io/kici-dev/kici-agent:latest', '0.19.0');
    // fails-when: the IfNotPresent default is not treated as "keeps the old
    // image", which is the state that keeps an upgraded host on an old agent.
    expect(out).toHaveLength(1);
    expect(out[0]!.issue).toBe(AgentImageIssue.MovingTag);
    expect(out[0]!.message).toBe(
      'container scaler "cont", label set [linux, container]: image ' +
        'quay.io/kici-dev/kici-agent:latest with imagePullPolicy IfNotPresent keeps the agent ' +
        'image this host already pulled, so the upgrade does not change the container agents. ' +
        `In ${path.join(tmp, 'scalers.yaml')}, set "image: quay.io/kici-dev/kici-agent:0.19.0" ` +
        'on this label set, or set "imagePullPolicy: Always" to pull latest on every spawn.',
    );
  });

  it('treats an untagged agent image as :latest', async () => {
    const out = await findings('quay.io/kici-dev/kici-agent', '0.19.0', 'IfNotPresent');
    // fails-when: only the literal `:latest` suffix is matched.
    expect(out.map((f) => f.issue)).toEqual([AgentImageIssue.MovingTag]);
  });

  it('names a generic pin when the target version is unknown', async () => {
    const out = await findings('quay.io/kici-dev/kici-agent:latest', null);
    // fails-when: the remedy prints "kici-agent:null".
    expect(out[0]!.message).toContain(
      'set image to the kici-agent release you upgrade to (quay.io/kici-dev/kici-agent:<version>)',
    );
    expect(out[0]!.message).not.toContain('null');
  });

  it('warns on a pin older than the upgrade target, on a mirror too', async () => {
    const out = await findings('registry.example.com/ci/kici-agent:0.18.0', '0.19.0', 'Always');
    // fails-when: the version comparison is skipped, or `Always` is read as
    // fixing a pinned tag (it re-pulls the same old release).
    expect(out).toHaveLength(1);
    expect(out[0]!.issue).toBe(AgentImageIssue.OlderPin);
    expect(out[0]!.message).toBe(
      'container scaler "cont", label set [linux, container]: image ' +
        'registry.example.com/ci/kici-agent:0.18.0 is older than the upgrade target 0.19.0, so ' +
        'the container agents keep running 0.18.0. In ' +
        `${path.join(tmp, 'scalers.yaml')}, set "image: registry.example.com/ci/kici-agent:0.19.0" ` +
        'on this label set.',
    );
  });

  it('compares releases numerically, digest-pinned refs included', async () => {
    // fails-when: versions are compared as strings ("0.9.0" > "0.19.0").
    const out = await findings('quay.io/kici-dev/kici-agent:0.9.0@sha256:abc', '0.19.0');
    expect(out.map((f) => f.issue)).toEqual([AgentImageIssue.OlderPin]);
  });

  // breaks-if-wrong: each of these is a correct config the upgrade does move
  // (or that is not a KiCI agent), and a warning on it would train operators
  // to ignore the real one.
  it.each([
    ['pinned to the target', 'quay.io/kici-dev/kici-agent:0.19.0', undefined],
    ['pinned to the target by digest', 'quay.io/kici-dev/kici-agent:0.19.0@sha256:abc', undefined],
    ['pinned newer than the target', 'quay.io/kici-dev/kici-agent:0.20.0', undefined],
    ['a prerelease of the target', 'quay.io/kici-dev/kici-agent:0.19.0-9159', undefined],
    [':latest pulled on every spawn', 'quay.io/kici-dev/kici-agent:latest', 'Always'],
    ['not a KiCI agent image', 'ghcr.io/myorg/build-runner:latest', undefined],
    ['a non-version tag', 'quay.io/kici-dev/kici-agent:e2e', undefined],
  ])('does not warn when the image is %s', async (_case, image, policy) => {
    expect(await findings(image, '0.19.0', policy)).toEqual([]);
  });

  it('does not warn on a digest pin, which the operator chose and no tag can date', async () => {
    expect(await findings('quay.io/kici-dev/kici-agent:latest@sha256:abc', '0.19.0')).toEqual([]);
  });

  it.each([
    ['latest', 'kici-agent:<version>'],
    ['v0.19.0', 'kici-agent:0.19.0"'],
  ])('suggests a real release tag when the target is %s', async (target, suggestion) => {
    const out = await findings('quay.io/kici-dev/kici-agent:latest', target);
    // fails-when: the target is used verbatim, so `--version latest` suggests
    // the very :latest setup the warning is about, and `v0.19.0` a tag quay
    // does not publish.
    expect(out[0]!.message).toContain(suggestion);
    expect(out[0]!.message).not.toMatch(/kici-agent:(latest|v0\.19\.0)"/);
  });

  it('ignores bare-metal label sets', async () => {
    const file = path.join(tmp, 'scalers.yaml');
    fs.writeFileSync(
      file,
      [
        'version: 1',
        'scalers:',
        '  - name: bm',
        '    type: bare-metal',
        '    maxAgents: 1',
        '    labelSets:',
        '      - labels: [linux]',
        '        image: quay.io/kici-dev/kici-agent:latest',
        '',
      ].join('\n'),
    );
    const config = await loadScalerConfig(file);
    expect(
      checkContainerAgentImages({ config, targetVersion: '0.19.0', scalerConfigPath: file }),
    ).toEqual([]);
  });
});

describe('warnAboutContainerAgentImages', () => {
  function instance(mainYaml: string, dropIn?: string): string {
    const scalers = path.join(tmp, 'scalers.yaml');
    fs.writeFileSync(scalers, mainYaml);
    const lines = [`KICI_SCALER_CONFIG_PATH=${scalers}`];
    if (dropIn) {
      const dir = path.join(tmp, 'scalers.d');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, '10-cont.yaml'), dropIn);
      lines.push(`KICI_SCALER_CONFIG_DIR=${dir}`);
    }
    const env = path.join(tmp, 'orch.env');
    fs.writeFileSync(env, lines.join('\n') + '\n');
    return env;
  }

  it('reads the instance scaler config, scalers.d included, and warns per label set', async () => {
    const env = instance(
      'version: 1\nscalers: []\n',
      containerScalerYaml('quay.io/kici-dev/kici-agent:latest').replace('version: 1\n', ''),
    );
    const warn = vi.fn();
    await warnAboutContainerAgentImages({
      envFilePath: env,
      workingDirectory: tmp,
      targetVersion: '0.19.0',
      warn,
    });
    // fails-when: KICI_SCALER_CONFIG_DIR is not merged, so a scaler declared
    // in scalers.d is never checked.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(
      /^Warning: container scaler "cont", label set \[linux, container\]: image quay\.io\/kici-dev\/kici-agent:latest .*\(or the file under .*scalers\.d that declares it\)/,
    );
  });

  it('prints nothing for a pinned image, and stays silent when the config is unreadable', async () => {
    const warn = vi.fn();
    const pinned = instance(containerScalerYaml('quay.io/kici-dev/kici-agent:0.19.0'));
    await warnAboutContainerAgentImages({
      envFilePath: pinned,
      workingDirectory: tmp,
      targetVersion: '0.19.0',
      warn,
    });
    await warnAboutContainerAgentImages({
      envFilePath: path.join(tmp, 'missing.env'),
      workingDirectory: tmp,
      targetVersion: '0.19.0',
      warn,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
