import { defineConfig } from 'tsdown'

/**
 * Host-half build: plain ESM consumed by the Node loader (exports ".").
 *
 * Zero runtime @deepseek-ai imports — everything from the SDK is type-only
 * (Context merges for ctx.webServer / ctx.workspaceRegistry) and vanishes at
 * compile time, so a published copy can never shadow the CLI-internal builds
 * the base layer talks to (same lesson as dsh-taskboard's sdk.ts).
 */
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: 'esm',
    outDir: 'lib',
    outFile: 'index.js',
    clean: false,
    sourcemap: true,
    external: [/^@deepseek-ai\//],
    unbundle: true,
    target: 'node20',
    outExtensions: () => ({ js: '.js' }),
  },
  {
    entry: ['src/invariant.ts'],
    format: 'esm',
    outDir: 'lib',
    outFile: 'invariant.js',
    clean: false,
    sourcemap: true,
    external: [/^@deepseek-ai\//],
    unbundle: true,
    target: 'node20',
    outExtensions: () => ({ js: '.js' }),
  },
])
