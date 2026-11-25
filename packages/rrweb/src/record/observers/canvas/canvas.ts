import type { ICanvas } from 'rrweb-snapshot';
import type { blockClass, IWindow, listenerHandler } from '@rrweb/types';
import { isBlocked } from '../../../utils';
import { patch } from '@rrweb/utils';

function getNormalizedContextName(contextType: string) {
  return contextType === 'experimental-webgl' ? 'webgl' : contextType;
}

export default function initCanvasContextObserver(
  win: IWindow,
  blockClass: blockClass,
  blockSelector: string | null,
  setPreserveDrawingBufferToTrue: boolean,
): listenerHandler {
  const handlers: listenerHandler[] = [];
  try {
    const restoreHandler = patch(
      win.HTMLCanvasElement.prototype,
      'getContext',
      function (
        original: (
          this: ICanvas | HTMLCanvasElement,
          contextType: string,
          ...args: Array<unknown>
        ) => void,
      ) {
        return function (
          this: ICanvas | HTMLCanvasElement,
          contextType: string,
          ...args: Array<unknown>
        ) {
          if (!isBlocked(this, blockClass, blockSelector, true)) {
            const ctxName = getNormalizedContextName(contextType);
            if (!('__context' in this)) (this as ICanvas).__context = ctxName;

            if (
              setPreserveDrawingBufferToTrue &&
              ['webgl', 'webgl2'].includes(ctxName)
            ) {
              if (args[0] && typeof args[0] === 'object') {
                const contextAttributes = args[0] as WebGLContextAttributes;
                if (!contextAttributes.preserveDrawingBuffer) {
                  contextAttributes.preserveDrawingBuffer = true;
                }
              } else {
                args.splice(0, 1, {
                  preserveDrawingBuffer: true,
                });
              }
            }
          }
          return original.apply(this, [contextType, ...args]);
        };
      },
    );
    handlers.push(restoreHandler);
  } catch {
    console.error('failed to patch HTMLCanvasElement.prototype.getContext');
  }
  return () => {
    handlers.forEach((h) => h());
  };
}

const GL_DRAWS = ['clear', 'drawArrays', 'drawElements'];
const GL2_DRAWS = [
  ...GL_DRAWS,
  'drawArraysInstanced',
  'drawElementsInstanced',
  'drawRangeElements',
];

export function initWebGLContextTagger(win: IWindow): listenerHandler {
  const handlers: listenerHandler[] = [];
  const targets: Array<[string, { prototype: object } | undefined, string[]]> =
    [
      ['webgl', win.WebGLRenderingContext, GL_DRAWS],
      ['webgl2', win.WebGL2RenderingContext, GL2_DRAWS],
    ];
  for (const [ctxName, ctor, methods] of targets) {
    if (!ctor) continue;
    for (const method of methods) {
      handlers.push(
        patch(ctor.prototype, method, function (original) {
          return function (
            this: WebGLRenderingContext,
            ...args: Array<unknown>
          ) {
            if (!('__context' in this.canvas)) {
              (this.canvas as ICanvas).__context = ctxName;
            }
            return (original as (...a: unknown[]) => unknown).apply(this, args);
          };
        }),
      );
    }
  }
  return () => {
    handlers.forEach((h) => h());
  };
}
