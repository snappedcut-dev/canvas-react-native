# @snappedcut/canvas-react-native

The [Snapped Cut](https://snappedcut.com) video editor in a React Native app.
A WebView wrapper of [the embed](https://github.com/snappedcut-dev/embed), for
iOS and Android.

> **Status: the wrapper is ready, the host route is not.** This package and its
> bridge are complete and tested, but `snappedcut.com/embed` is not serving
> frames yet and publishable keys are not being issued. It is published so the
> bridge can be reviewed. **It will not load against production today.** Watch
> [the repo](https://github.com/snappedcut-dev/canvas-react-native) for the
> release that turns it on.

```sh
npm install @snappedcut/canvas-react-native react-native-webview
```

```tsx
import { useRef } from 'react';
import { Button, View } from 'react-native';
import { SnappedCutCanvas, type SnappedCutCanvasHandle } from '@snappedcut/canvas-react-native';

export function Editor() {
  const canvas = useRef<SnappedCutCanvasHandle>(null);

  return (
    <View style={{ flex: 1 }}>
      <SnappedCutCanvas
        ref={canvas}
        publishableKey="pk_live_..."
        onExport={({ uri, bytes }) => console.log(uri, bytes)}
      />
      <Button title="Export" onPress={() => canvas.current?.export('mp4')} />
    </View>
  );
}
```

For Expo, with a video picker wired up, use
[`@snappedcut/canvas-expo`](https://github.com/snappedcut-dev/canvas-expo).

## Props and handle

| Prop | |
| --- | --- |
| `publishableKey` | `pk_live_…`. Public by design; locked to an allowlist. |
| `token` / `getToken` | A server-minted token carrying an `endUserId`, and how to refresh it. |
| `origin` | Override for a self-hosted install. |
| `locale`, `theme`, `style` | |
| `onReady` `onError` `onChange` `onExport` `onJob` | |

| On the ref | |
| --- | --- |
| `load(uri)` | Open a project bundle or a media file. |
| `export(format, options?)` | `webm`, `mp4`, `mkv`, `mov`, `gif`, `png`. |
| `getProject()` | The current timeline, as JSON. |

`export` resolves with a **`data:` URI**, not a Blob — a WebView cannot hand a
native app a Blob. Write it to disk with `expo-file-system` or
`react-native-fs`.

## The processing happens on our servers

Every decode, composite and encode runs on Snapped Cut's machines, not in the
WebView. The view is a thin client: it sends the operation, we render it, it
shows the result.

Two consequences for an app:

- **No engine in your bundle, and none in the WebView.** Embedding the editor
  does not add a video pipeline to your app or a multi-megabyte download before
  the first tap.
- **Work is metered.** Operations report through `onJob` with `credits` and the
  `endUserId` from your token, so you can meter per customer. A `load` or an
  `export` is a round trip — show that progress rather than assuming it is
  instant, especially on mobile data.

## How the bridge works, and why it matters

In a browser the embed sits in an `<iframe>` and talks to its host page with
`window.parent.postMessage`. In a WebView there **is** no parent — the embed is
the top-level document — and the only channel out is
`window.ReactNativeWebView.postMessage`, which takes a string.

So this package injects a shim before the page loads that gives it a
`window.parent` whose `postMessage` reaches the native side, and an inbound hook
that dispatches a real `message` event. The embed needs no knowledge of React
Native: it believes it is in an iframe, and **the same `/embed` route serves web
and native unchanged**.

Two consequences are worth knowing:

- **A WebView's `onMessage` has no origin to check.** Anything running in the
  page can call `ReactNativeWebView.postMessage`. So the remaining checks carry
  more weight: a message must parse as JSON, carry our source marker, name a
  known event type, and match the frame id generated for *this* mount — which
  is what stops a backgrounded page's late messages being read as the current
  one's.
- **The WebView is pinned to our origin.** `onShouldStartLoadWithRequest`
  refuses any navigation off it, including an `http://` downgrade and a
  look-alike host. Without that, a link in a project's metadata could load an
  arbitrary page that still had the bridge, and therefore the key, available to
  it.

Everything above lives in `src/bridge.ts`, which is pure — so it is covered by
tests rather than by a simulator. The injection test *evaluates* its generated
JavaScript against six escape attempts and asserts the payload round-trips and
nothing else runs.

MIT
