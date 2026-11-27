# Canvas

Canvas is a special HTML element, and will not be recorded by rrweb by default.
There are some options for recording and replaying Canvas.

Enable recording Canvas：

```js
import { record } from '@rrweb/record';

record({
  emit(event) {},
  recordCanvas: true,
});
```

Alternatively enable image snapshot recording of Canvas at a maximum of 15 frames per second：

```js
import { record } from '@rrweb/record';

record({
  emit(event) {},
  recordCanvas: true,
  sampling: {
    canvas: 15,
  },
  // optional image format settings
  dataURLOptions: {
    type: 'image/webp',
    quality: 0.6,
  },
});
```

With image snapshots, a WebGL canvas that reads back fully transparent is reported once as `webgl-blank` in the `rrweb-canvas-status` custom event and keeps its last frame in replay. This also happens when the app really clears the canvas to transparent, so a cleared canvas replays as its last drawn frame.

Enable replaying Canvas：

```js
import { Replayer } from '@rrweb/replay';

const replayer = new Replayer(events, {
  UNSAFE_replayCanvas: true,
});
replayer.play();
```

**Enabling canvas replay adds `allow-scripts` to the replay iframe and opts out of rrweb's sandbox script-execution protection. Only use `UNSAFE_replayCanvas` for replay data whose risk you accept.**

Alternatively you can stream canvas elements via webrtc with the [rrweb-plugin-canvas-webrtc-record](../../packages/plugins/rrweb-plugin-canvas-webrtc-record/) & [rrweb-plugin-canvas-webrtc-replay](../../packages/plugins/rrweb-plugin-canvas-webrtc-replay) plugins.
For more information see [canvas-webrtc documentation](../../packages/plugins/rrweb-plugin-canvas-webrtc-record/README.md)
