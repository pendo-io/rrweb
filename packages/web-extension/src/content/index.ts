import Browser from 'webextension-polyfill';
import { record } from 'rrweb';
import type { eventWithTime } from '@rrweb/types';
import {
  type LocalData,
  LocalDataKey,
  RecorderStatus,
  ServiceName,
  type RecordStartedMessage,
  type RecordStoppedMessage,
  MessageName,
  type EmitEventMessage,
  EventName,
} from '~/types';
import Channel from '~/utils/channel';
import { isInCrossOriginIFrame } from '~/utils';

const channel = new Channel();

/**
 * ISOLATED-WORLD TEST: run record() directly in this content script instead
 * of bridging into the page via an injected <script> tag (see content/inject.ts,
 * now unused by this path). This content script is declared in manifest.json
 * with no `world` override, so it runs in Chrome's default ISOLATED world —
 * same shape as pendo-browser-extension's agent-content.js injection.
 *
 * Expectation if the isolated-world theory is right: full snapshots and
 * newly-added <style> nodes still capture fine (direct cssRules reads), but
 * IncrementalSource.StyleSheetRule (8) / the ongoing AdoptedStyleSheet path
 * never fire for page-driven (main-world) insertRule/replaceSync/adoptedStyleSheets
 * calls, even though the page itself renders correctly. Flip by adding
 * "world": "MAIN" to this entry in manifest.json and rebuilding to compare.
 */
function postSelfMessage(message: unknown) {
  if (!isInCrossOriginIFrame()) window.postMessage(message, location.origin);
}

let stopFn: (() => void) | null = null;

void (() => {
  window.addEventListener(
    'message',
    (
      event: MessageEvent<{
        message: MessageName;
      }>,
    ) => {
      if (event.source !== window) return;
      if (event.data.message === MessageName.RecordScriptReady)
        window.postMessage(
          {
            message: MessageName.StartRecord,
            config: {
              recordCrossOriginIframes: true,
            },
          },
          location.origin,
        );
    },
  );
  if (isInCrossOriginIFrame()) {
    void initCrossOriginIframe();
  } else if (window === window.top) {
    void initMainPage();
  }
})();

async function initMainPage() {
  let startResponseCb: ((response: RecordStartedMessage) => void) | undefined =
    undefined;
  channel.provide(ServiceName.StartRecord, async () => {
    startRecord();
    return new Promise((resolve) => {
      startResponseCb = (response) => {
        resolve(response);
      };
    });
  });
  let stopResponseCb: ((response: RecordStoppedMessage) => void) | undefined =
    undefined;
  channel.provide(ServiceName.StopRecord, () => {
    stopRecord();
    return new Promise((resolve) => {
      stopResponseCb = (response: RecordStoppedMessage) => {
        stopResponseCb = undefined;
        resolve(response);
      };
    });
  });

  window.addEventListener(
    'message',
    (
      event: MessageEvent<
        | RecordStartedMessage
        | RecordStoppedMessage
        | EmitEventMessage
        | {
            message: MessageName;
          }
      >,
    ) => {
      if (event.source !== window) return;
      else if (
        event.data.message === MessageName.RecordStarted &&
        startResponseCb
      )
        startResponseCb(event.data as RecordStartedMessage);
      else if (
        event.data.message === MessageName.RecordStopped &&
        stopResponseCb
      ) {
        // On firefox, the event.data is immutable, so we need to clone it to avoid errors.
        const data = { ...(event.data as RecordStoppedMessage) };
        stopResponseCb(data);
      } else if (event.data.message === MessageName.EmitEvent)
        channel.emit(
          EventName.ContentScriptEmitEvent,
          (event.data as EmitEventMessage).event,
        );
    },
  );

  const localData = (await Browser.storage.local.get()) as LocalData;
  if (
    localData?.[LocalDataKey.recorderStatus]?.status ===
    RecorderStatus.RECORDING
  ) {
    startRecord();
  }
}

async function initCrossOriginIframe() {
  Browser.storage.local.onChanged.addListener((change) => {
    if (change[LocalDataKey.recorderStatus]) {
      const statusChange = change[LocalDataKey.recorderStatus];
      const newStatus =
        statusChange.newValue as LocalData[LocalDataKey.recorderStatus];
      if (newStatus.status === RecorderStatus.RECORDING) startRecord();
      else stopRecord();
    }
  });
  const localData = (await Browser.storage.local.get()) as LocalData;
  if (
    localData?.[LocalDataKey.recorderStatus]?.status ===
    RecorderStatus.RECORDING
  )
    startRecord();
}

function startRecord() {
  stopFn =
    record({
      emit: (event: eventWithTime) => {
        postSelfMessage({
          message: MessageName.EmitEvent,
          event,
        } as EmitEventMessage);
      },
      recordCrossOriginIframes: true,
    }) || null;
  postSelfMessage({
    message: MessageName.RecordStarted,
    startTimestamp: Date.now(),
  } as RecordStartedMessage);
}

function stopRecord() {
  if (stopFn) {
    try {
      stopFn();
    } catch (e) {
      //
    }
    stopFn = null;
  }
  postSelfMessage({
    message: MessageName.RecordStopped,
    endTimestamp: Date.now(),
  } as RecordStoppedMessage);
}
