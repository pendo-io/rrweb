import type * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';
import type * as puppeteer from 'puppeteer';
import { vi } from 'vitest';
import {
  CANVAS_STATUS_TAG,
  EventType,
  IncrementalSource,
  type eventWithTime,
} from '@rrweb/types';
import { getServerURL, launchPuppeteer, startServer } from '../utils';

describe('record canvas FPS', () => {
  vi.setConfig({ testTimeout: 20_000 });
  let server: http.Server;
  let browser: puppeteer.Browser;
  let page: puppeteer.Page;
  let events: eventWithTime[];
  let errors: Error[];

  const statuses = () =>
    events.flatMap((e) =>
      e.type === EventType.Custom && e.data.tag === CANVAS_STATUS_TAG
        ? [e.data.payload]
        : [],
    );
  const frameIds = () =>
    events.flatMap((e) =>
      e.type === EventType.IncrementalSnapshot &&
      e.data.source === IncrementalSource.CanvasMutation
        ? [e.data.id]
        : [],
    );

  beforeAll(async () => {
    server = await startServer();
    browser = await launchPuppeteer();
  });
  afterAll(async () => {
    await browser.close();
    server.close();
  });
  beforeEach(async () => {
    [events, errors] = [[], []];
    page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e));
    await page.goto(`${getServerURL(server)}/html/blank.html`);
    await page.addScriptTag({
      path: path.resolve(__dirname, '../../dist/rrweb.umd.cjs'),
    });
    await page.exposeFunction('emit', (e: eventWithTime) => events.push(e));
    await page.evaluate(() => {
      const win = window as any;
      win.start = (canvasOptions: object) =>
        win.rrweb.record({
          emit: win.emit,
          recordCanvas: true,
          sampling: { canvas: 4 },
          canvasOptions,
        });
    });
  });
  afterEach(async () => {
    expect(errors).toEqual([]);
    await page.close();
  });

  it('reports a WebGL canvas created before recording once and never clears it', async () => {
    const result = await page.evaluate(async () => {
      const canvas = document.body.appendChild(
        document.createElement('canvas'),
      );
      const gl = canvas.getContext('webgl')!;
      const { clear } = WebGLRenderingContext.prototype;
      let clears = 0;
      WebGLRenderingContext.prototype.clear = function (mask) {
        clears++;
        return clear.call(this, mask);
      };
      (window as any).start({ initialSnapshotDelayMs: 300 });
      gl.clear(gl.COLOR_BUFFER_BIT);
      await new Promise((r) => setTimeout(r, 1500));
      return [clears, gl.getContextAttributes()!.preserveDrawingBuffer];
    });

    expect(result).toEqual([1, false]);
    expect(frameIds()).toEqual([]);
    expect(statuses()).toMatchObject([
      { status: 'unreadable', reason: 'webgl-blank', context: 'webgl' },
    ]);
  });

  it.each([
    [{}, true],
    [{ forcePreserveDrawingBuffer: false }, false],
  ])('canvasOptions %j -> preserveDrawingBuffer %s', async (options, value) => {
    const preserve = await page.evaluate((canvasOptions) => {
      (window as any).start(canvasOptions);
      const gl = document.createElement('canvas').getContext('webgl')!;
      return gl.getContextAttributes()!.preserveDrawingBuffer;
    }, options);
    expect(preserve).toBe(value);
  });

  it('reports a tainted canvas, keeps the others, and stops on stopCanvas', async () => {
    const { port } = server.address() as AddressInfo;
    await page.evaluate(async (src) => {
      (window as any).start();
      const [tainted, plain] = [0, 1].map(() =>
        document.body.appendChild(document.createElement('canvas')),
      );
      const ctx = plain.getContext('2d')!;
      const image = new Image();
      image.src = src;
      await image.decode();
      tainted.getContext('2d')!.drawImage(image, 0, 0);
      setInterval(() => ctx.fillRect(Math.random() * 300, 0, 10, 10), 50);
    }, `http://127.0.0.1:${port}/html/assets/robot.png`);
    await page.waitForTimeout(1500);

    const [status, ...rest] = statuses();
    expect(rest).toEqual([]);
    expect(status).toMatchObject({ status: 'unreadable', reason: 'tainted' });
    const frames = frameIds();
    expect(frames.length).toBeGreaterThan(2);
    expect(frames).not.toContain(status.id);

    await page.evaluate(() => {
      const { record } = (window as any).rrweb;
      record.stopCanvas();
      record.stopCanvas();
    });
    await page.waitForTimeout(100);
    const sent = frameIds().length;
    await page.evaluate(() => document.body.append('still recording'));
    await page.waitForTimeout(800);
    expect(frameIds()).toHaveLength(sent);
    expect(events.at(-1)).toMatchObject({
      type: EventType.IncrementalSnapshot,
      data: { source: IncrementalSource.Mutation },
    });
  });

  it.each([
    ['before record()', true, false],
    ['before a checkout', false, true],
    ['before its mutation is serialized', false, false],
  ])(
    'reports a canvas tainted %s and keeps recording',
    async (_, before, checkout) => {
      const { port } = server.address() as AddressInfo;
      await page.evaluate(
        async (src, before, checkout) => {
          const image = new Image();
          image.src = src;
          await image.decode();
          const taint = (canvas: HTMLCanvasElement) =>
            canvas.getContext('2d')!.drawImage(image, 0, 0);
          const canvas = document.body.appendChild(
            document.createElement('canvas'),
          );
          if (before) taint(canvas);
          (window as any).start();
          if (checkout) {
            taint(canvas);
            (window as any).rrweb.record.takeFullSnapshot();
          } else if (!before) {
            taint(document.body.appendChild(document.createElement('canvas')));
          }
          document.body.append('still recording');
        },
        `http://127.0.0.1:${port}/html/assets/robot.png`,
        before,
        checkout,
      );
      await page.waitForTimeout(800);

      expect(
        events.filter((e) => e.type === EventType.FullSnapshot),
      ).toHaveLength(checkout ? 2 : 1);
      expect(JSON.stringify(events)).toContain('still recording');
      const last = (match: (e: eventWithTime) => boolean) =>
        events.findLastIndex(match);
      expect(
        last(
          (e) =>
            e.type === EventType.Custom && e.data.tag === CANVAS_STATUS_TAG,
        ),
      ).toBeGreaterThan(last((e) => e.type === EventType.FullSnapshot));
      expect(statuses().at(-1)).toMatchObject({
        status: 'unreadable',
        reason: 'tainted',
      });
    },
  );

  it('stops canvas pixels in later full snapshots and added canvases after stopCanvas', async () => {
    const dataURLEvents = () =>
      events.filter((e) => JSON.stringify(e).includes('rr_dataURL')).length;
    await page.evaluate(() => {
      const drawn = () => {
        const canvas = document.createElement('canvas');
        canvas.getContext('2d')!.fillRect(0, 0, 10, 10);
        return canvas;
      };
      document.body.appendChild(drawn());
      const { record } = (window as any).rrweb;
      (window as any).start();
      record.takeFullSnapshot();
      record.stopCanvas();
      record.takeFullSnapshot();
      document.body.appendChild(drawn());
    });
    await page.waitForTimeout(300);
    const fullSnapshots = events.filter(
      (e) => e.type === EventType.FullSnapshot,
    );
    expect(fullSnapshots).toHaveLength(3);
    expect(JSON.stringify(fullSnapshots[1])).toContain('rr_dataURL');
    expect(JSON.stringify(fullSnapshots[2])).not.toContain('rr_dataURL');
    expect(dataURLEvents()).toBe(2);
  });
});
