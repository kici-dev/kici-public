import { describe, expect, it, vi } from 'vitest';
import {
  SERVICE_ENV_FILE_VAR,
  applyServiceEnvFile,
  mustRelaunch,
  parseServiceEnvFile,
  relaunchWithEnv,
  runServiceEnvLoader,
  type RelaunchDeps,
  type ServiceEnvLoaderDeps,
} from './service-env-file.js';

/** A readFile double over an in-memory file map; a missing path throws like fs does. */
function files(map: Record<string, string>) {
  return (p: string): string => {
    const content = map[p];
    if (content === undefined) {
      throw Object.assign(new Error(`ENOENT: no such file, open '${p}'`), { code: 'ENOENT' });
    }
    return content;
  };
}

describe('parseServiceEnvFile', () => {
  // fails-when: the value is cut at `#` (Node's parseEnv) or at the second `=`.
  it('keeps everything after the first = verbatim', () => {
    const content = [
      '# comment',
      '',
      'KICI_DATABASE_URL=postgres://kici:p#ss=w0rd@db:5432/kici',
      '  KICI_LOG_DIR=C:\\Program Files\\kici\\logs\\  ',
      'WEBHOOK_SECRET=a b c\r',
    ].join('\n');
    expect(parseServiceEnvFile(content)).toEqual([
      { key: 'KICI_DATABASE_URL', value: 'postgres://kici:p#ss=w0rd@db:5432/kici' },
      { key: 'KICI_LOG_DIR', value: 'C:\\Program Files\\kici\\logs\\' },
      { key: 'WEBHOOK_SECRET', value: 'a b c' },
    ]);
  });

  it('skips a line with no = and a line with an empty key', () => {
    expect(parseServiceEnvFile('JUSTTEXT\n=value\nK=v\n')).toEqual([{ key: 'K', value: 'v' }]);
  });
});

describe('applyServiceEnvFile', () => {
  const SENTINEL = 'sentinel-7f3c9a';

  it('applies every assignment, overriding the inherited value', () => {
    const env: NodeJS.ProcessEnv = {
      [SERVICE_ENV_FILE_VAR]: 'C:\\kici\\o.env',
      KICI_PORT: '4000',
    };
    const applied = applyServiceEnvFile(env, {
      readFile: files({ 'C:\\kici\\o.env': `KICI_PORT=10043\nKICI_SECRET_KEY=${SENTINEL}\n` }),
      pathDelimiter: ';',
    });
    expect(applied).toEqual({ path: 'C:\\kici\\o.env', startupKeys: [] });
    expect(env.KICI_PORT).toBe('10043');
    expect(env.KICI_SECRET_KEY).toBe(SENTINEL);
  });

  // fails-when: the pointer stays in the environment, so a spawned KiCI child
  // loads the parent's env file.
  it('removes the pointer once the file is loaded, and ignores one inside the file', () => {
    const env: NodeJS.ProcessEnv = { [SERVICE_ENV_FILE_VAR]: '/f.env' };
    applyServiceEnvFile(env, {
      readFile: files({ '/f.env': `${SERVICE_ENV_FILE_VAR}=/other.env\nK=v\n` }),
      pathDelimiter: ':',
    });
    expect(env[SERVICE_ENV_FILE_VAR]).toBeUndefined();
    expect(env.K).toBe('v');
  });

  // fails-when: PATH from the file replaces the inherited PATH (LocalSystem then
  // loses System32) instead of going in front of it.
  it('puts PATH directories in front of the inherited PATH', () => {
    const env: NodeJS.ProcessEnv = {
      [SERVICE_ENV_FILE_VAR]: 'a.env',
      PATH: 'C:\\Windows\\System32',
    };
    applyServiceEnvFile(env, {
      readFile: files({ 'a.env': 'PATH=C:\\Git\\bin;;C:\\Git\\cmd\n' }),
      pathDelimiter: ';',
    });
    expect(env.PATH).toBe('C:\\Git\\bin;C:\\Git\\cmd;C:\\Windows\\System32');
  });

  // fails-when: the Windows spelling `Path` replaces the inherited PATH
  // (System32 drops out), or a lower-case pointer reaches the child processes.
  it('matches PATH and the pointer in any case when names ignore case', () => {
    const env: NodeJS.ProcessEnv = {
      [SERVICE_ENV_FILE_VAR]: 'a.env',
      PATH: 'C:\\Windows\\System32',
    };
    applyServiceEnvFile(env, {
      readFile: files({ 'a.env': 'Path=C:\\Git\\bin\nkici_env_file=C:\\other.env\n' }),
      pathDelimiter: ';',
      caseInsensitiveNames: true,
    });
    expect(env.PATH).toBe('C:\\Git\\bin;C:\\Windows\\System32');
    expect(env.kici_env_file).toBeUndefined();
  });

  // breaks-if-wrong: where names keep their case, `Path` is a variable of its own.
  it('keeps a differently cased PATH apart when names keep their case', () => {
    const env: NodeJS.ProcessEnv = { [SERVICE_ENV_FILE_VAR]: 'a.env', PATH: '/usr/bin' };
    applyServiceEnvFile(env, {
      readFile: files({ 'a.env': 'Path=/opt/bin\n' }),
      pathDelimiter: ':',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.Path).toBe('/opt/bin');
  });

  // breaks-if-wrong: every Linux/macOS service and every hand-run process has
  // no KICI_ENV_FILE and must start with its environment untouched.
  it('changes nothing when the variable is unset', () => {
    const env: NodeJS.ProcessEnv = { KICI_PORT: '4000', PATH: '/usr/bin' };
    const readFile = () => {
      throw new Error('must not read');
    };
    expect(applyServiceEnvFile(env, { readFile, pathDelimiter: ':' })).toBeUndefined();
    expect(env).toEqual({ KICI_PORT: '4000', PATH: '/usr/bin' });
  });

  it('refuses an unreadable file, naming the path and never the content', () => {
    const env: NodeJS.ProcessEnv = { [SERVICE_ENV_FILE_VAR]: 'C:\\missing.env' };
    expect(() => applyServiceEnvFile(env, { readFile: files({}), pathDelimiter: ';' })).toThrow(
      /KICI_ENV_FILE names C:\\missing\.env, which could not be read \(ENOENT\)/,
    );
  });

  // fails-when: a Node.js runtime variable from the file is applied in-process
  // only, where it changes nothing for the running process.
  it('reports the variables the Node.js runtime reads only as it starts', () => {
    const env: NodeJS.ProcessEnv = {
      [SERVICE_ENV_FILE_VAR]: 'a.env',
      NODE_ENV: 'production',
      UV_THREADPOOL_SIZE: '4',
    };
    const applied = applyServiceEnvFile(env, {
      readFile: files({
        'a.env': [
          'NODE_OPTIONS=--max-old-space-size=4096',
          'node_extra_ca_certs=C:\\certs\\corp.pem',
          'NODE_ENV=production',
          'UV_THREADPOOL_SIZE=16',
          'SSL_CERT_FILE=C:\\certs\\bundle.pem',
          'OPENSSL_CONF=C:\\ssl\\openssl.cnf',
          'KICI_PORT=10043',
          'TZ=UTC',
        ].join('\n'),
      }),
      pathDelimiter: ';',
    });
    // NODE_ENV already had this value, so it needs no restart.
    expect(applied?.startupKeys).toEqual([
      'NODE_OPTIONS',
      'node_extra_ca_certs',
      'UV_THREADPOOL_SIZE',
      'SSL_CERT_FILE',
      'OPENSSL_CONF',
    ]);
  });
});

describe('mustRelaunch', () => {
  const withStartupKey = { path: 'a.env', startupKeys: ['NODE_OPTIONS'] };
  const withoutStartupKey = { path: 'a.env', startupKeys: [] };

  it('relaunches on Windows when the file set a Node.js runtime variable', () => {
    expect(mustRelaunch(withStartupKey, 'win32')).toBe(true);
  });

  // breaks-if-wrong: a file with only KiCI settings keeps one process, and no
  // other platform ever starts a second one.
  it('keeps one process otherwise', () => {
    expect(mustRelaunch(withoutStartupKey, 'win32')).toBe(false);
    expect(mustRelaunch(undefined, 'win32')).toBe(false);
    expect(mustRelaunch(withStartupKey, 'linux')).toBe(false);
    expect(mustRelaunch(withStartupKey, 'darwin')).toBe(false);
  });
});

describe('relaunchWithEnv', () => {
  function deps(result: ReturnType<RelaunchDeps['spawnSync']>) {
    const listened: string[] = [];
    const order: string[] = [];
    const spawnSync = vi.fn<RelaunchDeps['spawnSync']>(() => {
      order.push('spawn');
      return result;
    });
    const d: RelaunchDeps = {
      spawnSync,
      execPath: 'C:\\node\\node.exe',
      execArgv: ['--enable-source-maps'],
      argv: ['C:\\node\\node.exe', 'C:\\kici\\lib\\kici-agent.cjs', '--flag'],
      ignoreSignal: (signal) => {
        listened.push(signal);
        order.push(`ignore:${signal}`);
      },
    };
    return { d, spawnSync, listened, order };
  }

  it('runs the same command line with the loaded environment and returns its exit code', () => {
    const env: NodeJS.ProcessEnv = { NODE_OPTIONS: '--max-old-space-size=4096' };
    const { d, spawnSync } = deps({ status: 3, signal: null });
    expect(relaunchWithEnv(env, d)).toBe(3);
    expect(spawnSync).toHaveBeenCalledWith(
      'C:\\node\\node.exe',
      ['--enable-source-maps', 'C:\\kici\\lib\\kici-agent.cjs', '--flag'],
      { stdio: 'inherit', env },
    );
  });

  // fails-when: this process keeps the default ctrl-C handling. shawl's stop
  // then ends it at once, cmd.exe and shawl report the service stopped, and the
  // child still shutting down is orphaned.
  it('ignores the stop signals before the child starts', () => {
    const { d, listened, order } = deps({ status: 0, signal: null });
    relaunchWithEnv({}, d);
    expect(listened).toEqual(['SIGINT', 'SIGBREAK']);
    expect(order.at(-1)).toBe('spawn');
  });

  it('exits non-zero when the child ends without an exit code', () => {
    const { d } = deps({ status: null, signal: 'SIGTERM' });
    expect(relaunchWithEnv({}, d)).toBe(1);
  });

  it('throws when the child cannot start', () => {
    const { d } = deps({ status: null, signal: null, error: new Error('spawn EACCES') });
    expect(() => relaunchWithEnv({}, d)).toThrow(/could not start .*node\.exe again: spawn EACCES/);
  });
});

describe('runServiceEnvLoader', () => {
  function loaderDeps(overrides: Partial<ServiceEnvLoaderDeps>) {
    const exit = vi.fn<ServiceEnvLoaderDeps['exit']>();
    const logError = vi.fn<ServiceEnvLoaderDeps['logError']>();
    const relaunch = vi.fn<ServiceEnvLoaderDeps['relaunch']>(() => 7);
    const deps: ServiceEnvLoaderDeps = {
      load: () => undefined,
      platform: 'win32',
      relaunch,
      exit,
      logError,
      ...overrides,
    };
    return { deps, exit, logError, relaunch };
  }

  // fails-when: an unreadable env file lets the service start on defaults, or
  // the line differs from the one the troubleshooting guide quotes.
  it('ends the process with code 1 and one line that names an unreadable file', () => {
    const { deps, exit, logError } = loaderDeps({
      load: () =>
        applyServiceEnvFile(
          { [SERVICE_ENV_FILE_VAR]: 'C:\\ProgramData\\kici\\o\\o.env' },
          { readFile: files({}), pathDelimiter: ';' },
        ),
    });
    runServiceEnvLoader(deps);
    expect(logError).toHaveBeenCalledWith(
      '[kici] KICI_ENV_FILE names C:\\ProgramData\\kici\\o\\o.env, which could not be read (ENOENT)',
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits with the code of the process it starts again', () => {
    const { deps, exit, relaunch } = loaderDeps({
      load: () => ({ path: 'a.env', startupKeys: ['NODE_OPTIONS'] }),
    });
    runServiceEnvLoader(deps);
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(7);
  });

  // breaks-if-wrong: a service with nothing to restart for keeps running in
  // this process.
  it('lets the process go on when there is nothing to start again', () => {
    const { deps, exit, relaunch, logError } = loaderDeps({
      load: () => ({ path: 'a.env', startupKeys: [] }),
    });
    runServiceEnvLoader(deps);
    expect(relaunch).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });
});
