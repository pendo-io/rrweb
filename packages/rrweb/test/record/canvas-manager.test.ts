/**
 * @vitest-environment jsdom
 */
import { createMirror } from 'rrweb-snapshot';
import { vi } from 'vitest';
import { CanvasManager } from '../../src/record/observers/canvas/canvas-manager';
import type { CanvasOptions } from '../../src/types';

const { encoder, inlineWorker, realEncoder } = vi.hoisted(() => ({
  encoder: { encode: vi.fn(), forget: vi.fn(), reset: vi.fn() },
  inlineWorker: vi.fn(),
  realEncoder: { canvas: null as unknown },
}));
vi.mock('../../src/record/workers/frame-encoder', async (importActual) => {
  const actual = await importActual<
    typeof import('../../src/record/workers/frame-encoder')
  >();
  return {
    FrameEncoder: function () {
      const { canvas } = realEncoder;
      return canvas ? new actual.FrameEncoder(canvas as never) : encoder;
    },
  };
});
vi.mock(
  '../../src/record/workers/image-bitmap-data-url-worker?worker&inline',
  () => ({ default: inlineWorker }),
);

const FRAME = { status: 'frame', type: 'image/webp', base64: 'AA==' };
const bitmap = { close: vi.fn() };
const mirror = createMirror();
let rafs: FrameRequestCallback[];
let worker: Record<string, any>;
let mutationCb: ReturnType<typeof vi.fn>;
let statusCb: ReturnType<typeof vi.fn>;
let manager: CanvasManager;
let nextId: number;

const addCanvas = (width = 100, height = 50, id = nextId++) => {
  const canvas = document.createElement('canvas');
  document.body.appendChild(Object.assign(canvas, { width, height }));
  if (id !== -1) mirror.add(canvas, { id } as never);
  return canvas;
};
const start = (canvasOptions?: CanvasOptions, sampling = 2) => {
  manager = new CanvasManager({
    recordCanvas: true,
    mutationCb,
    statusCb,
    win: window as never,
    blockClass: 'rr-block',
    blockSelector: null,
    mirror,
    sampling,
    dataURLOptions: { maxDimension: 480 },
    canvasOptions,
  });
  vi.advanceTimersByTime(0);
};
const tick = async (...times: number[]) => {
  for (const time of times) {
    vi.setSystemTime(time);
    rafs.splice(0).forEach((cb) => cb(time));
    for (let i = 0; i < 50; i++) await Promise.resolve();
  }
};
const encodes = () =>
  worker.postMessage.mock.calls.filter(([m]) => m.kind === 'encode').length;
const reply = (data: object) => worker.onmessage({ data: { id: 1, ...data } });
const throwing = () => {
  throw new DOMException('', 'SecurityError');
};
const encodedIds = () =>
  worker.postMessage.mock.calls
    .filter(([m]) => m.kind === 'encode')
    .map(([m]) => m.id);
const statuses = () =>
  statusCb.mock.calls.map(
    ([p]) => `${p.id} ${p.reason ?? p.status} ${p.context} ${p.width}`,
  );
const webgl = (canvas: HTMLCanvasElement, preserveDrawingBuffer: boolean) => {
  const attrs = { preserveDrawingBuffer };
  const gl = { getContextAttributes: () => attrs };
  Object.assign(canvas, { __context: 'webgl', getContext: () => gl });
};
const drawArgs = (n: number) =>
  mutationCb.mock.calls[n][0].commands[1].args.slice(1);
const drawnPixels = () =>
  mutationCb.mock.calls.map(([m]) =>
    atob(m.commands[1].args[0].args[0].data[0].base64),
  );
const useRealEncoder = (labels: string[]) => {
  let pixels = '';
  let width = 1;
  realEncoder.canvas = {
    height: 1,
    get width() {
      return width;
    },
    set width(w: number) {
      [width, pixels] = [w, ''];
    },
    getContext: () => ({
      drawImage: (s) => (pixels = s.label),
      clearRect: () => (pixels = ''),
    }),
    convertToBlob: async () => {
      const data = new TextEncoder().encode(pixels);
      return { type: 'image/png', arrayBuffer: async () => data.buffer };
    },
  };
  vi.mocked(createImageBitmap).mockImplementation(
    async () => ({ label: labels.shift(), close: vi.fn() } as never),
  );
  inlineWorker.mockImplementation(function () {
    return {};
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  [rafs, nextId] = [[], 1];
  vi.stubGlobal('requestAnimationFrame', (cb) => rafs.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => (rafs = []));
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
  encoder.encode.mockReset().mockImplementation(async (id, _, w, h) => {
    return { id, width: w, height: h, ...FRAME };
  });
  worker = { postMessage: vi.fn(), terminate: vi.fn() };
  inlineWorker.mockReset().mockImplementation(function () {
    return worker;
  });
  realEncoder.canvas = null;
  mutationCb = vi.fn();
  statusCb = vi.fn();
  document.body.innerHTML = '';
  mirror.reset();
});
afterEach(() => {
  manager.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('CanvasManager FPS observer', () => {
  it('uses the built-in worker and draws frames at backing size', async () => {
    addCanvas(2000, 1000);
    start();
    await tick(1000);
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, bitmap, width: 2000, skipBlank: false }),
      [bitmap],
    );
    for (const [i, status] of ['unchanged', 'blank', 'error'].entries()) {
      reply({ status });
      await tick(1500 + 500 * i);
    }
    expect([encodes(), mutationCb.mock.calls.length]).toEqual([4, 0]);
    reply({ width: 2000, height: 1000, ...FRAME });
    expect(drawArgs(0)).toEqual([0, 0, 2000, 1000]);
  });

  it('keeps one picture in flight per canvas until the worker replies', async () => {
    addCanvas();
    start();
    await tick(1000, 1100, 1499, 3000, 5500, 6500, 12000);
    expect(encodes()).toBe(1);
    reply({ status: 'unchanged' });
    await tick(12500);
    expect(encodes()).toBe(2);
  });

  it('skips hidden tabs, then resumes', async () => {
    addCanvas();
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    start();
    visibility.mockReturnValue('hidden');
    await tick(1000);
    expect(createImageBitmap).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    await tick(1100);
    expect(encodes()).toBe(1);
  });

  it('skips unserialized, empty, blocked, detached and failing canvases', async () => {
    addCanvas(100, 50, -1);
    addCanvas(0, 50);
    addCanvas(100, 0);
    addCanvas().className = 'rr-block';
    const first = addCanvas();
    const detached = addCanvas();
    vi.mocked(createImageBitmap).mockImplementationOnce(async () => {
      detached.remove();
      throw new Error();
    });
    start();
    await tick(1000, 1500);
    expect(vi.mocked(createImageBitmap).mock.calls).toEqual([[first], [first]]);
  });

  it('creates one bitmap at a time and never overlaps ticks', async () => {
    addCanvas();
    addCanvas();
    let resolve = (_: unknown) => undefined;
    vi.mocked(createImageBitmap).mockImplementation(
      () => new Promise((r) => (resolve = r)),
    );
    start({}, 8);
    await tick(1000, 2000);
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    resolve(bitmap);
    await tick(2001);
    expect(createImageBitmap).toHaveBeenCalledTimes(2);
  });

  it('forgets removed canvases and resets on full snapshot', async () => {
    const canvas = addCanvas();
    start();
    await tick(1000);
    canvas.remove();
    await tick(1500);
    manager.onFullSnapshot();
    expect(worker.postMessage.mock.calls.slice(1)).toEqual([
      [{ kind: 'forget', id: 1 }],
      [{ kind: 'reset' }],
    ]);
  });

  it('forgets removed canvases on the main thread', async () => {
    const canvas = addCanvas();
    start({ workerFactory: throwing });
    await tick(1000);
    canvas.remove();
    await tick(2000);
    expect(encoder.forget).toHaveBeenCalledWith(1);
  });

  it.each([
    [throwing, 4, undefined, 2],
    [() => ({ onmessage: null }), 8, 3, 3],
    [() => undefined, 0.5, undefined, 1],
    [undefined, 4, 1, 2],
    [undefined, 4, 0, 2],
    [undefined, 4, -1, 2],
  ])('falls back to the main thread (%#)', async (f, fps, max, n) => {
    inlineWorker.mockImplementation(function () {
      return {};
    });
    addCanvas(800, 400);
    start({ workerFactory: f as never, fallbackMaxFps: max }, fps);
    for (let t = 1000; t <= 2000; t += 25) await tick(t);
    expect(encoder.encode).toHaveBeenCalledTimes(n);
    expect(bitmap.close).toHaveBeenCalledTimes(n);
    expect(drawArgs(0)).toEqual([0, 0, 800, 400]);
  });

  it('switches to the main thread when the worker fails to load', async () => {
    addCanvas();
    start({ workerFactory: () => worker as never });
    await tick(1000);
    worker.onerror();
    expect(worker.terminate).toHaveBeenCalled();
    await tick(2000);
    expect([encodes(), encoder.encode.mock.calls.length]).toEqual([1, 1]);
    manager.onFullSnapshot();
    expect(encoder.reset).toHaveBeenCalled();
  });

  it('waits initialSnapshotDelayMs, and stops cleanly', async () => {
    addCanvas();
    start({ initialSnapshotDelayMs: 1000 });
    expect(rafs).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    await tick(1000);
    expect(encodes()).toBe(1);
    manager.reset();
    expect([rafs.length, worker.terminate.mock.calls.length]).toEqual([0, 1]);
    reply({ width: 1, height: 1, ...FRAME });
    expect(mutationCb).not.toHaveBeenCalled();
  });

  it('stops sampling the remaining canvases when stopped mid-tick', async () => {
    addCanvas();
    addCanvas();
    let resolve = (_: unknown) => undefined;
    vi.mocked(createImageBitmap).mockImplementation(
      () => new Promise((r) => (resolve = r)),
    );
    start();
    await tick(1000);
    manager.reset();
    resolve(bitmap);
    await tick(1001);
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 0, -1, 2.5, NaN, '3'])(
    'samples at most 5 canvases when maxCanvases is %s',
    async (maxCanvases) => {
      for (let i = 0; i < 6; i++) addCanvas();
      start({ maxCanvases: maxCanvases as never });
      await tick(1000);
      expect(encodedIds()).toEqual([1, 2, 3, 4, 5]);
    },
  );

  it('samples every canvas when maxCanvases is Infinity', async () => {
    for (let i = 0; i < 6; i++) addCanvas();
    start({ maxCanvases: Infinity });
    await tick(1000);
    expect(encodedIds()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('keeps sampled canvases in their slot and frees removed ones', async () => {
    const canvases = Array.from({ length: 3 }, () => addCanvas());
    start({ maxCanvases: 2 });
    await tick(1000);
    document.body.prepend(addCanvas(10, 10, 9));
    canvases[0].remove();
    for (const id of [1, 2]) reply({ id, status: 'unchanged' });
    await tick(1500);
    expect(encodedIds()).toEqual([1, 2, 2, 9]);
  });

  it('reports a status once per change, and again after a full snapshot', async () => {
    const canvas = addCanvas();
    start();
    for (let t = 1000; t <= 3000; t += 500) {
      await tick(t);
      reply({ status: 'error', reason: 'tainted' });
    }
    expect([encodes(), statuses()]).toEqual([1, ['1 tainted unknown 100']]);
    Object.assign(canvas, { __context: '2d' });
    manager.onFullSnapshot();
    await tick(3500);
    reply({ status: 'error', reason: 'tainted' });
    await tick(4000);
    reply({ width: 100, height: 50, ...FRAME });
    expect(statuses().slice(1)).toEqual([
      '1 tainted 2d 100',
      '1 readable 2d 100',
    ]);
  });

  it('reports blank WebGL canvases without preserveDrawingBuffer only', async () => {
    webgl(addCanvas(), false);
    webgl(addCanvas(), true);
    addCanvas();
    start();
    await tick(1000);
    for (const id of [1, 2, 3]) reply({ id, status: 'blank' });
    await tick(1500);
    for (const id of [1, 2, 3]) reply({ id, status: 'unchanged' });
    expect(statuses()).toEqual(['1 webgl-blank webgl 100']);
  });

  it('never draws blank replies and keeps unreadable WebGL until the next full snapshot', async () => {
    webgl(addCanvas(), false);
    start();
    for (const status of ['blank', 'blank', 'frame', 'blank', 'blank']) {
      await tick(1000);
      reply({ width: 100, height: 50, ...FRAME, status });
    }
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'encode', skipBlank: true }),
      [bitmap],
    );
    expect(mutationCb).toHaveBeenCalledTimes(1);
    expect(statuses()).toEqual(['1 webgl-blank webgl 100']);
  });

  it.each([
    ['unreadable', ['', '', 'a', '', 'a', 'b'], ['a', 'b'], ['webgl-blank']],
    ['unreadable', ['a', '', '', 'a', 'b'], ['a', 'b'], ['webgl-blank']],
    ['unreadable', ['', '', ''], [], ['webgl-blank']],
    ['readable', ['a', '', 'a', '', 'b'], ['a', '', 'a', '', 'b'], []],
    ['readable', ['', '', 'a'], ['a'], []],
    ['2d', ['a', '', 'a', '', 'b'], ['a', '', 'a', '', 'b'], []],
    ['2d', ['', '', 'a'], ['a'], []],
  ])(
    'main thread: %s canvas samples %j draw %j and report %j',
    async (kind, labels, drawn, reasons) => {
      useRealEncoder([...labels]);
      const canvas = addCanvas();
      if (kind !== '2d') webgl(canvas, kind === 'readable');
      start();
      for (let i = 0; i < labels.length; i++) await tick(1000 * (i + 1));
      expect(encoder.encode).not.toHaveBeenCalled();
      expect(createImageBitmap).toHaveBeenCalledTimes(labels.length);
      expect(drawnPixels()).toEqual(drawn);
      expect(statuses()).toEqual(reasons.map((r) => `1 ${r} webgl 100`));
    },
  );

  it('stops sampling and reporting, and can be stopped twice', async () => {
    addCanvas();
    start();
    await tick(1000);
    manager.reset();
    manager.reset();
    manager.onFullSnapshot();
    reply({ status: 'error', reason: 'tainted' });
    await tick(2000, 9000);
    expect([encodes(), statuses()]).toEqual([1, []]);
    expect(worker.postMessage).not.toHaveBeenCalledWith({ kind: 'reset' });
  });
});
