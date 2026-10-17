import { normalizeMiseVersion } from '@kici-dev/sdk/internal';

/** OS-specific pieces of a mise init expansion. */
export interface MiseTemplate {
  /** The `run` command. */
  run: string;
  /** Shell to run it with. */
  shell: string;
  /** Cache `paths` for mise's data dir on this OS. */
  cachePaths: string[];
}

const BASH_LATEST_INSTALL = `command -v mise >/dev/null || curl -fsSL https://mise.run | sh
export PATH="$HOME/.local/bin:$PATH"`;

// A pinned mise lives in a KiCI-owned, per-version directory. The installer
// writes a partial file that is moved into place, so a concurrent job never
// runs a half-written binary, and a binary already at the release is reused.
const BASH_PINNED_INSTALL = `kici_mise_want='<MISE_VERSION>'
kici_mise_dir="$HOME/.local/share/kici/mise/$kici_mise_want"
kici_mise_version() { "$1" --version 2>/dev/null | head -n1 | cut -d' ' -f1 | sed 's/^v//' || true; }
if [ "$(kici_mise_version "$kici_mise_dir/mise")" != "$kici_mise_want" ]; then
  mkdir -p "$kici_mise_dir"
  curl -fsSL https://mise.run \\
    | MISE_VERSION="v$kici_mise_want" MISE_INSTALL_PATH="$kici_mise_dir/mise.partial.$$" sh
  mv -f "$kici_mise_dir/mise.partial.$$" "$kici_mise_dir/mise"
fi
# The pinned directory goes first on PATH: ahead of any mise on the host and
# ahead of a PATH set in the init's env.
export PATH="$kici_mise_dir:$PATH"
kici_mise_got="$(kici_mise_version mise)"
if [ "$kici_mise_got" != "$kici_mise_want" ]; then
  echo "mise version mismatch: init pins $kici_mise_want, mise on PATH reports '$kici_mise_got'" >&2
  exit 1
fi`;

const BASH_INSTALL_TOOLS = `# Trust the committed config at the clone root (CWD): mise refuses to load an
# untrusted config, and the author committing it to their repo is the trust signal.
mise trust
mise install
# Source mise's exports in a subshell so bash removes mise's shell quoting, then
# write each value as a plain KEY=value line. PATH is handed off via $KICI_PATH.
kici_mise_env="$(mktemp)"
mise env -s bash | sed '/^export PATH=/d' > "$kici_mise_env"
(
  . "$kici_mise_env"
  sed -n 's/^export \\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p' "$kici_mise_env" | while read -r kici_key; do
    printf '%s=%s\\n' "$kici_key" "$(printenv "$kici_key")"
  done
) >> "$KICI_ENV"
rm -f "$kici_mise_env"`;

const BASH_PINNED_PATH = `echo "$kici_mise_dir" >> "$KICI_PATH"`;
const BASH_SHIMS_PATH = `echo "$HOME/.local/share/mise/shims" >> "$KICI_PATH"`;
// The PATH the init started with. Steps start from the same PATH, so a mise
// directory already on it needs no entry in $KICI_PATH. A PATH set in the
// init's env never reaches steps: then the entry PATH is empty and the mise
// directory is always added.
function bashEntryPath(initSetsPath: boolean): string {
  return initSetsPath ? `kici_mise_entry_path=''` : `kici_mise_entry_path="$PATH"`;
}
// The mise CLI for steps: the directory of the mise this init ran, when steps
// cannot already find it. It goes after the shims dir, so a tool mise manages
// still resolves through its shim. The assignments fail the init when mise
// does not resolve.
const BASH_RESOLVED_MISE_PATH = `kici_mise_cli="$(command -v mise)"
kici_mise_cli_dir="$(dirname "$kici_mise_cli")"
case ":$kici_mise_entry_path:" in
  *":$kici_mise_cli_dir:"*) ;;
  *) echo "$kici_mise_cli_dir" >> "$KICI_PATH" ;;
esac`;

function bashRun(version: string | undefined, initSetsPath: boolean): string {
  const pinned = version !== undefined;
  return [
    'set -euo pipefail',
    ...(pinned ? [] : [bashEntryPath(initSetsPath)]),
    pinned ? BASH_PINNED_INSTALL.replaceAll('<MISE_VERSION>', version) : BASH_LATEST_INSTALL,
    BASH_INSTALL_TOOLS,
    ...(pinned ? [BASH_PINNED_PATH] : []),
    BASH_SHIMS_PATH,
    ...(pinned ? [] : [BASH_RESOLVED_MISE_PATH]),
  ].join('\n');
}

const PWSH_PRELUDE = `$ErrorActionPreference = 'Stop'
# mise writes informational output (\`mise trusted …\`, install progress) to
# stderr even on success. Under \`$ErrorActionPreference = 'Stop'\` PowerShell
# turns any native-command stderr line into a terminating error, so a
# successful \`mise trust\` would abort the step. Run each mise invocation with
# the preference relaxed and gate on the real exit code via \`$LASTEXITCODE\`.
function Invoke-Mise {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]] $MiseArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & mise @MiseArgs 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  if ($code -ne 0) {
    throw "mise $($MiseArgs -join ' ') failed (exit $code): $($output -join ' | ')"
  }
  return $output
}`;

const PWSH_LATEST_INSTALL = `if (-not (Get-Command mise -ErrorAction SilentlyContinue)) {
  # The standalone Windows zip extracts to mise/bin/mise.exe, so prepend the
  # nested bin dir (not the extraction root) to PATH.
  $dest = Join-Path $env:USERPROFILE '.local\\mise'
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $zip = Join-Path $env:TEMP 'mise.zip'
  Invoke-WebRequest -Uri '<ASSET_URL>' -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $dest -Force
  $env:PATH = "$dest\\mise\\bin;$env:PATH"
}`;

// A pinned mise lives in a KiCI-owned, per-version directory, extracted to a
// partial dir first and moved into place. A binary already at the release is reused.
const PWSH_PINNED_INSTALL = `$kiciMiseWant = '<MISE_VERSION>'
$kiciMiseDir = Join-Path $env:USERPROFILE ".local\\share\\kici\\mise\\$kiciMiseWant"
$kiciMiseBin = Join-Path $kiciMiseDir 'mise\\bin'
function Get-KiciMiseVersion {
  param([string] $Exe)
  if (-not $Exe -or -not (Test-Path $Exe)) { return '' }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & $Exe --version 2>$null } finally { $ErrorActionPreference = $prev }
  return ((("$($out | Select-Object -First 1)") -split ' ')[0]) -replace '^v', ''
}
if ((Get-KiciMiseVersion (Join-Path $kiciMiseBin 'mise.exe')) -ne $kiciMiseWant) {
  $kiciMisePartial = "$kiciMiseDir.partial.$PID"
  New-Item -ItemType Directory -Force -Path $kiciMisePartial | Out-Null
  $zip = Join-Path $env:TEMP "mise-$kiciMiseWant-$PID.zip"
  Invoke-WebRequest -Uri '<ASSET_URL>' -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $kiciMisePartial -Force
  if (Test-Path $kiciMiseDir) { Remove-Item -Recurse -Force -Path $kiciMiseDir }
  Move-Item -Path $kiciMisePartial -Destination $kiciMiseDir
}
# The pinned directory goes first on PATH: ahead of any mise on the host and
# ahead of a PATH set in the init's env.
$env:PATH = "$kiciMiseBin;$env:PATH"
$kiciMiseGot = Get-KiciMiseVersion (Get-Command mise -ErrorAction SilentlyContinue).Source
if ($kiciMiseGot -ne $kiciMiseWant) {
  throw "mise version mismatch: init pins $kiciMiseWant, mise on PATH reports '$kiciMiseGot'"
}`;

const PWSH_INSTALL_TOOLS = `# Trust the committed config at the clone root (CWD) — mise refuses to load an
# untrusted config; the author committing it to their repo is the trust signal.
Invoke-Mise trust | Out-Null
Invoke-Mise install | Out-Null
Invoke-Mise env -s pwsh | ForEach-Object {
  if ($_ -match '^\\$env:([^=]+) = ''(.*)''$' -and $Matches[1] -ne 'PATH') { "$($Matches[1])=$($Matches[2] -replace "''", "'")" }
} | Add-Content -Path $env:KICI_ENV`;

const PWSH_PINNED_PATH = `Add-Content -Path $env:KICI_PATH -Value $kiciMiseBin`;

const PWSH_BIN_PATHS = `# Add the real tool install dirs (not the shims dir): the shim wrappers
# re-invoke mise, and bin-paths points straight at the installed binaries.
Invoke-Mise bin-paths | Add-Content -Path $env:KICI_PATH`;

// The PATH the init started with; see bashEntryPath.
function pwshEntryPath(initSetsPath: boolean): string {
  return initSetsPath ? `$miseEntryPath = ''` : `$miseEntryPath = $env:PATH`;
}
// The mise CLI for steps: the directory of the mise this init ran, after the
// tool dirs, when the entry PATH does not already hold it. Windows paths
// compare without case and without a trailing backslash.
const PWSH_RESOLVED_MISE_PATH = `$miseCli = (Get-Command mise -CommandType Application | Select-Object -First 1).Source
$miseCliDir = (Split-Path -Parent $miseCli).TrimEnd('\\')
$miseEntryDirs = @($miseEntryPath -split ';' | ForEach-Object { $_.TrimEnd('\\') })
if ($miseEntryDirs -notcontains $miseCliDir) { Add-Content -Path $env:KICI_PATH -Value $miseCliDir }`;

function pwshRun(version: string | undefined, initSetsPath: boolean): string {
  const pinned = version !== undefined;
  return [
    PWSH_PRELUDE,
    ...(pinned ? [] : [pwshEntryPath(initSetsPath)]),
    pinned ? PWSH_PINNED_INSTALL.replaceAll('<MISE_VERSION>', version) : PWSH_LATEST_INSTALL,
    PWSH_INSTALL_TOOLS,
    ...(pinned ? [PWSH_PINNED_PATH] : []),
    PWSH_BIN_PATHS,
    ...(pinned ? [] : [PWSH_RESOLVED_MISE_PATH]),
  ].join('\n');
}

/**
 * Pick the mise template for a host platform (Node `process.platform` value),
 * pinned to `version` (bare, like `2026.5.1`) when given. The Windows `run`
 * carries an `<ASSET_URL>` placeholder the expander replaces with the resolved
 * GitHub-release zip URL (the pinned tag, or the latest release). `initSetsPath`
 * says the preset's `env` sets PATH for the init command, so the init's PATH
 * is not the PATH steps start from.
 */
export function selectMiseTemplate(
  platform: NodeJS.Platform,
  version?: string,
  initSetsPath = false,
): MiseTemplate {
  // The version is substituted into a shell script: accept only a bare release.
  if (version !== undefined && normalizeMiseVersion(version) !== version) {
    throw new Error(`invalid mise version for the preset template: ${JSON.stringify(version)}`);
  }
  if (platform === 'win32') {
    return {
      run: pwshRun(version, initSetsPath),
      shell: 'pwsh',
      cachePaths: ['~/AppData/Local/mise'],
    };
  }
  if (platform === 'linux' || platform === 'darwin') {
    return {
      run: bashRun(version, initSetsPath),
      shell: 'bash',
      cachePaths: ['~/.local/share/mise'],
    };
  }
  throw new Error(`unsupported platform for mise preset: ${platform}`);
}
