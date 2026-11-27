---
"rrweb": patch
---

Canvas FPS recording: add `canvasOptions` (`workerFactory`, `fallbackMaxFps`, `initialSnapshotDelayMs`, `forcePreserveDrawingBuffer`), fall back to main-thread encoding at 1 fps when the worker can't start, skip hidden tabs and unserialized, empty or detached canvases, keep one frame in flight per canvas, and draw frames at the canvas size.
