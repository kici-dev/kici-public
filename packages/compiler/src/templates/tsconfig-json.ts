/**
 * tsconfig.json template for kici init command
 *
 * Exported as a JSON string that matches examples/tsconfig.json exactly.
 * These settings enable proper TypeScript type checking for workflow files
 * with NodeNext module resolution.
 */
export const tsconfigTemplate =
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2024',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
      },
      include: ['workflows/**/*', 'types/**/*.d.ts'],
    },
    null,
    2,
  ) + '\n';
