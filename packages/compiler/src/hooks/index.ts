export { detectHookTools, findGitDir, findGitRoot } from './detector.js';
export type { HookTool, HookToolName } from './detector.js';
export { getHookTemplate, hasKiciHook, KICI_HOOK_MARKER } from './templates.js';
export { installHook } from './installer.js';
export type { InstallResult, InstallOptions } from './installer.js';
