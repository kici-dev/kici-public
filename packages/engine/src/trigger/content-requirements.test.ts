import { describe, it, expect } from 'vitest';
import {
  evaluateContentRequirements,
  parseForFormat,
  type LockContentRequirement,
} from './content-requirements.js';

const f = (bytes: string): Map<string, { present: boolean; bytes?: string }> =>
  new Map([['package.json', { present: true, bytes }]]);

describe('evaluateContentRequirements', () => {
  it('exists over json', () => {
    const r = evaluateContentRequirements(
      [{ file: 'package.json', format: 'json', exists: ['$.scripts.ci'] }],
      f('{"scripts":{"ci":"x"}}'),
    );
    expect(r.pass).toBe(true);
  });

  it('exists over json fails when the path is absent', () => {
    const r = evaluateContentRequirements(
      [{ file: 'package.json', format: 'json', exists: ['$.scripts.ci'] }],
      f('{"scripts":{"build":"x"}}'),
    );
    expect(r.pass).toBe(false);
    expect(r.indeterminate).toBeUndefined();
  });

  it('yaml parses to an object so JSONPath works', () => {
    const r = evaluateContentRequirements(
      [{ file: 'c.yaml', format: 'yaml', exists: ['$.services.web'] }],
      new Map([['c.yaml', { present: true, bytes: 'services:\n  web: {}\n' }]]),
    );
    expect(r.pass).toBe(true);
  });

  it('text uses matches', () => {
    const r = evaluateContentRequirements(
      [{ file: 'Dockerfile', format: 'text', matches: ['/^FROM dhi\.io/m'] }],
      new Map([['Dockerfile', { present: true, bytes: 'FROM dhi.io/node:22\n' }]]),
    );
    expect(r.pass).toBe(true);
  });

  it('matches fails when the pattern is not present', () => {
    const r = evaluateContentRequirements(
      [{ file: 'Dockerfile', format: 'text', matches: ['/^FROM dhi\.io/m'] }],
      new Map([['Dockerfile', { present: true, bytes: 'FROM docker.io/node:22\n' }]]),
    );
    expect(r.pass).toBe(false);
  });

  it('match compares a JSONPath value', () => {
    const r = evaluateContentRequirements(
      [{ file: 'package.json', format: 'json', match: { '$.name': 'demo' } }],
      f('{"name":"demo"}'),
    );
    expect(r.pass).toBe(true);
    const r2 = evaluateContentRequirements(
      [{ file: 'package.json', format: 'json', match: { '$.name': 'other' } }],
      f('{"name":"demo"}'),
    );
    expect(r2.pass).toBe(false);
  });

  it('not passes only when the JSONPath value does NOT match', () => {
    const r = evaluateContentRequirements(
      [{ file: 'package.json', format: 'json', not: { '$.private': true } }],
      f('{"private":false}'),
    );
    expect(r.pass).toBe(true);
    const r2 = evaluateContentRequirements(
      [{ file: 'package.json', format: 'json', not: { '$.private': true } }],
      f('{"private":true}'),
    );
    expect(r2.pass).toBe(false);
  });

  it("format 'auto' picks json/yaml/text by extension", () => {
    expect(
      evaluateContentRequirements(
        [{ file: 'a.json', format: 'auto', exists: ['$.k'] }],
        new Map([['a.json', { present: true, bytes: '{"k":1}' }]]),
      ).pass,
    ).toBe(true);
    expect(
      evaluateContentRequirements(
        [{ file: 'a.yml', format: 'auto', exists: ['$.k'] }],
        new Map([['a.yml', { present: true, bytes: 'k: 1\n' }]]),
      ).pass,
    ).toBe(true);
    expect(
      evaluateContentRequirements(
        [{ file: 'a.txt', format: 'auto', matches: ['/hello/'] }],
        new Map([['a.txt', { present: true, bytes: 'hello world' }]]),
      ).pass,
    ).toBe(true);
  });

  it('a missing file with a query key fails (definite no, not indeterminate)', () => {
    const r = evaluateContentRequirements(
      [{ file: 'package.json', format: 'json', exists: ['$.a'] }],
      new Map([['package.json', { present: false }]]),
    );
    expect(r.pass).toBe(false);
    expect(r.indeterminate).toBeUndefined();
  });

  it('entries are AND-ed', () => {
    const files = new Map<string, { present: boolean; bytes?: string }>([
      ['a.json', { present: true, bytes: '{"a":1}' }],
      ['b.json', { present: true, bytes: '{"b":2}' }],
    ]);
    expect(
      evaluateContentRequirements(
        [
          { file: 'a.json', format: 'json', exists: ['$.a'] },
          { file: 'b.json', format: 'json', exists: ['$.b'] },
        ],
        files,
      ).pass,
    ).toBe(true);
    expect(
      evaluateContentRequirements(
        [
          { file: 'a.json', format: 'json', exists: ['$.a'] },
          { file: 'b.json', format: 'json', exists: ['$.missing'] },
        ],
        files,
      ).pass,
    ).toBe(false);
  });

  it('absent passes only when the file is missing', () => {
    expect(
      evaluateContentRequirements(
        [{ file: 'x', absent: true }],
        new Map([['x', { present: false }]]),
      ).pass,
    ).toBe(true);
    expect(
      evaluateContentRequirements(
        [{ file: 'x', absent: true }],
        new Map([['x', { present: true, bytes: '' }]]),
      ).pass,
    ).toBe(false);
  });

  it('a parse failure with a query key is indeterminate (fail-visible, pass=false)', () => {
    const r = evaluateContentRequirements(
      [{ file: 'package.json', format: 'json', exists: ['$.a'] }],
      f('{not json'),
    );
    expect(r.pass).toBe(false);
    expect(r.indeterminate).toMatch(/parse/i);
  });

  it('a file over 1 MiB is indeterminate', () => {
    const r = evaluateContentRequirements(
      [{ file: 'big.json', format: 'json', exists: ['$.a'] }],
      new Map([['big.json', { present: true, bytes: 'x'.repeat(1024 * 1024 + 1) }]]),
    );
    expect(r.pass).toBe(false);
    expect(r.indeterminate).toMatch(/1 ?MiB|size/i);
  });

  it('rejects a YAML bomb via anchor caps', () => {
    const bomb =
      'a: &a ["x","x"]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: [*b,*b,*b,*b,*b,*b,*b,*b,*b]\n';
    const r = evaluateContentRequirements(
      [{ file: 'b.yaml', format: 'yaml', exists: ['$.c'] }],
      new Map([['b.yaml', { present: true, bytes: bomb }]]),
    );
    expect(r.pass).toBe(false); // rejected/indeterminate, never a hang
  });

  it('an unsafe (ReDoS-prone) matches pattern is indeterminate, not evaluated', () => {
    const r = evaluateContentRequirements(
      [{ file: 'Dockerfile', format: 'text', matches: ['/(a+)+$/'] }],
      new Map([['Dockerfile', { present: true, bytes: 'aaaaaaaaaa' }]]),
    );
    expect(r.pass).toBe(false);
    expect(r.indeterminate).toMatch(/regex|unsafe|redos/i);
  });

  it('empty requirements pass', () => {
    expect(evaluateContentRequirements([], new Map()).pass).toBe(true);
  });
});

describe('parseForFormat', () => {
  it('parses json', () => {
    expect(parseForFormat('{"a":1}', 'json')).toEqual({ a: 1 });
  });
  it('parses yaml', () => {
    expect(parseForFormat('a: 1\n', 'yaml')).toEqual({ a: 1 });
  });
  it('returns the raw string for text', () => {
    const bytes: LockContentRequirement['file'] = 'plain content';
    expect(parseForFormat(bytes, 'text')).toBe('plain content');
  });
});

describe('content requirements — literal text keys', () => {
  const files = new Map([['Dockerfile', { present: true, bytes: 'FROM node:22\nRUN echo hi\n' }]]);

  it('contains requires every needle', () => {
    expect(
      evaluateContentRequirements([{ file: 'Dockerfile', contains: ['FROM node:'] }], files).pass,
    ).toBe(true);
    expect(
      evaluateContentRequirements(
        [{ file: 'Dockerfile', contains: ['FROM node:', 'apt-get'] }],
        files,
      ).pass,
    ).toBe(false);
  });

  it('notContains passes only when no needle is present', () => {
    expect(
      evaluateContentRequirements([{ file: 'Dockerfile', notContains: ['apt-get'] }], files).pass,
    ).toBe(true);
    expect(
      evaluateContentRequirements([{ file: 'Dockerfile', notContains: ['RUN'] }], files).pass,
    ).toBe(false);
  });

  it('notMatches inverts a regex', () => {
    expect(
      evaluateContentRequirements([{ file: 'Dockerfile', notMatches: ['/^FROM alpine/m'] }], files)
        .pass,
    ).toBe(true);
    expect(
      evaluateContentRequirements([{ file: 'Dockerfile', notMatches: ['/^FROM node/m'] }], files)
        .pass,
    ).toBe(false);
  });

  it('honours ignoreCase for literals', () => {
    expect(
      evaluateContentRequirements(
        [{ file: 'Dockerfile', contains: ['from NODE:'], ignoreCase: true }],
        files,
      ).pass,
    ).toBe(true);
  });

  it('ANDs the literal keys with the existing matches key', () => {
    const req = { file: 'Dockerfile', contains: ['FROM node:'], matches: ['/RUN/'] };
    expect(evaluateContentRequirements([req], files).pass).toBe(true);
    expect(evaluateContentRequirements([{ ...req, matches: ['/RUNX/'] }], files).pass).toBe(false);
  });

  it('surfaces an unsafe regex as indeterminate rather than a clean false', () => {
    const r = evaluateContentRequirements(
      [{ file: 'Dockerfile', notMatches: ['/(a+)+$/'] }],
      files,
    );
    expect(r.pass).toBe(false);
    expect(r.indeterminate).toContain('Dockerfile');
  });

  it('a missing file is a definite no for a literal query, not indeterminate', () => {
    const r = evaluateContentRequirements([{ file: 'nope', contains: ['x'] }], new Map());
    expect(r).toEqual({ pass: false });
  });
});
