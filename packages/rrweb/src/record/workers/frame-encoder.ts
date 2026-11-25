import { encode } from 'base64-arraybuffer';
import type { CanvasWorkerResponse, DataURLOptions } from '@rrweb/types';

const WEBP = 'image/webp';
const PNG = 'image/png';
const ALLOWED_TYPES = [WEBP, 'image/jpeg', PNG];

export type FrameCanvas = {
  width: number;
  height: number;
  getContext(
    id: '2d',
  ): Pick<CanvasRenderingContext2D, 'drawImage' | 'clearRect'> | null;
  convertToBlob?: (o: { type?: string; quality?: number }) => Promise<Blob>;
  toBlob?: (cb: (b: Blob | null) => void, type?: string, q?: number) => void;
};

function fitToMaxDimension(w: number, h: number, max = 0) {
  const scale = max > 0 ? Math.min(1, max / Math.max(w, h)) : 1;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

const isSize = (n: number) => typeof n === 'number' && n > 0 && n < Infinity;

const emptyCanvas = (width: number, height: number) =>
  typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });

export class FrameEncoder {
  private lastBase64: Map<number, string> = new Map();
  private transparentBase64: Map<string, string> = new Map();
  private webpUnsupported = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private canvas: FrameCanvas) {}

  public async encode(
    id: number,
    source: CanvasImageSource,
    width: number,
    height: number,
    { type, quality: q, maxDimension }: DataURLOptions = {},
    skipBlank = false,
  ): Promise<CanvasWorkerResponse> {
    const previous = this.queue;
    let done: () => void;
    this.queue = new Promise((resolve) => (done = resolve));
    await previous;
    try {
      if (!isSize(width) || !isSize(height)) throw new RangeError('size');
      const quality =
        typeof q === 'number' && Number.isFinite(q)
          ? Math.min(1, Math.max(0, q))
          : undefined;
      const size = fitToMaxDimension(width, height, maxDimension);
      this.canvas.width = size.width;
      this.canvas.height = size.height;
      const ctx = this.canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      const key = [size.width, size.height, type, quality].join();
      if (!this.transparentBase64.has(key)) {
        const empty = emptyCanvas(size.width, size.height);
        ctx.drawImage(empty, 0, 0, size.width, size.height);
        const blank = await this.toBlob(type, quality);
        this.transparentBase64.set(key, encode(await blank.arrayBuffer()));
      }
      ctx.clearRect(0, 0, size.width, size.height);
      ctx.drawImage(source, 0, 0, size.width, size.height);
      const blob = await this.toBlob(type, quality);
      if (!ALLOWED_TYPES.includes(blob.type)) throw new TypeError(blob.type);
      const base64 = encode(await blob.arrayBuffer());

      const blank = this.transparentBase64.get(key) === base64;
      if (blank && (skipBlank || !this.lastBase64.has(id))) {
        return { id, status: 'blank' };
      }
      if (this.lastBase64.get(id) === base64) {
        return { id, status: 'unchanged' };
      }
      this.lastBase64.set(id, base64);
      return { id, status: 'frame', type: blob.type, base64, width, height };
    } catch (e) {
      const reason =
        (e as Error)?.name === 'SecurityError' ? 'tainted' : 'encode-error';
      return { id, status: 'error', reason };
    } finally {
      done!();
    }
  }

  public forget(id: number) {
    this.queue = this.queue.then(() => {
      this.lastBase64.delete(id);
    });
  }

  public reset() {
    this.queue = this.queue.then(() => {
      this.lastBase64.clear();
      this.transparentBase64.clear();
    });
  }

  private async toBlob(type?: string, quality?: number): Promise<Blob> {
    const wantsWebp = type === WEBP && !this.webpUnsupported;
    const encodeType = type === WEBP && !wantsWebp ? PNG : type;
    const blob = await this.encodeCanvas(encodeType, quality);
    if (!wantsWebp || blob.type === WEBP) return blob;
    this.webpUnsupported = true;
    return this.encodeCanvas(PNG, quality);
  }

  private encodeCanvas(type?: string, quality?: number): Promise<Blob> {
    const { canvas } = this;
    if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
    return new Promise((resolve, reject) =>
      canvas.toBlob!(
        (b) => (b ? resolve(b) : reject(new Error())),
        type,
        quality,
      ),
    );
  }
}
