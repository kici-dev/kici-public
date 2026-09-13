import { z } from 'zod';

/**
 * Where an orchestrator's own configuration lives on its host, so an operator
 * reading the dashboard knows which files to inspect.
 *
 * Every value is an absolute HOST path, and every field is optional. An absent
 * field means "not reported" and never "no such file": a `composeFile` that is
 * missing does not imply the deployment is not compose, it implies the
 * orchestrator did not say.
 *
 * Paths only — no layer ever carries the contents of these files, which hold
 * the database URL and the Platform token.
 */
export const ConfigPathsSchema = z.object({
  /** The env file the service manager loads (`EnvironmentFile=` / `env_file:`). */
  envFile: z.string().min(1).optional(),
  /** The scaler YAML file, or the directory when only a directory is configured. */
  scalerConfig: z.string().min(1).optional(),
  /** The generated compose file, for a compose deployment. */
  composeFile: z.string().min(1).optional(),
});
export type ConfigPaths = z.infer<typeof ConfigPathsSchema>;
