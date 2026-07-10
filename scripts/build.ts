import { execFileSync } from 'child_process';
import { type BuildOptions, build } from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

const srcDir = join(process.cwd(), 'src');
const distDir = join(process.cwd(), 'dist');
const esmDir = join(distDir, '_esm');
const cjsDir = join(distDir, '_cjs');
const typesDir = join(distDir, '_types');

// Ensure output directories exist
mkdirSync(esmDir, { recursive: true });
mkdirSync(cjsDir, { recursive: true });
mkdirSync(typesDir, { recursive: true });

// Shared build configuration
const baseConfig: Partial<BuildOptions> = {
  sourcemap: false,
  minify: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  keepNames: false,
};

const bundledConfig: Partial<BuildOptions> = {
  ...baseConfig,
  bundle: true,
  external: ['node:*'],
};

const compressorConfig: Partial<BuildOptions> = {
  ...baseConfig,
  bundle: true,
  platform: 'neutral',
  target: ['es2020'],
};

async function buildAll() {
  console.log('Building ESM bundles...');

  await build({
    ...bundledConfig,
    entryPoints: [join(srcDir, 'index.ts')],
    format: 'esm',
    platform: 'browser',
    target: ['chrome80', 'edge80', 'firefox113', 'safari16.4'],
    outfile: join(esmDir, 'index.js'),
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  });

  await build({
    ...compressorConfig,
    entryPoints: [join(srcDir, 'jit-compressor.ts')],
    format: 'esm',
    outfile: join(esmDir, 'jit-compressor.js'),
  });

  console.log('Building CJS bundles...');

  await build({
    ...bundledConfig,
    entryPoints: [join(srcDir, 'index.ts')],
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    outfile: join(cjsDir, 'index.cjs'),
  });

  await build({
    ...compressorConfig,
    entryPoints: [join(srcDir, 'jit-compressor.ts')],
    format: 'cjs',
    outfile: join(cjsDir, 'jit-compressor.cjs'),
  });

  console.log('Generating TypeScript declarations...');

  execFileSync('tsc', ['--emitDeclarationOnly', '--declaration', '--outDir', typesDir], {
    stdio: 'inherit',
  });
  
  const rewriteDtsExtensions = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) rewriteDtsExtensions(full);
      else if (name.endsWith('.d.ts')) {
        const src = readFileSync(full, 'utf8');
        const out = src.replace(/(['"]\.\.?\/[^'"]*)\.ts(['"])/g, '$1.js$2');
        if (out !== src) writeFileSync(full, out);
      }
    }
  };
  rewriteDtsExtensions(typesDir);

  console.log('Copying package.json, README and LICENSE to dist...');

  copyFileSync(join(process.cwd(), 'package.json'), join(distDir, 'package.json'));
  copyFileSync(join(process.cwd(), 'README.md'), join(distDir, 'README.md'));
  copyFileSync(join(process.cwd(), 'LICENSE'), join(distDir, 'LICENSE'));

  console.log('Build complete!');
}

buildAll().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
