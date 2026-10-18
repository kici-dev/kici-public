/**
 * The conclusions the GitHub check-run reporter sends: the provider-neutral
 * `CheckRunConclusion` set plus GitHub's own `skipped`, which a required check
 * accepts like `success`. Local to the reporter so `CheckRunConclusion` and its
 * other consumers keep their vocabulary.
 */
import { z } from 'zod';
import { CheckRunConclusion } from '@kici-dev/engine';

export const GithubCheckConclusion = z.enum([...CheckRunConclusion.options, 'skipped']);
export type GithubCheckConclusion = z.infer<typeof GithubCheckConclusion>;
