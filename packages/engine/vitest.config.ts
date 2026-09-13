import '../../hack/lib/vitest-isolation.ts';
import { defineConfig } from 'vitest/config';

// This package previously ran a bare `vitest run` with no config file, so
// nothing could set the test-isolation marker for it. An empty config keeps
// vitest's default `include`/`exclude` and exists only to carry the import.
export default defineConfig({});
