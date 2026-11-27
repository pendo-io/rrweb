/**
 * @vitest-environment jsdom
 */
import { createMirror } from 'rrweb-snapshot';
import { vi } from 'vitest';
import {
  EventType,
  IncrementalSource,
  NodeType,
  type serializedNodeWithId,
} from '@rrweb/types';
import { IframeManager } from '../../src/record/iframe-manager';
import { StylesheetManager } from '../../src/record/stylesheet-manager';

// An iframe often starts as about:blank (same origin, so the parent records its document
// directly) and then navigates to another origin. After that the parent must treat it as a
// cross-origin iframe again, or every event the child posts up is dropped.

const CHILD_ORIGIN = 'https://child.example.com';
const SNAPSHOT_REQUEST = {
  type: 'rrweb',
  origin: window.location.origin,
  snapshot: true,
};

const createManager = (recordCrossOriginIframes = true) => {
  const wrappedEmit = vi.fn();
  const manager = new IframeManager({
    mirror: createMirror(),
    mutationCb: vi.fn(),
    stylesheetManager: new StylesheetManager({
      mutationCb: vi.fn(),
      adoptedStyleSheetCb: vi.fn(),
    }),
    recordCrossOriginIframes,
    blockClass: 'rr-block',
    blockSelector: null,
    wrappedEmit,
    takeFullSnapshot: vi.fn(),
  });
  return { manager, wrappedEmit };
};

const sameOriginDocument = (): serializedNodeWithId => ({
  type: NodeType.Document,
  id: 100,
  childNodes: [],
});

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function postFromChild(source: Window | null) {
  window.dispatchEvent(
    new MessageEvent('message', {
      source,
      origin: CHILD_ORIGIN,
      data: {
        type: 'rrweb',
        origin: CHILD_ORIGIN,
        isCheckout: false,
        event: {
          type: EventType.FullSnapshot,
          timestamp: Date.now(),
          data: {
            node: {
              type: NodeType.Document,
              id: 1,
              childNodes: [
                {
                  type: NodeType.Element,
                  id: 2,
                  tagName: 'html',
                  attributes: {},
                  childNodes: [],
                },
              ],
            },
            initialOffset: { top: 0, left: 0 },
          },
        },
      },
    }),
  );
}

// A browser hides contentDocument (returns null) once an iframe is on another origin.
function makeCrossOrigin(iframe: HTMLIFrameElement) {
  Object.defineProperty(iframe, 'contentDocument', {
    configurable: true,
    get: () => null,
  });
}

function makeSameOrigin(iframe: HTMLIFrameElement) {
  delete (iframe as unknown as Record<string, unknown>).contentDocument;
}

describe('IframeManager: iframe that navigates to another origin', () => {
  let manager: IframeManager;
  let wrappedEmit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ manager, wrappedEmit } = createManager());
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  // What record() does when it finds a same-origin (e.g. about:blank) iframe.
  function addBlankIframe(className?: string, target = manager) {
    const iframe = document.createElement('iframe');
    if (className) iframe.className = className;
    document.body.appendChild(iframe);
    target.addIframe(iframe);
    target.attachIframe(iframe, sameOriginDocument());
    return iframe;
  }

  function navigateAway(iframe: HTMLIFrameElement) {
    iframe.contentWindow!.dispatchEvent(new Event('pagehide'));
  }

  async function navigateCrossOrigin(iframe: HTMLIFrameElement) {
    navigateAway(iframe);
    makeCrossOrigin(iframe);
    iframe.dispatchEvent(new Event('load'));
    await flush();
  }

  // The child's full snapshot, re-emitted by the parent as an iframe attach mutation.
  function childAttachCount(emit = wrappedEmit) {
    return emit.mock.calls.filter(
      ([event]) =>
        event.type === EventType.IncrementalSnapshot &&
        event.data.source === IncrementalSource.Mutation &&
        event.data.isAttachIframe === true,
    ).length;
  }

  it('records a child that is cross-origin from the start', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    makeCrossOrigin(iframe);
    manager.addIframe(iframe);
    postFromChild(iframe.contentWindow);

    expect(childAttachCount()).toBe(1);
  });

  it('records the child after an about:blank iframe navigates cross-origin', async () => {
    const iframe = addBlankIframe();
    await navigateCrossOrigin(iframe);
    postFromChild(iframe.contentWindow);

    expect(childAttachCount()).toBe(1);
  });

  it('requests a snapshot from the child once it is cross-origin', async () => {
    const iframe = addBlankIframe();
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    await navigateCrossOrigin(iframe);

    expect(postMessage).toHaveBeenCalledWith(SNAPSHOT_REQUEST, '*');
  });

  it('keeps recording when the child navigates from one cross-origin page to another', async () => {
    const iframe = addBlankIframe();
    await navigateCrossOrigin(iframe);
    postFromChild(iframe.contentWindow);
    iframe.dispatchEvent(new Event('load'));
    await flush();
    postFromChild(iframe.contentWindow);

    expect(childAttachCount()).toBe(2);
  });

  it('records the child again after a cross-origin, same-origin, cross-origin round trip', async () => {
    const iframe = addBlankIframe();
    await navigateCrossOrigin(iframe);
    makeSameOrigin(iframe);
    iframe.dispatchEvent(new Event('load'));
    // record() re-attaches a same-origin document when it loads
    manager.attachIframe(iframe, sameOriginDocument());
    await flush();
    await navigateCrossOrigin(iframe);
    postFromChild(iframe.contentWindow);

    expect(childAttachCount()).toBe(1);
  });

  it('drops child messages once the iframe is removed from the DOM', async () => {
    const iframe = addBlankIframe();
    const contentWindow = iframe.contentWindow;
    navigateAway(iframe);
    iframe.remove();
    await flush();

    expect(() => postFromChild(contentWindow)).not.toThrow();
    expect(childAttachCount()).toBe(0);
  });

  it('does not re-register when the next document is same-origin', async () => {
    const iframe = addBlankIframe();
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');
    navigateAway(iframe);
    iframe.dispatchEvent(new Event('load'));
    await flush();
    postFromChild(iframe.contentWindow);

    expect(postMessage).not.toHaveBeenCalled();
    expect(childAttachCount()).toBe(0);
  });

  it('re-registers only once per navigation', async () => {
    const iframe = addBlankIframe();
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');
    await navigateCrossOrigin(iframe);
    iframe.dispatchEvent(new Event('load'));
    await flush();

    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('ignores a blocked iframe', async () => {
    const iframe = addBlankIframe('rr-block');
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');
    await navigateCrossOrigin(iframe);
    postFromChild(iframe.contentWindow);

    expect(postMessage).not.toHaveBeenCalled();
    expect(childAttachCount()).toBe(0);
  });

  it('records each iframe the parent re-creates as about:blank on a route change', async () => {
    const first = addBlankIframe();
    await navigateCrossOrigin(first);
    postFromChild(first.contentWindow);
    first.remove();
    await flush();

    const second = addBlankIframe();
    await navigateCrossOrigin(second);
    postFromChild(second.contentWindow);

    expect(childAttachCount()).toBe(2);
  });

  it('records the child snapshot sent after load when an earlier one arrived before load', async () => {
    const iframe = addBlankIframe();
    navigateAway(iframe);
    makeCrossOrigin(iframe);
    postFromChild(iframe.contentWindow);
    iframe.dispatchEvent(new Event('load'));
    await flush();
    postFromChild(iframe.contentWindow);

    expect(childAttachCount()).toBe(1);
  });

  it('does not re-register when recordCrossOriginIframes is off', async () => {
    const off = createManager(false);
    const iframe = addBlankIframe(undefined, off.manager);
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');
    await navigateCrossOrigin(iframe);
    postFromChild(iframe.contentWindow);

    expect(postMessage).not.toHaveBeenCalled();
    expect(childAttachCount(off.wrappedEmit)).toBe(0);
  });
});
