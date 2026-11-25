import type { ICanvas, Mirror } from 'rrweb-snapshot';
import type {
  blockClass,
  canvasManagerMutationCallback,
  canvasMutationCallback,
  canvasMutationCommand,
  canvasMutationWithType,
  IWindow,
  listenerHandler,
  CanvasArg,
  DataURLOptions,
  CanvasWorkerResponse,
  canvasStatusCallback,
  canvasStatusPayload,
} from '@rrweb/types';
import { isBlocked } from '../../../utils';
import { CanvasContext } from '@rrweb/types';
import initCanvas2DMutationObserver from './2d';
import initCanvasContextObserver, { initWebGLContextTagger } from './canvas';
import initCanvasWebGLMutationObserver from './webgl';
import ImageBitmapDataURLWorker from '../../workers/image-bitmap-data-url-worker?worker&inline';
import { FrameEncoder } from '../../workers/frame-encoder';
import type { CanvasOptions } from '../../../types';

const DEFAULT_MAX_CANVASES = 5;

export type RafStamps = { latestId: number; invokeId: number | null };

type pendingCanvasMutationsMap = Map<
  HTMLCanvasElement,
  canvasMutationWithType[]
>;

export class CanvasManager {
  private pendingCanvasMutations: pendingCanvasMutationsMap = new Map();
  private rafStamps: RafStamps = { latestId: 0, invokeId: null };
  private mirror: Mirror;

  private mutationCb: canvasMutationCallback;
  private resetObservers?: listenerHandler;
  private onFullSnapshotCb?: () => void;
  private frozen = false;
  private locked = false;
  public stopped = false;

  public stop() {
    this.stopped = true;
    this.reset();
  }

  public reset() {
    this.pendingCanvasMutations.clear();
    this.resetObservers && this.resetObservers();
  }

  public onFullSnapshot() {
    this.onFullSnapshotCb?.();
  }

  public freeze() {
    this.frozen = true;
  }

  public unfreeze() {
    this.frozen = false;
  }

  public lock() {
    this.locked = true;
  }

  public unlock() {
    this.locked = false;
  }

  constructor(options: {
    recordCanvas: boolean;
    mutationCb: canvasMutationCallback;
    win: IWindow;
    blockClass: blockClass;
    blockSelector: string | null;
    mirror: Mirror;
    sampling?: 'all' | number;
    dataURLOptions: DataURLOptions;
    canvasOptions?: CanvasOptions;
    statusCb?: canvasStatusCallback;
  }) {
    const {
      sampling = 'all',
      win,
      blockClass,
      blockSelector,
      recordCanvas,
      dataURLOptions,
      canvasOptions = {},
    } = options;
    this.mutationCb = options.mutationCb;
    this.mirror = options.mirror;

    if (recordCanvas && sampling === 'all')
      this.initCanvasMutationObserver(win, blockClass, blockSelector);
    if (recordCanvas && typeof sampling === 'number')
      this.initCanvasFPSObserver(sampling, win, blockClass, blockSelector, {
        dataURLOptions,
        canvasOptions,
        statusCb: options.statusCb,
      });
  }

  private processMutation: canvasManagerMutationCallback = (
    target,
    mutation,
  ) => {
    const newFrame =
      this.rafStamps.invokeId &&
      this.rafStamps.latestId !== this.rafStamps.invokeId;
    if (newFrame || !this.rafStamps.invokeId)
      this.rafStamps.invokeId = this.rafStamps.latestId;

    if (!this.pendingCanvasMutations.has(target)) {
      this.pendingCanvasMutations.set(target, []);
    }

    this.pendingCanvasMutations.get(target)!.push(mutation);
  };

  private initCanvasFPSObserver(
    fps: number,
    win: IWindow,
    blockClass: blockClass,
    blockSelector: string | null,
    options: {
      dataURLOptions: DataURLOptions;
      canvasOptions: CanvasOptions;
      statusCb?: canvasStatusCallback;
    },
  ) {
    const { dataURLOptions, canvasOptions, statusCb } = options;
    const {
      workerFactory,
      fallbackMaxFps = 1,
      forcePreserveDrawingBuffer = true,
      maxCanvases: max,
    } = canvasOptions;
    const maxCanvases =
      (Number.isInteger(max) || max === Infinity) && max! > 0
        ? max!
        : DEFAULT_MAX_CANVASES;
    const canvasContextReset = initCanvasContextObserver(
      win,
      blockClass,
      blockSelector,
      forcePreserveDrawingBuffer,
    );
    const glTaggerReset = initWebGLContextTagger(win);
    const inFlight: Set<number> = new Set();
    const statuses: Map<number, string> = new Map();
    let canvases: Map<number, HTMLCanvasElement> = new Map();
    let observedIds: Set<number> = new Set();
    let encoder: FrameEncoder | undefined;
    let stopped = false;
    let busy = false;

    const report = (id: number, reason?: canvasStatusPayload['reason']) => {
      const status = reason ?? 'readable';
      const canvas = canvases.get(id);
      if (stopped || !canvas || (statuses.get(id) ?? 'readable') === status)
        return;
      statuses.set(id, status);
      statusCb?.({
        id,
        status: reason ? 'unreadable' : 'readable',
        reason,
        context: ((canvas as ICanvas).__context ||
          'unknown') as canvasStatusPayload['context'],
        width: canvas.width,
        height: canvas.height,
      });
    };

    const isUnreadableWebGL = (canvas?: HTMLCanvasElement) => {
      const ctxName = (canvas as ICanvas | undefined)?.__context;
      if (!canvas || (ctxName !== 'webgl' && ctxName !== 'webgl2'))
        return false;
      const gl = canvas.getContext(ctxName) as WebGLRenderingContext | null;
      return gl?.getContextAttributes()?.preserveDrawingBuffer === false;
    };

    const onResponse = (data: CanvasWorkerResponse) => {
      inFlight.delete(data.id);
      if (data.status === 'error') return report(data.id, data.reason);
      if (data.status === 'blank' && isUnreadableWebGL(canvases.get(data.id)))
        return report(data.id, 'webgl-blank');
      if (stopped || data.status !== 'frame') return;
      if (statuses.get(data.id) !== 'webgl-blank') report(data.id);

      const { id, base64, type, width, height } = data;
      this.mutationCb({
        id,
        type: CanvasContext['2D'],
        commands: [
          {
            property: 'clearRect', // wipe canvas
            args: [0, 0, width, height],
          },
          {
            property: 'drawImage', // draws (semi-transparent) image
            args: [
              {
                rr_type: 'ImageBitmap',
                args: [
                  {
                    rr_type: 'Blob',
                    data: [{ rr_type: 'ArrayBuffer', base64 }],
                    type,
                  },
                ],
              } as CanvasArg,
              0,
              0,
              width,
              height,
            ],
          },
        ],
      });
    };

    let timeBetweenSnapshots = 1000 / fps;
    let worker: Worker | undefined;
    const useMainThread = () => {
      worker?.terminate?.();
      worker = undefined;
      inFlight.clear();
      encoder = new FrameEncoder(win.document.createElement('canvas'));
      timeBetweenSnapshots =
        1000 / Math.min(fps, fallbackMaxFps > 0 ? fallbackMaxFps : 1);
    };
    try {
      worker = workerFactory ? workerFactory() : new ImageBitmapDataURLWorker();
    } catch {
      worker = undefined;
    }
    if (typeof worker?.postMessage === 'function') {
      worker.onmessage = (e: MessageEvent<CanvasWorkerResponse>) =>
        onResponse(e.data);
      worker.onerror = useMainThread;
    } else {
      useMainThread();
    }

    this.onFullSnapshotCb = () => {
      statuses.clear();
      worker ? worker.postMessage({ kind: 'reset' }) : encoder?.reset();
    };

    let lastSnapshotTime = 0;
    let rafId: number;

    const getCanvas = (): HTMLCanvasElement[] => {
      const matchedCanvas: HTMLCanvasElement[] = [];
      win.document.querySelectorAll('canvas').forEach((canvas) => {
        if (!isBlocked(canvas, blockClass, blockSelector, true)) {
          matchedCanvas.push(canvas);
        }
      });
      return matchedCanvas;
    };

    const snapshotCanvases = async () => {
      canvases = new Map();
      for (const canvas of getCanvas()) {
        const id = this.mirror.getId(canvas);
        if (id !== -1 && canvas.width && canvas.height)
          canvases.set(id, canvas);
      }
      const ids = new Set([...observedIds].filter((id) => canvases.has(id)));
      for (const id of canvases.keys()) {
        if (ids.size < maxCanvases) ids.add(id);
      }
      for (const id of ids) {
        const canvas = canvases.get(id)!;
        if (inFlight.has(id)) continue;
        if (statuses.get(id) === 'tainted') continue;

        // The browser throws if the canvas is 0 in size
        // Uncaught (in promise) DOMException: Failed to execute 'createImageBitmap' on 'Window': The source image width is 0.
        // Assuming the same happens with height
        const { width, height } = canvas;
        if (!width || !height || !canvas.isConnected || stopped) continue;

        inFlight.add(id);
        const skipBlank = isUnreadableWebGL(canvas);
        try {
          const bitmap = await createImageBitmap(canvas);
          if (worker) {
            worker.postMessage(
              {
                kind: 'encode',
                id,
                bitmap,
                width,
                height,
                dataURLOptions,
                skipBlank,
              },
              [bitmap],
            );
            continue;
          }
          try {
            onResponse(
              await encoder!.encode(
                id,
                bitmap,
                width,
                height,
                dataURLOptions,
                skipBlank,
              ),
            );
          } finally {
            bitmap.close();
          }
        } catch (e) {
          inFlight.delete(id);
          const { name } = e as Error;
          if (name === 'DataCloneError' || name === 'SecurityError')
            report(id, 'tainted');
        }
      }
      observedIds.forEach((id) => {
        if (ids.has(id)) return;
        inFlight.delete(id);
        statuses.delete(id);
        if (worker) worker.postMessage({ kind: 'forget', id });
        else encoder?.forget(id);
      });
      observedIds = ids;
    };

    const takeCanvasSnapshots = (timestamp: DOMHighResTimeStamp) => {
      rafId = requestAnimationFrame(takeCanvasSnapshots);
      if (
        busy ||
        win.document.visibilityState === 'hidden' ||
        (lastSnapshotTime &&
          timestamp - lastSnapshotTime < timeBetweenSnapshots)
      )
        return;
      lastSnapshotTime = timestamp;
      busy = true;
      void snapshotCanvases().finally(() => (busy = false));
    };

    const startTimeout = setTimeout(() => {
      rafId = requestAnimationFrame(takeCanvasSnapshots);
    }, canvasOptions.initialSnapshotDelayMs);

    this.resetObservers = () => {
      stopped = true;
      this.onFullSnapshotCb = undefined;
      canvasContextReset();
      glTaggerReset();
      clearTimeout(startTimeout);
      cancelAnimationFrame(rafId);
      worker?.terminate?.();
    };
  }

  private initCanvasMutationObserver(
    win: IWindow,
    blockClass: blockClass,
    blockSelector: string | null,
  ): void {
    this.startRAFTimestamping();
    this.startPendingCanvasMutationFlusher();

    const canvasContextReset = initCanvasContextObserver(
      win,
      blockClass,
      blockSelector,
      false,
    );
    const canvas2DReset = initCanvas2DMutationObserver(
      this.processMutation.bind(this),
      win,
      blockClass,
      blockSelector,
    );

    const canvasWebGL1and2Reset = initCanvasWebGLMutationObserver(
      this.processMutation.bind(this),
      win,
      blockClass,
      blockSelector,
    );

    this.resetObservers = () => {
      canvasContextReset();
      canvas2DReset();
      canvasWebGL1and2Reset();
    };
  }

  private startPendingCanvasMutationFlusher() {
    requestAnimationFrame(() => this.flushPendingCanvasMutations());
  }

  private startRAFTimestamping() {
    const setLatestRAFTimestamp = (timestamp: DOMHighResTimeStamp) => {
      this.rafStamps.latestId = timestamp;
      requestAnimationFrame(setLatestRAFTimestamp);
    };
    requestAnimationFrame(setLatestRAFTimestamp);
  }

  flushPendingCanvasMutations() {
    this.pendingCanvasMutations.forEach(
      (_values: canvasMutationCommand[], canvas: HTMLCanvasElement) => {
        const id = this.mirror.getId(canvas);
        this.flushPendingCanvasMutationFor(canvas, id);
      },
    );
    requestAnimationFrame(() => this.flushPendingCanvasMutations());
  }

  flushPendingCanvasMutationFor(canvas: HTMLCanvasElement, id: number) {
    if (this.frozen || this.locked) {
      return;
    }

    const valuesWithType = this.pendingCanvasMutations.get(canvas);
    if (!valuesWithType || id === -1) return;

    const values = valuesWithType.map((value) => {
      const { type, ...rest } = value;
      return rest;
    });
    const { type } = valuesWithType[0];

    this.mutationCb({ id, type, commands: values });

    this.pendingCanvasMutations.delete(canvas);
  }
}
