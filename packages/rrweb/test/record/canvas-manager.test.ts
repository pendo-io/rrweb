/**
 * @vitest-environment jsdom
 */
import { createMirror } from 'rrweb-snapshot';
import { vi } from 'vitest';
import { CanvasManager } from '../../src/record/observers/canvas/canvas-manager';
import type { CanvasOptions } from '../../src/types';

const { encoder, inlineWorker } = vi.hoisted(() => ({
  encoder: { encode: vi.fn(), forget: vi.fn(), reset: vi.fn() },
  inlineWorker: vi.fn(),
}));
vi.mock('../../src/record/workers/frame-encoder', () => ({
  FrameEncoder: function () {
    return encoder;
  },
}));
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
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
};
const encodes = () =>
  worker.postMessage.mock.calls.filter(([m]) => m.kind === 'encode').length;
const reply = (data: object) => worker.onmessage({ data: { id: 1, ...data } });
const throwing = () => {
  throw new DOMException('', 'SecurityError');
};
const drawArgs = (n: number) =>
  mutationCb.mock.calls[n][0].commands[1].args.slice(1);

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
  mutationCb = vi.fn();
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
      expect.objectContaining({ kind: 'encode', id: 1, bitmap, width: 2000 }),
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
});
