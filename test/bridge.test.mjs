import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  backoffMs, canvasUrl, injection, isAllowedUrl, newFrameId, parseFrameMessage, shimSource,
  DEFAULT_ORIGIN, CanvasError,
} from '../dist/bridge.js';

const good = (over = {}) =>
  JSON.stringify({ source: 'snappedcut', v: 1, frameId: 'f1', type: 'ready', ...over });

test('a well-formed message for this frame is accepted', () => {
  assert.equal(parseFrameMessage(good(), 'f1').type, 'ready');
});

test('anything that is not a JSON object is rejected', () => {
  // A WebView will happily deliver a bare string.
  for (const raw of ['hello', '', '[]', 'null', '{bad', undefined, null, 42, {}]) {
    assert.equal(parseFrameMessage(raw, 'f1'), null, `accepted ${JSON.stringify(raw)}`);
  }
});

test('a message without our source marker is rejected', () => {
  assert.equal(parseFrameMessage(good({ source: 'other' }), 'f1'), null);
});

test('a message for another frame is rejected', () => {
  // This is what stops a backgrounded page's late messages being read as the
  // current mount's -- a WebView has no origin to check.
  assert.equal(parseFrameMessage(good({ frameId: 'f2' }), 'f1'), null);
});

test('an unknown event type is rejected rather than forwarded', () => {
  assert.equal(parseFrameMessage(good({ type: 'eval' }), 'f1'), null);
});

test('the URL carries the key in the query, the token in the hash, and names the host', () => {
  const url = new URL(canvasUrl({ publishableKey: 'pk_live_1', token: 'tok 1', frameId: 'f1' }));
  assert.equal(url.origin, DEFAULT_ORIGIN);
  assert.equal(url.pathname, '/embed');
  assert.equal(url.searchParams.get('key'), 'pk_live_1');
  assert.equal(url.searchParams.get('host'), 'react-native');
  // A hash is not sent to the server, so the token stays out of access logs.
  assert.equal(url.hash, '#t=tok%201');
  assert.ok(!url.search.includes('tok'));
});

test('only our own origin may drive the bridge', () => {
  const origin = 'https://snappedcut.com';
  assert.equal(isAllowedUrl('https://snappedcut.com/embed?x=1', origin), true);
  assert.equal(isAllowedUrl('https://evil.example/embed', origin), false);
  // A different host that merely starts the same must not pass.
  assert.equal(isAllowedUrl('https://snappedcut.com.evil.example/', origin), false);
  // http on an https origin is a downgrade, not a match.
  assert.equal(isAllowedUrl('http://snappedcut.com/embed', origin), false);
  assert.equal(isAllowedUrl('not a url', origin), false);
  assert.equal(isAllowedUrl('javascript:alert(1)', origin), false);
});

test('the shim gives the page a parent and an inbound hook', () => {
  const source = shimSource('f1');
  assert.ok(source.includes('ReactNativeWebView'));
  assert.ok(source.includes("'parent'"));
  assert.ok(source.includes('__snappedcutReceive'));
  assert.ok(source.includes('"f1"'));
});

test('an injected payload is evaluated as data, never as code', () => {
  /* The real question is not whether a substring appears in the generated
     source -- an escaped quote does appear -- but whether evaluating it can do
     anything beyond delivering the payload. So evaluate it. */
  const attacks = [
    '");window.evil=1;//',
    '</script><script>window.evil=1</script>',
    String.raw`\");window.evil=1;//`,
    "');window.evil=1;//",
    '\u2028window.evil=1',
    '`+(window.evil=1)+`',
  ];

  for (const attack of attacks) {
    const context = { window: { __snappedcutReceive: (json) => { context.received = json; } } };
    vm.createContext(context);
    vm.runInContext(injection('load', 'f1', { source: attack }), context);

    assert.equal(context.window.evil, undefined, `escaped with: ${attack}`);
    assert.equal(JSON.parse(context.received).payload.source, attack, `round-trip: ${attack}`);
  }
});

test('the injection is a no-op when the shim never installed', () => {
  // A page that failed to load must not throw on the first inbound message.
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(injection('load', 'f1', { source: 'x' }), context);
  assert.equal(context.window.evil, undefined);
});

test('frame ids differ between mounts', () => {
  assert.notEqual(newFrameId(), newFrameId());
});

test('the token backoff climbs and then caps at 30s', () => {
  assert.deepEqual([0, 1, 2, 3].map(backoffMs), [1000, 2000, 4000, 8000]);
  assert.equal(backoffMs(99), 30_000);
});

test('CanvasError keeps its code for branching', () => {
  const error = new CanvasError('unauthorized', 'nope');
  assert.equal(error.code, 'unauthorized');
  assert.ok(error instanceof Error);
});
