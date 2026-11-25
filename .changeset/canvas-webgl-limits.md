---
"rrweb": minor
"@rrweb/types": minor
"rrweb-snapshot": patch
---

Canvas FPS recording: never clear the page's WebGL canvas, make `preserveDrawingBuffer` forcing switchable (`canvasOptions.forcePreserveDrawingBuffer`), detect WebGL contexts created before recording, emit a `rrweb-canvas-status` custom event when a canvas can't be read (blank WebGL, tainted, encode error), sample at most `canvasOptions.maxCanvases` canvases (default 5, also when `canvasOptions` is not set), and add `record.stopCanvas()` to stop canvas recording (FPS frames and canvas pixels in later snapshots) while the rest keeps recording. A tainted canvas no longer breaks the snapshot: it is serialized without an image and gets the `tainted` status.
