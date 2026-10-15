import { execSync } from 'node:child_process';
import { $, quote, usePwsh, quotePowerShell } from 'zx';

const PWSH_INSTALL_DOCS =
  'https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows';

/**
 * Initialize zx at the start of every zx entry point: sets the quote function
 * zx 8+ requires, and on Windows uses pwsh as the shell.
 */
export function initZx(): void {
  if (process.platform === 'win32') {
    try {
      usePwsh();
    } catch {
      ensurePwshWindows();
      usePwsh();
    }
    $.quote = quotePowerShell;
  } else {
    $.quote = quote;
  }
}

/**
 * Ensure pwsh is installed on Windows, via winget from the built-in
 * powershell.exe; without winget, print install instructions and exit.
 */
function ensurePwshWindows(): void {
  console.error(
    'PowerShell Core (pwsh) is required but not found in PATH.\n' +
      'KiCI uses pwsh for cross-platform command execution.\n',
  );

  let hasWinget = false;
  try {
    execSync('powershell.exe -NoProfile -Command "Get-Command winget -ErrorAction Stop"', {
      stdio: 'ignore',
      timeout: 10_000,
    });
    hasWinget = true;
  } catch {
    // winget not available
  }

  if (!hasWinget) {
    console.error(
      'Automatic installation is not possible (winget not found).\n' +
        'Please install PowerShell Core manually:\n' +
        `  ${PWSH_INSTALL_DOCS}\n`,
    );
    process.exit(1);
  }

  console.error('Attempting to install PowerShell Core via winget...\n');

  try {
    execSync(
      'powershell.exe -NoProfile -Command "winget install --id Microsoft.PowerShell --accept-source-agreements --accept-package-agreements -e --silent"',
      { stdio: 'inherit', timeout: 300_000 },
    );
  } catch {
    console.error(
      '\nAutomatic installation failed.\n' +
        'Please install PowerShell Core manually:\n' +
        `  ${PWSH_INSTALL_DOCS}\n`,
    );
    process.exit(1);
  }

  // winget updates PATH, but this process only sees pwsh through a full path
  // resolved via powershell.exe.
  try {
    const pwshPath = execSync(
      'powershell.exe -NoProfile -Command "(Get-Command pwsh -ErrorAction Stop).Source"',
      { encoding: 'utf-8', timeout: 10_000 },
    ).trim();

    if (pwshPath) {
      // So zx's which.sync('pwsh') succeeds.
      const pwshDir = pwshPath.replace(/\\pwsh\.exe$/i, '');
      process.env.PATH = `${pwshDir};${process.env.PATH}`;
    }
  } catch {
    console.error(
      '\nPowerShell Core was installed but cannot be found in PATH.\n' +
        'Please restart your terminal or add pwsh to PATH manually.\n' +
        `See: ${PWSH_INSTALL_DOCS}\n`,
    );
    process.exit(1);
  }

  console.error('PowerShell Core installed successfully.\n');
}
