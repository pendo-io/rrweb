import { decode } from 'base64-arraybuffer';
import { FrameEncoder } from '../../src/record/workers/frame-encoder';

class FakeCanvas {
  encodes: Array<{ type?: string; quality?: number }> = [];
  types = ['image/webp', 'image/jpeg', 'image/png'];
  size = [1, 1];
  pixels = '';
  get width() {
    return this.size[0];
  }
  set width(w: number) {
    this.size[0] = w;
    this.pixels = '';
  }
  get height() {
    return this.size[1];
  }
  set height(h: number) {
    this.size[1] = h;
    this.pixels = '';
  }
  getContext() {
    return {
      drawImage: ({ label }: { label: string }) => {
        if (label === 'tainted') throw new DOMException('', 'SecurityError');
        this.pixels = label;
      },
    };
  }
  convertToBlob = async (o: { type?: string; quality?: number }) => {
    this.encodes.push(o);
    const type = this.types.includes(o.type) ? o.type : 'image/png';
    return new Blob([`${this.width}x${this.height}:${this.pixels}`], { type });
  };
}

const text = (r) => new TextDecoder().decode(decode(r.base64));
const WEBP = { type: 'image/webp', quality: 0.4, maxDimension: 480 };
const ERROR = { id: 1, status: 'error', reason: 'encode-error' };

describe('FrameEncoder', () => {
  let canvas: FakeCanvas;
  let encoder: FrameEncoder;
  const run = (id: number, label: string, w = 10, h = 10, opts = {}) =>
    encoder.encode(id, { label } as never, w, h, { ...WEBP, ...opts });
  beforeEach(() => {
    canvas = new FakeCanvas();
    encoder = new FrameEncoder(canvas);
  });

  it.each([
    [2000, 1000, 480, '480x240'],
    [1000, 2000, 480, '240x480'],
    [480, 300, 480, '480x300'],
    [320, 180, 480, '320x180'],
    [1001, 333, 480, '480x160'],
    [5000, 1, 480, '480x1'],
    [2000, 1000, undefined, '2000x1000'],
  ])('draws %ix%i with max %s at %s', async (w, h, maxDimension, size) => {
    const frame = await run(1, 'a', w, h, { maxDimension });
    expect(frame).toMatchObject({ type: 'image/webp', width: w, height: h });
    expect(text(frame)).toBe(`${size}:a`);
  });

  it('encodes overlapping requests one at a time', async () => {
    const frames = await Promise.all([run(1, 'a', 2000, 1000), run(2, 'b')]);
    expect(frames.map(text)).toEqual(['480x240:a', '10x10:b']);
  });

  it('falls back to PNG without WebP and never retries WebP', async () => {
    canvas.types = ['image/jpeg', 'image/png'];
    expect(await run(1, 'a')).toMatchObject({ type: 'image/png' });
    expect(await run(2, 'b')).toMatchObject({ type: 'image/png' });
    const types = canvas.encodes.map((e) => e.type);
    expect(types).toEqual(['image/webp', ...Array(3).fill('image/png')]);
  });

  it('clamps quality to 0-1 and drops non-numbers', async () => {
    for (const quality of [0.4, 1.5, -1, NaN]) {
      await run(1, String(quality), 10, 10, { quality });
    }
    const qualities = canvas.encodes.map((e) => e.quality);
    expect(qualities).toEqual([0.4, 0.4, 1, 0, undefined]);
  });

  it('reports a blank first frame and dedupes until forget or reset', async () => {
    const statuses = [];
    for (const step of ['', '', 'a', 'a', 'forget', 'a', 'reset', 'a']) {
      if (step === 'forget' || step === 'reset') encoder[step](1);
      else statuses.push((await run(1, step)).status);
    }
    expect(statuses.join()).toBe('blank,unchanged,frame,unchanged,frame,frame');
  });

  it('applies forget and reset after encodes already queued', async () => {
    for (const step of ['forget', 'reset'] as const) {
      const pending = [run(1, 'a'), run(1, 'a')];
      encoder[step](1);
      pending.push(run(1, 'a'));
      const statuses = (await Promise.all(pending)).map((r) => r.status);
      expect(statuses.slice(1).join()).toBe('unchanged,frame');
    }
  });

  it('clears the blank-frame cache on reset', async () => {
    await run(1, '');
    encoder.reset();
    expect((await run(1, '')).status).toBe('blank');
    expect(canvas.encodes.length).toBe(4);
  });

  it.each([
    ['0x10', () => run(1, 'a', 0, 10), ERROR],
    ['10x0', () => run(1, 'a', 10, 0), ERROR],
    ["'9'x9", () => run(1, 'a', '9' as never, 9), ERROR],
    ['tainted', () => run(1, 'tainted'), { ...ERROR, reason: 'tainted' }],
  ])('rejects %s and stays usable', async (_name, act, expected) => {
    expect(await act()).toEqual(expected);
    expect(await run(1, 'a')).toMatchObject({ status: 'frame' });
  });

  it.each([
    ['bmp', () => async () => new Blob([], { type: 'image/bmp' })],
    ['throw', () => () => Promise.reject(new Error())],
  ])('reports encode-error on %s output', async (_name, make) => {
    canvas.convertToBlob = make();
    expect(await run(1, 'a')).toEqual(ERROR);
  });

  it('uses toBlob when convertToBlob is missing', async () => {
    const convert = canvas.convertToBlob;
    Object.assign(canvas, {
      convertToBlob: undefined,
      toBlob: (cb, type, q) => void convert({ type, quality: q }).then(cb),
    });
    expect(await run(1, 'a')).toMatchObject({ status: 'frame' });
  });
});

describe('canvas worker', () => {
  const posted = [];
  let onmessage: (e: { data: unknown }) => Promise<void>;
  const load = async (offscreen = true) => {
    posted.length = 0;
    vi.resetModules();
    vi.unstubAllGlobals();
    if (offscreen) vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const self = { onmessage: null, postMessage: (m) => posted.push(m) };
    vi.stubGlobal('self', self);
    await import('../../src/record/workers/image-bitmap-data-url-worker');
    onmessage = self.onmessage;
  };
  const send = async (extra = {}) => {
    const bitmap = { label: 'a', close: vi.fn() };
    const data = { id: 1, bitmap, width: 10, height: 10, ...extra };
    await onmessage({ data: { dataURLOptions: WEBP, ...data } });
    return bitmap.close;
  };
  beforeEach(() => load());
  afterAll(() => vi.unstubAllGlobals());

  it.each([{}, { kind: 'encode' }])('encodes %o, closes bitmap', async (x) => {
    expect(await send(x)).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([expect.objectContaining({ status: 'frame' })]);
  });

  it.each([{ bitmap: 'x' }, { kind: 'draw' }])('fails %o', async (x) => {
    await send(x);
    expect(posted).toEqual([ERROR]);
  });

  it.each([null, { id: '1' }, { kind: 'forget' }])('ignores %o', async (d) => {
    await onmessage({ data: d });
    expect(posted).toEqual([]);
  });

  it('forgets and resets without replying', async () => {
    for (const kind of ['', '', 'forget', '', 'reset', '']) {
      await (kind ? onmessage({ data: { kind, id: 1 } }) : send());
    }
    const statuses = posted.map((m) => m.status);
    expect(statuses.join()).toBe('frame,unchanged,frame,frame');
  });

  it('replies with an error without OffscreenCanvas', async () => {
    await load(false);
    expect(await send()).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([ERROR]);
  });
});
