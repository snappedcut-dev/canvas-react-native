import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
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

type ExportFacts = {
  format: ExportFormat;
  width: number;
  height: number;
  bytes: number;
  jobId: string;
  credits: number;
};

/**
 * Without `uploadUrl`, `uri` is a blob: URL that only the WebView can read —
 * fine for a short clip you hand back to the page, useless to native code.
 * In an app, pass `uploadUrl` and read the file from your own storage.
 */
export type ExportResult =
  | (ExportFacts & { uploaded?: false; uri: string })
  | (ExportFacts & { uploaded: true; contentType: string });

export type ExportOptions = {
  /** Output width in px; the height keeps the aspect ratio. Even, 16–7680. */
  targetWidth?: number;
  scale?: number;
  /** 0–1, five steps; 0.5 is the default. */
  quality?: number;
  /** A presigned https PUT on your storage. */
  uploadUrl?: string;
};

export type Uploaded = { uploaded: true; contentType: string; bytes: number };

export type JobEvent = {
  jobId: string;
  operation: 'cloud-render' | 'cloud-render-4k';
  status: 'started' | 'succeeded' | 'failed';
  credits: number;
  endUserId: string | null;
  durationMs?: number;
  error?: string;
};

/** The same tokens as the web embed and snapnedit. `mode` is accepted and ignored. */
export type CanvasTheme = {
  mode?: 'dark' | 'light';
  bg?: string;
  bg2?: string;
  surface?: string;
  surface2?: string;
  line?: string;
  line2?: string;
  text?: string;
  dim?: string;
  accent?: string;
  accentText?: string;
  radius?: number | string;
  font?: string;
};

export type CanvasPanel = 'text' | 'audio' | 'captions' | 'effects' | 'mask' | 'scenes' | 'keyframes' | 'comments';

/** Narrows what the token's signed `features` grant; it can never widen them. */
export type CanvasFeatures = {
  stock?: boolean;
  assistant?: boolean;
  projects?: boolean;
  share?: boolean;
  branding?: boolean;
  panels?: CanvasPanel[];
  formats?: ExportFormat[];
};

export type SnappedCutCanvasProps = {
  publishableKey?: string;
  token?: string;
  getToken?: () => Promise<string> | string;
  origin?: string;
  locale?: string;
  /** Changing it is sent live; it does not reload the WebView. */
  theme?: CanvasTheme;
  features?: CanvasFeatures;
  style?: object;
  onReady?: () => void;
  onError?: (error: { code: CanvasErrorCode; message: string; retryAfterMs?: number }) => void;
  onChange?: (change: { duration: number; clips: number }) => void;
  onExport?: (result: ExportResult) => void;
  onJob?: (job: JobEvent) => void;
};

export type SnappedCutCanvasHandle = {
  /** Add a media file, or reopen a project bundle, by https: or file: URI. */
  load(uri: string): Promise<void>;
  export(format: ExportFormat, options?: ExportOptions): Promise<ExportResult>;
  /** The whole project as a bundle, PUT to your storage. A Blob cannot cross the bridge, so the URL is required. */
  getProject(options: { uploadUrl: string }): Promise<Uploaded>;
  setTheme(theme: CanvasTheme): void;
};

const TIMEOUT_MS = 120_000;

/**
 * The Snapped Cut editor in a React Native app.
 *
 * Editing runs in the WebView on the device. `export` renders on Snapped
 * Cut's servers, billed to the token's session, and reports itself through
 * `onJob` with its credit cost.
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
      features,
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

    const themeRef = useRef(theme);
    themeRef.current = theme;
    // Compared as JSON: an inline object is a new object every render.
    const featuresKey = features ? JSON.stringify(features) : '';
    const themeKey = theme ? JSON.stringify(theme) : '';

    const url = useMemo(
      () => canvasUrl({ origin, publishableKey, token, locale, frameId, features: featuresKey ? JSON.parse(featuresKey) : undefined }),
      [origin, publishableKey, token, locale, frameId, featuresKey],
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
          if (message.error) {
            const failure = new CanvasError(message.error.code, message.error.message) as CanvasError & { retryAfterMs?: number };
            if (message.error.retryAfterMs !== undefined) failure.retryAfterMs = message.error.retryAfterMs;
            slot.reject(failure);
          }
          else slot.resolve(message.payload as never);
          return;
        }

        switch (message.type) {
          case 'token-expiring':
            void refresh();
            return;
          case 'ready':
            if (themeRef.current) post('theme', themeRef.current);
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
      [frameId, post, refresh],
    );

    // A theme change is a message, not a reload: the edit survives it.
    const ready = useRef(false);
    useEffect(() => {
      if (ready.current && themeKey) post('theme', JSON.parse(themeKey));
      ready.current = true;
    }, [themeKey, post]);

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
        getProject: (options) => request<Uploaded>('project', options),
        setTheme: (next) => post('theme', next),
      }),
      [request, post],
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
