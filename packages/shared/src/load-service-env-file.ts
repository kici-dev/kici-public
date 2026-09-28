/**
 * Import this module FIRST in a service entry point. It applies the env file
 * `KICI_ENV_FILE` names before any other module evaluates, so every module that
 * reads the environment, at load time or later, sees the file's values.
 *
 * When the file changes a variable the Node.js runtime reads only as it starts
 * (`NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, …), a Windows service starts its own
 * command again with the loaded environment and waits for it, so no other
 * module runs in this process.
 *
 * An unreadable file stops the process: a service that started without its
 * configuration would run with defaults the operator never chose.
 */

import { runServiceEnvLoader } from './service-env-file.js';

runServiceEnvLoader();
