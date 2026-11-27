import path from 'path';
import { build } from 'esbuild';
import type { Plugin } from 'vite';
import config from '../../vite.config.default';

const disableWorkerInlining = process.env.DISABLE_WORKER_INLINING === 'true';

function noopInlinedWorker(code) {
  // Remove the inlined Worker constructor; canvas recording uses dist/rrweb-canvas-worker.js.
  return code.replace(
    /new\s+Worker\s*\([^)]*\)/g,
    'function(){return{onerror:null,onmessage:null}}',
  );
}

const sourceEntryByPackageName = new Map([
  ['rrweb', path.resolve(__dirname, '../rrweb/src/entries/record.ts')],
  ['rrweb-snapshot', path.resolve(__dirname, '../rrweb-snapshot/src/index.ts')],
  ['rrdom', path.resolve(__dirname, '../rrdom/src/index.ts')],
]);

function buildCanvasWorker(): Plugin {
  return {
    name: 'build-canvas-worker',
    async closeBundle() {
      await build({
        absWorkingDir: __dirname,
        entryPoints: [
          '../rrweb/src/record/workers/image-bitmap-data-url-worker.ts',
        ],
        outfile: 'dist/rrweb-canvas-worker.js',
        bundle: true,
        format: 'iife',
        minify: true,
        target: 'es2017',
      });
    },
  };
}

function resolveLocalSourceEntries(): Plugin {
  return {
    name: 'resolve-local-source-entries',
    enforce: 'pre',
    resolveId(source) {
      return sourceEntryByPackageName.get(source) || null;
    },
  };
}

export default config(path.resolve(__dirname, 'src/index.ts'), 'rrwebRecord', {
  plugins: [
    resolveLocalSourceEntries(),
    buildCanvasWorker(),
    {
      name: '',
      enforce: 'post',
      renderChunk(code) {
        // The `new Worker(...)` call for a non-inlined (`?worker`) import is
        // synthesized by Rollup's asset-URL substitution during chunk
        // rendering, which runs after `transform` hooks have already
        // finished. Noop-ing it has to happen here, on the rendered chunk,
        // or the regex never sees the literal call.
        if (!disableWorkerInlining) return;
        return {
          code: noopInlinedWorker(code),
          map: null,
        };
      },
    },
  ],
});
