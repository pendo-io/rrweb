import path from 'path';
import type { Plugin } from 'vite';
import config from '../../vite.config.default';

const disableWorkerInlining = process.env.DISABLE_WORKER_INLINING === 'true';

function noopInlinedWorker(code) {
  // **NOTE** If we ever intend to enable canvas recording, this will need to be removed or modified
  // Remove the inlined Worker constructor and replace with noop. This code only gets called when canvas
  // recording is enabled, which we currently do not support enabling.
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
