---
"rrweb": patch
"@rrweb/types": patch
"@rrweb/record": patch
---

Canvas worker: downscale frames to `dataURLOptions.maxDimension`, fall back to PNG when WebP is unsupported, always reply (including errors), and build a standalone `dist/rrweb-canvas-worker.js` in `@rrweb/record`.
