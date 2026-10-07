import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { shQuote } from './shell-quote.js';

describe('shQuote', () => {
  it('always quotes, even a plain token', () => {
    expect(shQuote('/a/b')).toBe(`'/a/b'`);
    expect(shQuote('')).toBe(`''`);
  });

  // fails-when: an embedded single quote is not closed, escaped and reopened
  it('escapes an embedded single quote', () => {
    expect(shQuote(`/a/'b`)).toBe(`'/a/'\\''b'`);
  });

  it('round-trips hostile input through a real shell', () => {
    const hostile = `a'b"c $(id) \`x\` $HOME ; | & \\ \n end`;
    const out = execFileSync('sh', ['-c', `printf %s ${shQuote(hostile)}`], { encoding: 'utf8' });
    expect(out).toBe(hostile);
  });
});
