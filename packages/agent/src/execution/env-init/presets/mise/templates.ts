/** OS-specific pieces of a mise init expansion. */
export interface MiseTemplate {
  /** The `run` command. */
  run: string;
  /** Shell to run it with. */
  shell: string;
  /** Cache `paths` for mise's data dir on this OS. */
  cachePaths: string[];
}

const BASH_RUN = `set -euo pipefail
command -v mise >/dev/null || curl -fsSL https://mise.run | sh
export PATH="$HOME/.local/bin:$PATH"
# Trust the committed config at the clone root (CWD): mise refuses to load an
# untrusted config, and the author committing it to their repo is the trust signal.
mise trust
mise install
mise env -s bash | sed -n 's/^export //p' | sed '/^PATH=/d' \\
  | sed -E 's/^([A-Za-z_][A-Za-z0-9_]*)="(.*)"$/\\1=\\2/' >> "$KICI_ENV"
echo "$HOME/.local/share/mise/shims" >> "$KICI_PATH"`;

// The Windows install resolves the latest mise zip via windows-install.ts at
// expand time and substitutes the URL into the <ASSET_URL> placeholder; see
// expander.ts.
const PWSH_RUN = `$ErrorActionPreference = 'Stop'
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
}
if (-not (Get-Command mise -ErrorAction SilentlyContinue)) {
  # The standalone Windows zip extracts to mise/bin/mise.exe, so prepend the
  # nested bin dir (not the extraction root) to PATH.
  $dest = Join-Path $env:USERPROFILE '.local\\mise'
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $zip = Join-Path $env:TEMP 'mise.zip'
  Invoke-WebRequest -Uri '<ASSET_URL>' -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $dest -Force
  $env:PATH = "$dest\\mise\\bin;$env:PATH"
}
# Trust the committed config at the clone root (CWD) — mise refuses to load an
# untrusted config; the author committing it to their repo is the trust signal.
Invoke-Mise trust | Out-Null
Invoke-Mise install | Out-Null
Invoke-Mise env -s pwsh | ForEach-Object {
  if ($_ -match '^\\$env:([^=]+) = ''(.*)''$' -and $Matches[1] -ne 'PATH') { "$($Matches[1])=$($Matches[2])" }
} | Add-Content -Path $env:KICI_ENV
# Add the real tool install dirs (not the shims dir): the standalone mise lives
# in a temp dir that is gone by step time, so the shim wrappers (which re-invoke
# mise) cannot resolve it. bin-paths points straight at the installed binaries.
Invoke-Mise bin-paths | Add-Content -Path $env:KICI_PATH`;

/**
 * Pick the mise template for a host platform (Node `process.platform` value).
 * The Windows `run` carries an `<ASSET_URL>` placeholder the expander replaces
 * with the resolved GitHub-release zip URL.
 */
export function selectMiseTemplate(platform: NodeJS.Platform): MiseTemplate {
  if (platform === 'win32') {
    return { run: PWSH_RUN, shell: 'pwsh', cachePaths: ['~/AppData/Local/mise'] };
  }
  if (platform === 'linux' || platform === 'darwin') {
    return { run: BASH_RUN, shell: 'bash', cachePaths: ['~/.local/share/mise'] };
  }
  throw new Error(`unsupported platform for mise preset: ${platform}`);
}
