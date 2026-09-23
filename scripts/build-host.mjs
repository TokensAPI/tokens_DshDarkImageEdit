import { build } from 'esbuild'

await build({
  entryPoints: ['src/host/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  external: ['@deepseek-ai/*', 'node:*'],
  logLevel: 'info',
})
