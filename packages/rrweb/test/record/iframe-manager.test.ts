/**
 * @vitest-environment jsdom
 */
import { createMirror } from 'rrweb-snapshot';
import { vi } from 'vitest';
import { IframeManager } from '../../src/record/iframe-manager';
import { StylesheetManager } from '../../src/record/stylesheet-manager';

const createManager = (recordCrossOriginIframes: boolean) =>
  new IframeManager({
    mirror: createMirror(),
    mutationCb: vi.fn(),
    stylesheetManager: new StylesheetManager({
      mutationCb: vi.fn(),
      adoptedStyleSheetCb: vi.fn(),
    }),
    recordCrossOriginIframes,
    wrappedEmit: vi.fn(),
    takeFullSnapshot: vi.fn(),
  });

/**
 * A browser hides `contentDocument` (returns null) for an iframe from another origin,
 * but still exposes `contentWindow`, so that is what this stands in for.
 */
const crossOriginIframe = () => {
  const postMessage = vi.fn();
  const iframe = {
    contentDocument: null,
    contentWindow: { postMessage },
  } as unknown as HTMLIFrameElement;
  return { iframe, postMessage };
};

const sameOriginIframe = () => {
  const postMessage = vi.fn();
  const iframe = {
    contentDocument: document.implementation.createHTMLDocument('child'),
    contentWindow: { postMessage },
  } as unknown as HTMLIFrameElement;
  return { iframe, postMessage };
};

describe('IframeManager.addIframe snapshot request', () => {
  describe('with recordCrossOriginIframes on', () => {
    it('posts a snapshot request to a cross-origin iframe', () => {
      const { iframe, postMessage } = crossOriginIframe();

      createManager(true).addIframe(iframe);

      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage).toHaveBeenCalledWith(
        {
          type: 'rrweb',
          origin: window.location.origin,
          snapshot: true,
        },
        '*',
      );
    });

    it('does not post to a same-origin iframe, which the parent records directly', () => {
      const { iframe, postMessage } = sameOriginIframe();

      createManager(true).addIframe(iframe);

      expect(postMessage).not.toHaveBeenCalled();
    });

    it('does not throw or post when the iframe has no contentWindow', () => {
      const iframe = {
        contentDocument: null,
        contentWindow: null,
      } as unknown as HTMLIFrameElement;

      expect(() => createManager(true).addIframe(iframe)).not.toThrow();
    });

    it('posts once per addIframe call, so a parent re-snapshot asks the child again', () => {
      const { iframe, postMessage } = crossOriginIframe();
      const manager = createManager(true);

      manager.addIframe(iframe);
      manager.addIframe(iframe);

      expect(postMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('with recordCrossOriginIframes off', () => {
    // A third-party iframe (for example an OIDC check-session frame) can react badly to
    // a message it did not ask for, so nothing may be posted to it.
    it('does not post a snapshot request to a cross-origin iframe', () => {
      const { iframe, postMessage } = crossOriginIframe();

      createManager(false).addIframe(iframe);

      expect(postMessage).not.toHaveBeenCalled();
    });

    it('does not post to a same-origin iframe either', () => {
      const { iframe, postMessage } = sameOriginIframe();

      createManager(false).addIframe(iframe);

      expect(postMessage).not.toHaveBeenCalled();
    });

    it('does not post for any of several cross-origin iframes', () => {
      const frames = [
        crossOriginIframe(),
        crossOriginIframe(),
        crossOriginIframe(),
      ];
      const manager = createManager(false);

      frames.forEach(({ iframe }) => manager.addIframe(iframe));

      frames.forEach(({ postMessage }) =>
        expect(postMessage).not.toHaveBeenCalled(),
      );
    });
  });

  describe('message listener', () => {
    it('listens for messages from child frames only when recordCrossOriginIframes is on', () => {
      const addEventListener = vi.spyOn(window, 'addEventListener');

      createManager(false);
      expect(addEventListener).not.toHaveBeenCalledWith(
        'message',
        expect.any(Function),
      );

      createManager(true);
      expect(addEventListener).toHaveBeenCalledWith(
        'message',
        expect.any(Function),
      );

      addEventListener.mockRestore();
    });
  });
});
