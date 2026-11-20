import * as fs from 'fs';
import * as path from 'path';
import type * as puppeteer from 'puppeteer';
import { vi } from 'vitest';
import type {
  eventWithTime,
  serializedNodeWithId,
  mutationData,
  addedNodeMutation,
} from '@rrweb/types';
import { EventType, IncrementalSource, NodeType } from '@rrweb/types';
import type { recordOptions } from '../../src/types';
import { launchPuppeteer } from '../utils';

interface IWindow extends Window {
  rrweb: {
    record: ((options: recordOptions<eventWithTime>) => () => void) & {
      mirror: { has: (id: number) => boolean };
    };
  };
  emit: (e: eventWithTime) => undefined;
  stopRecording: () => void;
}

const REPORT_SRCDOC =
  '<p>visible report text</p><p class="rr-mask">secret account 12345</p>';

function findIframes(
  node: serializedNodeWithId,
  found: serializedNodeWithId[] = [],
) {
  if (node.type === NodeType.Element && node.tagName === 'iframe')
    found.push(node);
  if (node.type === NodeType.Document || node.type === NodeType.Element)
    node.childNodes.forEach((child) => findIframes(child, found));
  return found;
}

describe('record iframe srcdoc', () => {
  vi.setConfig({ testTimeout: 20_000 });

  let browser: puppeteer.Browser;
  let page: puppeteer.Page;
  let code: string;
  let events: eventWithTime[];
  let pageErrors: string[];

  const settle = () => page.waitForTimeout(100);
  const mutations = () =>
    events
      .filter(
        (e) =>
          e.type === EventType.IncrementalSnapshot &&
          e.data.source === IncrementalSource.Mutation,
      )
      .map((e) => e.data as mutationData);
  const attributeChanges = () => mutations().flatMap((m) => m.attributes);
  const attachedDocuments = (): addedNodeMutation[] =>
    mutations()
      .filter((m) => m.isAttachIframe)
      .map((m) => m.adds[0]);
  const fullSnapshotIframes = () => {
    const snapshot = events.find((e) => e.type === EventType.FullSnapshot)!;
    return findIframes((snapshot.data as { node: serializedNodeWithId }).node);
  };

  async function start(body: string, options: object = {}) {
    await page.setContent(`<!DOCTYPE html><html><body>${body}</body></html>`);
    await settle();
    await page.evaluate(code);
    await page.evaluate((options) => {
      const win = window as unknown as IWindow;
      win.stopRecording = win.rrweb.record({
        emit: win.emit,
        maskTextClass: 'rr-mask',
        recordCrossOriginIframes: true,
        ...options,
      });
    }, options);
    await settle();
  }

  beforeAll(async () => {
    browser = await launchPuppeteer();
    code = fs.readFileSync(
      path.resolve(__dirname, '../../dist/rrweb.umd.cjs'),
      'utf8',
    );
  });

  beforeEach(async () => {
    events = [];
    pageErrors = [];
    page = await browser.newPage();
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.exposeFunction('emit', (e: eventWithTime) => events.push(e));
  });

  afterEach(async () => {
    await page.close();
  });

  afterAll(async () => {
    await browser.close();
  });

  describe('same-origin srcdoc iframe', () => {
    const iframe = `<iframe id="report" srcdoc='${REPORT_SRCDOC}'></iframe>`;

    it('records the document, not the srcdoc attribute', async () => {
      await start(iframe);

      const [snapshotIframe] = fullSnapshotIframes();
      const [attached] = attachedDocuments();

      expect((snapshotIframe as any).attributes.srcdoc).toBeUndefined();
      expect(attached.parentId).toBe(snapshotIframe.id);
      expect(JSON.stringify(attached)).toContain('visible report text');
      expect(JSON.stringify(events)).not.toContain('secret account 12345');
    });

    it('does not emit srcdoc attribute mutations', async () => {
      await start(iframe);
      await page.evaluate(() =>
        document
          .getElementById('report')!
          .setAttribute('srcdoc', '<p class="rr-mask">updated secret text</p>'),
      );
      await settle();

      expect(attributeChanges().some((c) => 'srcdoc' in c.attributes)).toBe(
        false,
      );
      expect(JSON.stringify(events)).not.toContain('updated secret text');
    });
  });

  describe('sandboxed without allow-same-origin', () => {
    const iframe = `<iframe id="report" sandbox="allow-scripts" srcdoc='${REPORT_SRCDOC}'></iframe>`;

    it('attaches the parsed srcdoc document with masking applied', async () => {
      await start(iframe);

      const [snapshotIframe] = fullSnapshotIframes() as any[];
      const [attached] = attachedDocuments();
      const attachedJson = JSON.stringify(attached);

      expect(snapshotIframe.attributes.sandbox).toBe('allow-same-origin');
      expect(snapshotIframe.attributes.srcdoc).toBeUndefined();
      expect(attached.parentId).toBe(snapshotIframe.id);
      expect(attachedJson).toContain('visible report text');
      expect(attachedJson).toContain('****** ******* *****');
      expect(JSON.stringify(events)).not.toContain('secret account 12345');
      expect(pageErrors).toEqual([]);
    });

    it('re-attaches the masked document when srcdoc changes', async () => {
      await start(iframe);
      await page.evaluate(() =>
        document
          .getElementById('report')!
          .setAttribute(
            'srcdoc',
            '<p>updated report text</p><p class="rr-mask">secret account 67890</p>',
          ),
      );
      await settle();

      const documents = attachedDocuments();

      expect(documents.length).toBe(2);
      expect(JSON.stringify(documents[1])).toContain('updated report text');
      expect(JSON.stringify(events)).not.toContain('secret account 67890');
      expect(pageErrors).toEqual([]);
    });

    it('captures a sandboxed srcdoc iframe added after recording starts', async () => {
      await start('');
      await page.evaluate(() => {
        const added = document.createElement('iframe');
        added.setAttribute('sandbox', 'allow-scripts');
        added.setAttribute('srcdoc', '<p>added report text</p>');
        document.body.appendChild(added);
      });
      await settle();

      const added = mutations()
        .filter((m) => !m.isAttachIframe)
        .flatMap((m) => m.adds)
        .find(
          (add) =>
            add.node.type === NodeType.Element && add.node.tagName === 'iframe',
        )!;
      const documents = attachedDocuments();

      expect((added.node as any).attributes.sandbox).toBe('allow-same-origin');
      expect(documents.length).toBe(1);
      expect(documents[0].parentId).toBe(added.node.id);
      expect(JSON.stringify(documents[0])).toContain('added report text');
    });

    it('records an opaque sandbox set later as allow-same-origin, once', async () => {
      await start('<iframe id="plain"></iframe>');
      await page.evaluate(() => {
        const plain = document.getElementById('plain')!;
        plain.setAttribute('sandbox', 'allow-scripts');
      });
      await settle();
      await page.evaluate(() => {
        const plain = document.getElementById('plain')!;
        plain.setAttribute('sandbox', 'allow-scripts allow-forms');
      });
      await settle();

      const sandboxValues = attributeChanges()
        .filter((c) => 'sandbox' in c.attributes)
        .map((c) => c.attributes.sandbox);

      expect(sandboxValues).toEqual(['allow-same-origin']);
    });

    it('does not attach a blocked sandboxed srcdoc iframe', async () => {
      await start(iframe.replace('<iframe ', '<iframe class="rr-block" '));

      expect(attachedDocuments().length).toBe(0);
      expect(JSON.stringify(events)).not.toContain('visible report text');
    });

    it('forgets the parsed document when the iframe is removed', async () => {
      await start(iframe);
      const attachedIds: number[] = [];
      const collectIds = (node: serializedNodeWithId) => {
        attachedIds.push(node.id);
        if (node.type === NodeType.Document || node.type === NodeType.Element)
          node.childNodes.forEach(collectIds);
      };
      collectIds(attachedDocuments()[0].node);
      const mirrorHas = () =>
        page.evaluate(
          (ids) =>
            ids.map((id) =>
              (window as unknown as IWindow).rrweb.record.mirror.has(id),
            ),
          attachedIds,
        );

      expect((await mirrorHas()).every(Boolean)).toBe(true);

      await page.evaluate(() => document.getElementById('report')!.remove());
      await settle();

      expect((await mirrorHas()).some(Boolean)).toBe(false);
    });

    it('stops attaching after recording stops', async () => {
      await start(iframe);
      await page.evaluate(() => {
        (window as unknown as IWindow).stopRecording();
        document
          .getElementById('report')!
          .setAttribute('srcdoc', '<p>after stop text</p>');
      });
      await settle();

      expect(JSON.stringify(events)).not.toContain('after stop text');
    });
  });
});
