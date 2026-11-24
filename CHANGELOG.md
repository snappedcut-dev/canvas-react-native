# Changelog

Every release is tagged and published from CI with npm provenance. Versions
follow semver; the embed protocol has its own version in the `ready` event.

## 0.2.0 - 2026-11-24

The embed protocol is still v1; these changes are additive on the wire. The
types changed, which is why this is a minor release (pre-1.0).

### Added

- A `features` prop, which narrows the token's signed features. Use it to hide
  stock, the assistant, projects, share and branding, to pick the panels, and
  to choose the export formats.
- The full theme token set (`bg` … `font`), and `setTheme()`. A theme change is
  now sent to the running editor live, without reloading the WebView.
- `export(..., { targetWidth, uploadUrl })`. The result also carries `jobId` and
  `credits`, and with `uploadUrl` it is `{ uploaded: true }` with no `uri`.
- `getProject({ uploadUrl })` puts the project bundle on your storage. `load()`
  reopens it.
- New error codes `credits_exhausted` and `rate_limited`. A `rate_limited`
  error carries `retryAfterMs`.

### Changed

- `ExportFormat` is now `mp4 | webm | mov | mkv`.
- `getProject()` now requires `uploadUrl`, because a Blob cannot cross the
  native bridge.

## 0.1.1 - 2026-11-24

### Fixed

- **Documentation said the processing runs on our servers. It does not, yet.**
  Decode, compositing and encode run on the device today, on WebCodecs. The
  previous wording described the committed direction as though it had shipped,
  which is the wrong thing to hand anyone writing a privacy policy: it would
  have claimed media is uploaded to us when it is not. The section now states
  what this version does, names cloud render as the one path that uploads
  anything, and says the browser path means a real first load and a WebCodecs
  floor.

## 0.1.0 - 2026-11-24

First publish. The protocol and the client are complete and tested; the host
route at `snappedcut.com/embed` is not serving yet, so this will not mount
against production. See the status note in the README.

