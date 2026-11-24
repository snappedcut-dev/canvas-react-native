import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from 'react';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent, WebViewNavigation } from 'react-native-webview';
import {
  backoffMs,
  canvasUrl,
  CanvasError,
  DEFAULT_ORIGIN,
  injection,
  isAllowedUrl,
  newFrameId,
  parseFrameMessage,
  shimSource,
  type CanvasErrorCode,
  type ExportFormat,
} from './bridge';

export {
  CanvasError,
  DEFAULT_ORIGIN,
  type CanvasErrorCode,
  type ExportFormat,
};

export type ExportResult = {
  /** A `data:` URL. A WebView cannot hand a native app a Blob. */
  uri: string;
  format: ExportFormat;
  width: number;
  height: number;
  bytes: number;
};

export type JobEvent = {
  jobId: string;
  operation: string;
  status: 'started' | 'succeeded' | 'failed';
  credits: number;
  endUserId: string | null;
};

export type SnappedCutCanvasProps = {
  /** `pk_live_…`. Public by design; locked to an app/origin allowlist. */
  publishableKey?: string;
  /** A token minted server-side, carrying an `endUserId` for attribution. */
  token?: string;
  /** Called when the embed says its token is about to expire. */
  getToken?: () => Promise<string> | string;
  /** Override for a self-hosted install. */
  origin?: string;
  locale?: string;
  theme?: { mode?: 'dark' | 'light'; accent?: string };
  style?: object;
  onReady?: () => void;
  onError?: (error: { code: CanvasErrorCode; message: string }) => void;
  onChange?: (change: { duration: number; clips: number }) => void;
  onExport?: (result: ExportResult) => void;
  onJob?: (job: JobEvent) => void;
};

export type SnappedCutCanvasHandle = {
  /** Open a project bundle or a media file by URI. */
  load(uri: string): Promise<void>;
  export(format: ExportFormat, options?: { scale?: number; quality?: number }): Promise<ExportResult>;
  getProject(): Promise<unknown>;
};

const TIMEOUT_MS = 120_000;

/**
 * The Snapped Cut editor in a React Native app.
 *
 * The WebView is a **thin client**: decode, compositing and encode all happen
 * on Snapped Cut's servers, so no engine code reaches the device. `load` and
 * `export` are therefore round trips, not local calls — every one is work we
 * do and meter, and each reports itself through `onJob` with its credit cost.
 */
export const SnappedCutCanvas = forwardRef<SnappedCutCanvasHandle, SnappedCutCanvasProps>(
  function SnappedCutCanvas(props, ref) {
    const {
      publishableKey,
      token,
      getToken,
      origin = DEFAULT_ORIGIN,
      locale,
      theme,
      style,
      onReady,
      onError,
      onChange,
      onExport,
      onJob,
    } = props;

    const webview = useRef<WebView>(null);
    /* One id per mounted component, not per render: it is what tells this
       mount's messages from a backgrounded page's late ones. */
    const frameId = useMemo(() => newFrameId(), []);
    const pending = useRef(new Map<number, { resolve: (v: never) => void; reject: (e: unknown) => void }>());
    const nextId = useRef(1);
    const attempt = useRef(0);

    // Callbacks through a ref: an inline onReady is a new function every render,
    // and as a dependency it would reload the WebView on each one.
    const handlers = useRef({ onReady, onError, onChange, onExport, onJob, getToken });
    handlers.current = { onReady, onError, onChange, onExport, onJob, getToken };

    const url = useMemo(
      () => canvasUrl({ origin, publishableKey, token, locale, frameId }),
      [origin, publishableKey, token, locale, frameId],
    );

    const post = useCallback(
      (type: string, payload?: unknown, id?: number) => {
        webview.current?.injectJavaScript(injection(type, frameId, payload, id));
      },
      [frameId],
    );

    const request = useCallback(
      <T,>(type: string, payload?: unknown): Promise<T> =>
        new Promise<T>((resolve, reject) => {
          const id = nextId.current++;
          const timer = setTimeout(() => {
            pending.current.delete(id);
            reject(new CanvasError('network_error', `${type} did not answer within 120s.`));
          }, TIMEOUT_MS);

          pending.current.set(id, {
            resolve: ((value: T) => {
              clearTimeout(timer);
              resolve(value);
            }) as never,
            reject: (error: unknown) => {
              clearTimeout(timer);
              reject(error);
            },
          });
          post(type, payload, id);
        }),
      [post],
    );

    const refresh = useCallback(async () => {
      const fetchToken = handlers.current.getToken;
      if (!fetchToken) {
        handlers.current.onError?.({
          code: 'token_expired',
          message: 'The token expired and no getToken was configured.',
        });
        return;
      }
      try {
        const fresh = await fetchToken();
        attempt.current = 0;
        post('token', { token: fresh });
      } catch (error) {
        handlers.current.onError?.({
          code: 'token_expired',
          message: `getToken failed: ${String(error)}`,
        });
        setTimeout(() => void refresh(), backoffMs(attempt.current++));
      }
    }, [post]);

    const onMessage = useCallback(
      (event: WebViewMessageEvent) => {
        const message = parseFrameMessage(event.nativeEvent.data, frameId);
        if (!message) return;

        if (message.type === 'reply' && typeof message.id === 'number') {
          const slot = pending.current.get(message.id);
          if (!slot) return;
          pending.current.delete(message.id);
          if (message.error) slot.reject(new CanvasError(message.error.code, message.error.message));
          else slot.resolve(message.payload as never);
          return;
        }

        switch (message.type) {
          case 'token-expiring':
            void refresh();
            return;
          case 'ready':
            if (theme) post('theme', theme);
            handlers.current.onReady?.();
            return;
          case 'error':
            handlers.current.onError?.(
              message.payload as { code: CanvasErrorCode; message: string },
            );
            return;
          case 'change':
            handlers.current.onChange?.(message.payload as { duration: number; clips: number });
            return;
          case 'export':
            handlers.current.onExport?.(message.payload as ExportResult);
            return;
          case 'job':
            handlers.current.onJob?.(message.payload as JobEvent);
            return;
          default:
            return;
        }
      },
      [frameId, post, refresh, theme],
    );

    /* The WebView must not be navigable away from our origin. Without this a
       link in a project's metadata could load an arbitrary page that still has
       the bridge, and therefore the key, available to it. */
    const onShouldStartLoadWithRequest = useCallback(
      (request: WebViewNavigation) => isAllowedUrl(request.url, origin),
      [origin],
    );

    useImperativeHandle(
      ref,
      () => ({
        load: (uri: string) => request<void>('load', { source: uri }),
        export: (format, options) => request<ExportResult>('export', { format, ...options }),
        getProject: () => request<unknown>('project'),
      }),
      [request],
    );

    if (!publishableKey && !token) {
      throw new CanvasError('invalid_input', 'SnappedCutCanvas needs a publishableKey or a token.');
    }

    return (
      <WebView
        ref={webview}
        source={{ uri: url }}
        style={[{ flex: 1 }, style]}
        originWhitelist={[origin]}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        injectedJavaScriptBeforeContentLoaded={shimSource(frameId)}
        // The editor is one screen; a bounce on a timeline is a dropped drag.
        bounces={false}
        overScrollMode="never"
        // The frame's UI and the file picker both need these.
        javaScriptEnabled
        domStorageEnabled
        allowFileAccess
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        onError={(event) =>
          handlers.current.onError?.({
            code: 'mount_failed',
            message: event.nativeEvent.description ?? 'The editor failed to load.',
          })
        }
      />
    );
  },
);

export default SnappedCutCanvas;
