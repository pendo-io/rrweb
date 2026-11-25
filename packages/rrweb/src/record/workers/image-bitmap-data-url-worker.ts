import type {
  CanvasWorkerRequest,
  DataURLOptions,
  ImageBitmapDataURLWorkerResponse,
} from '@rrweb/types';
import { FrameEncoder } from './frame-encoder';

export interface ImageBitmapDataURLRequestWorker {
  postMessage: (message: CanvasWorkerRequest, transfer?: [ImageBitmap]) => void;
  onmessage: (message: MessageEvent<ImageBitmapDataURLWorkerResponse>) => void;
}

interface ImageBitmapDataURLResponseWorker {
  onmessage: null | ((message: MessageEvent<CanvasWorkerRequest>) => void);
  postMessage(e: ImageBitmapDataURLWorkerResponse): void;
}

let encoder: FrameEncoder | undefined;

// `as any` because: https://github.com/Microsoft/TypeScript/issues/20595
const worker: ImageBitmapDataURLResponseWorker = self;

// eslint-disable-next-line @typescript-eslint/no-misused-promises
worker.onmessage = async function (e) {
  const data = e.data as Partial<Record<string, unknown>> | null;
  if (!data || typeof data !== 'object') return;
  if (data.kind === 'reset') return encoder?.reset();
  const id = data.id;
  if (typeof id !== 'number') return;
  if (data.kind === 'forget') return encoder?.forget(id);

  const bitmap = data.bitmap as ImageBitmap | undefined;
  try {
    const isEncode = (data.kind ?? 'encode') === 'encode';
    if (!isEncode || typeof bitmap !== 'object') throw new TypeError();
    if (!encoder && 'OffscreenCanvas' in globalThis) {
      encoder = new FrameEncoder(new OffscreenCanvas(1, 1));
    }
    worker.postMessage(
      await encoder!.encode(
        id,
        bitmap,
        data.width as number,
        data.height as number,
        (data.dataURLOptions as DataURLOptions) || {},
        data.skipBlank === true,
      ),
    );
  } catch {
    worker.postMessage({ id, status: 'error', reason: 'encode-error' });
  } finally {
    if (typeof bitmap?.close === 'function') bitmap.close();
  }
};
