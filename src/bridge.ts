/**
 * The WebView bridge.
 *
 * Pure, and in its own file, because this is where the interesting problem is.
 *
 * In a browser the embed lives in an `<iframe>` and talks to the page that
 * mounted it with `window.parent.postMessage`. In a WebView there *is* no
 * parent — the embed is the top-level document — and the only channel out is
 * `window.ReactNativeWebView.postMessage`, which takes a **string** and nothing
 * else.
 *
 * So the shim below gives the page a `window.parent` whose `postMessage`
 * serialises to that channel, and an inbound path that dispatches a real
 * `message` event. The embed page then needs no knowledge of React Native: it
 * believes it is in an iframe, and the same `/embed` route serves web and
 * native unchanged.
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_ORIGIN = 'https://snappedcut.com';

/** What the server renders; which of these a session may use is its `features.formats`. */
export type ExportFormat = 'mp4' | 'webm' | 'mov' | 'mkv';

export type CanvasErrorCode =
  | 'invalid_input'
  | 'mount_failed'
  | 'token_expired'
  | 'unauthorized'
  | 'origin_not_allowed'
  | 'unsupported'
  | 'network_error'
  | 'export_failed'
  | 'credits_exhausted'
  | 'rate_limited'
  | 'internal';

export class CanvasError extends Error {
  readonly code: CanvasErrorCode;

  constructor(code: CanvasErrorCode, message: string) {
    super(message);
    this.name = 'CanvasError';
    this.code = code;
  }
}

export const FRAME_EVENTS = [
  'ready',
  'error',
  'change',
  'export',
  'job',
  'token-expiring',
  'reply',
] as const;

export type FrameEventName = (typeof FRAME_EVENTS)[number];

export type FrameMessage = {
  readonly source: 'snappedcut';
  readonly v: number;
  readonly frameId: string;
  readonly type: FrameEventName;
  readonly id?: number;
  readonly payload?: unknown;
  readonly error?: { code: CanvasErrorCode; message: string; retryAfterMs?: number };
};

/**
 * Is this string really a message from the embed we loaded?
 *
 * A WebView's `onMessage` has no origin to check — anything the page runs can
 * call `ReactNativeWebView.postMessage`, including a script on a page the user
 * navigated to. So the checks that remain carry more weight, not less:
 *
 * 1. It must parse as JSON. A WebView will happily deliver `"hello"`.
 * 2. It must carry our `source` marker and a known event type.
 * 3. The `frameId` must match the one we generated for this mount, which is
 *    what stops a cached or backgrounded page's late messages being read as
 *    the current one's.
 *
 * `onShouldStartLoadWithRequest` in the component is what keeps the WebView on
 * our origin in the first place; this is the second line, not the only one.
 */
export function parseFrameMessage(raw: unknown, frameId: string): FrameMessage | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!data || typeof data !== 'object') return null;
  const message = data as Partial<FrameMessage>;
  if (message.source !== 'snappedcut') return null;
  if (message.frameId !== frameId) return null;
  if (typeof message.type !== 'string') return null;
  if (!(FRAME_EVENTS as readonly string[]).includes(message.type)) return null;

  return message as FrameMessage;
}

/** The embed URL for a native mount. */
export function canvasUrl(config: {
  origin?: string | undefined;
  publishableKey?: string | undefined;
  token?: string | undefined;
  locale?: string | undefined;
  features?: unknown;
  frameId: string;
}): string {
  const origin = (config.origin ?? DEFAULT_ORIGIN).replace(/\/+$/, '');
  const query = new URLSearchParams({
    v: String(PROTOCOL_VERSION),
    frame: config.frameId,
    // So the page knows to expect the shim rather than a real parent, and can
    // size itself for a touch screen.
    host: 'react-native',
  });
  if (config.publishableKey) query.set('key', config.publishableKey);
  if (config.locale) query.set('locale', config.locale);
  // Not a secret, and it only narrows what the token grants.
  if (config.features) query.set('features', JSON.stringify(config.features));

  const url = `${origin}/embed?${query.toString()}`;
  // The token goes in the hash: a hash is not sent to the server, so it stays
  // out of access logs and out of a referrer header.
  return config.token ? `${url}#t=${encodeURIComponent(config.token)}` : url;
}

/** Only our own origin may drive the bridge. */
export function isAllowedUrl(url: string, origin: string): boolean {
  try {
    const parsed = new URL(url);
    const allowed = new URL(origin);
    // Host *and* protocol: http on a https origin is a downgrade, not a match.
    return parsed.origin === allowed.origin;
  } catch {
    return false;
  }
}

/**
 * The script injected before the page loads.
 *
 * It must run before the embed's own code, or the embed will look for
 * `window.parent` and find the real one.
 */
export function shimSource(frameId: string): string {
  // JSON.stringify, not quotes: a frame id is generated here, but building
  // injected JavaScript by concatenation is how an injection bug starts.
  const id = JSON.stringify(frameId);

  return `(function () {
  var channel = window.ReactNativeWebView;
  if (!channel) return;

  // The embed posts to window.parent. There is no parent in a WebView, so give
  // it one whose postMessage reaches the native side as a string.
  var host = {
    postMessage: function (message) {
      try { channel.postMessage(JSON.stringify(message)); } catch (e) {}
    },
  };
  try {
    Object.defineProperty(window, 'parent', { get: function () { return host; } });
  } catch (e) {
    // Some engines refuse to redefine window.parent. The embed checks for this
    // marker as a fallback, which is why it is set either way.
  }
  window.__snappedcutHost = host;
  window.__snappedcutFrameId = ${id};

  // Inbound: the native side calls __snappedcutReceive with one message.
  window.__snappedcutReceive = function (json) {
    var data;
    try { data = JSON.parse(json); } catch (e) { return; }
    window.dispatchEvent(new MessageEvent('message', { data: data, source: host }));
  };
  true;
})();
true;`;
}

/** One inbound call, as JavaScript to evaluate in the WebView. */
export function injection(type: string, frameId: string, payload?: unknown, id?: number): string {
  const message = JSON.stringify({
    source: 'snappedcut-host',
    v: PROTOCOL_VERSION,
    frameId,
    type,
    id,
    payload,
  });

  /* The message is JSON.stringify'd twice on purpose: once as the message, and
     once as the string literal holding it, so a quote or a backslash in a
     payload cannot close the literal and run as code.

     `<` and `/` are escaped on top of that. They are inert when this string is
     evaluated as JavaScript, which is what `injectJavaScript` does on iOS — but
     on Android some versions inject by writing a `<script>` element, and there
     a `</script>` inside a payload would end the block early. Escaping costs
     nothing and removes the difference between the two platforms. */
  const literal = JSON.stringify(message)
    .replace(/</g, '\\u003c')
    .replace(/\//g, '\\u002f');

  return `window.__snappedcutReceive && window.__snappedcutReceive(${literal});
true;`;
}

/** Random enough to separate two mounts; not a secret. */
export function newFrameId(): string {
  let id = '';
  for (let i = 0; i < 18; i += 1) id += Math.floor(Math.random() * 16).toString(16);
  return id;
}

/** 1s, 2s, 4s … capped at 30s, matching the web embed's token retry. */
export function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt), 30_000);
}
