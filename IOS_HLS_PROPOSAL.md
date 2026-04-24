# Proposal: opt-in persistent HLS for iOS clients (AVAssetDownloadURLSession support)

**Status:** Reference implementation complete and test-verified on a fork.
Opening a Discussion on `advplyr/audiobookshelf` to align on the opt-in shape
and any concerns before filing a Draft PR.

**Author:** walkermc20

**Audience:** advplyr/audiobookshelf maintainers, iOS client authors
(ShelfPlayer, official app)

**Fork:** https://github.com/walkermc20/audiobookshelf/tree/ios-hls-persistent

**Image for quick try:** `ghcr.io/walkermc20/audiobookshelf:ios-hls-persistent`
(public GHCR; opt-in via `ENABLE_IOS_HLS_PERSIST=1` env var or
`enableIosHlsPersist: true` in server settings)

**Downstream interest:** rasmuslos (author of
[ShelfPlayer](https://github.com/rasmuslos/ShelfPlayer)) has responded
positively in a DM thread and indicated he'd implement the client side
if something along these lines lands upstream.

---

## 1. Motivation

Third-party iOS clients (notably ShelfPlayer) currently ship **two parallel
playback paths**:

1. **Stream** — progressive MP3/M4B fetched from
   `/api/items/:id/file/:ino` and handed to `AVPlayer`.
2. **Offline** — a separately-downloaded file copy played from local
   storage.

Downstream consequences in the client: hundreds of lines branching on
`isDownloaded?`, an artificial guard preventing a download while the same
item is playing (two paths can't share a file handle), a hand-rolled
prefetch buffer, and separate progress-sync pipelines for download vs.
playback.

Apple's `AVAssetDownloadURLSession` collapses this into **one pipeline**:
it streams HLS during playback *and* writes a persistent `.movpkg` to
disk. The same `AVPlayer` later replays the `.movpkg` offline with zero
code-path change. "Download this" becomes a boolean on the asset download
task rather than a separate subsystem. Scrub buffering is AVFoundation's
problem.

The only requirement on the server is that a **manifest URL returned by
`POST /api/items/:id/play` remains valid across session idle-expiry and
server restarts**, so `AVAssetDownloadURLSession` can keep fetching
segments for as long as a download takes (often hours or days). Upstream
ABS ties manifests to in-memory sessions that die after 36 h idle, so
today's HLS path works for browsers but breaks the `AVAssetDownloadURLSession`
model.

## 2. Non-goals

- **Not** replacing the direct-play path for Android/web.
- **Not** turning on HLS by default. Weak-hardware self-hosters (RPi,
  NAS) should not be forced to transcode.
- **Not** introducing video HLS, adaptive bitrate, or multiple audio
  renditions.
- **Not** changing chapter metadata (already returned via the
  `PlaybackSession` JSON, segmentation-independent).
- **Not** addressing the "dumb client" case covered by
  [#5003](https://github.com/advplyr/audiobookshelf/issues/5003).
  Complementary direction.

## 3. Prior art on this repo

- [#2040 — Playback Options (force HLS)](https://github.com/advplyr/audiobookshelf/issues/2040).
  Narrower and arguably addressable today via `forceTranscode: true`.
  This proposal's plumbing makes #2040 trivially closeable or
  implementable as a client-side follow-up.
- [#5003 — Direct MP3 Stream with server-side seeking](https://github.com/advplyr/audiobookshelf/issues/5003).
  Complementary (opposite direction: dumb clients).

## 4. Design

Two toggles, one new endpoint, a marker file, a TTL sweep, and a map
that tracks background ffmpeg processes. **Default off.**

### 4.1 Opt-in gates

**Server-side** (either works):

- `ServerSettings.enableIosHlsPersist` (boolean, default `false`), or
- `ENABLE_IOS_HLS_PERSIST=1` env var (overrides the setting; useful for
  headless deployments without the admin UI).

**Client-side:** request body includes `mediaPlayer: "ios-hls"` in
`POST /api/items/:id/play`.

If either side is absent, behavior is byte-identical to upstream.

### 4.2 Session lifecycle

1. Play endpoint starts a `Stream` as today, with one extra
   `transcodeOptions.persistOnClose = true` flag.
2. `Stream.start()` writes a JSON `.persistent` marker into the stream
   dir with `{ userId, createdAt }` (used for cross-user auth on
   teardown).
3. `Stream.close()` — called when the session idle-expires or a new
   session starts for the same user+device — skips the normal
   `fs.remove(streamPath)` when `persistOnClose` is set, and leaves
   ffmpeg running so the transcode can finish in the background even
   after the HTTP session is gone.
4. `HlsRouter` falls back to serving segments directly from disk when
   the in-memory session is gone but the `.persistent` marker exists.
   This is what makes the manifest URL survive session close / server
   restart.
5. `PlaybackSessionManager.removeOrphanStreams()` — invoked at server
   startup **and** nightly at 00:30 local from the existing
   `CronManager.initOpenSessionCleanupCron` — respects the marker:
   persistent dirs are kept unless their marker mtime is older than
   `iosHlsPersistTtlDays` (default **7**), in which case they're
   evicted. Markerless orphan dirs are still deleted exactly as before.
   The nightly cadence closes the "server never restarts → TTL never
   fires" gap that a startup-only check would leave.

### 4.3 Completion signal

`DELETE /api/session/:id/hls-cache`

- Client calls this when `AVAssetDownloadTask` finishes capturing the
  `.movpkg` (or when the user removes the downloaded book).
- Session-independent: works whether the in-memory session still
  exists, has idle-expired, or died with a server restart.
- Ownership: verified against the in-memory session if present,
  otherwise against the `userId` stored in the `.persistent` marker.
  Admin override.
- If ffmpeg is still running (registered in
  `PlaybackSessionManager.persistentStreams` map), SIGKILL first; poll
  for exit up to 2 s before `fs.remove` (otherwise rimraf races
  ffmpeg's segment writes and fails with `ENOTEMPTY`).
- Idempotent: 200 if already gone; 400 on non-UUID; 403 on cross-user
  mismatch; 500 only on terminal filesystem failure.

### 4.4 No response-schema change

The play endpoint response is unchanged. Clients get the same
`audioTracks[0].contentUrl = "/hls/{sessionId}/output.m3u8"` and
`mimeType = application/vnd.apple.mpegurl` they'd get under the
existing browser-transcode path. Chapters continue to ship in
`PlaybackSession.chapters` out-of-band, segmentation-independent.

### 4.5 Segment format

Stays on **mpegts**. The fmp4/iOS workaround in `Stream.js:81` predates
this proposal; if it's stale on current iOS, switching is a separate
follow-up.

## 5. What's implemented on the fork

All of the above is live at commit
[`6092c70f`](https://github.com/walkermc20/audiobookshelf/commit/6092c70f):

| Area | Files touched |
|---|---|
| Opt-in gate + direct-play bypass | [PlaybackSessionManager.js](https://github.com/walkermc20/audiobookshelf/blob/ios-hls-persistent/server/managers/PlaybackSessionManager.js) |
| Persistent-close + marker + isClosed gate + ffmpegExit event | [Stream.js](https://github.com/walkermc20/audiobookshelf/blob/ios-hls-persistent/server/objects/Stream.js) |
| Disk fallback in router | [HlsRouter.js](https://github.com/walkermc20/audiobookshelf/blob/ios-hls-persistent/server/routers/HlsRouter.js) |
| DELETE endpoint + controller (UUID / in-memory / marker / kill / retry) | [SessionController.js](https://github.com/walkermc20/audiobookshelf/blob/ios-hls-persistent/server/controllers/SessionController.js), [ApiRouter.js](https://github.com/walkermc20/audiobookshelf/blob/ios-hls-persistent/server/routers/ApiRouter.js) |
| Server settings (`enableIosHlsPersist`, `iosHlsPersistTtlDays`) + env override | [ServerSettings.js](https://github.com/walkermc20/audiobookshelf/blob/ios-hls-persistent/server/objects/settings/ServerSettings.js) |
| Persistent-ffmpeg tracking for clean teardown | [PlaybackSessionManager.js](https://github.com/walkermc20/audiobookshelf/blob/ios-hls-persistent/server/managers/PlaybackSessionManager.js) |
| OpenAPI stub for the new endpoint | [docs/controllers/SessionController.yaml](https://github.com/walkermc20/audiobookshelf/blob/ios-hls-persistent/docs/controllers/SessionController.yaml) |

Total diff against master: **~230 lines** across server code.

### Test coverage

- **Unit (mocha):** new tests in
  [`test/server/objects/Stream.test.js`](https://github.com/walkermc20/audiobookshelf/blob/ios-hls-persistent/test/server/objects/Stream.test.js),
  [`test/server/controllers/SessionController.test.js`](https://github.com/walkermc20/audiobookshelf/blob/ios-hls-persistent/test/server/controllers/SessionController.test.js),
  and
  [`test/server/managers/PlaybackSessionManager.test.js`](https://github.com/walkermc20/audiobookshelf/blob/ios-hls-persistent/test/server/managers/PlaybackSessionManager.test.js).
  All green in CI (`Run Unit Tests` workflow).
- **Integration:** 14-test browser harness at
  [walkermc20/audiobookshelf-hls-test](https://github.com/walkermc20/audiobookshelf-hls-test)
  exercises the end-to-end flow against a live fork, including
  persistence across session close, cross-user 403 via marker, round-trip
  404 after DELETE, idempotency, ffmpeg-kill race coverage. Latest run:
  [2026-04-23, 14/14 PASS](https://github.com/walkermc20/audiobookshelf-hls-test/blob/main/test-runs/2026-04-23_93ac4c6c_14of14.md).

## 6. Compatibility

| Client | Behavior |
|---|---|
| Web player (`mediaPlayer: "web"`) | Unchanged. |
| Android app | Unchanged; does not send `"ios-hls"`. |
| Official iOS app | Unchanged; does not send `"ios-hls"`. |
| ShelfPlayer (future integration) | Sends `"ios-hls"`, gets persistent manifest URL. |
| Self-hoster who does nothing | Feature off; zero extra ffmpeg load. |

## 7. Risks and deferred items

1. **fmp4/iOS status.** Hardcoded off since 2021 per a workaround
   comment. Revisit in a follow-up if current iOS has resolved the
   original bug; not gating v1.
2. **Cache URL auth.** Session-ID-as-bearer, consistent with how cover
   images and segment requests work today. A signed per-user HMAC
   scheme is a reasonable follow-up but not required for the base
   feature.
3. **Cache-size cap.** Only TTL today, no LRU by bytes. A
   pathological user could exhaust disk. Worth adding
   `iosHlsPersistMaxBytes` as a follow-up.
4. **Per-library opt-in.** Current proposal is server-wide. A
   `LibrarySettings` layer could fold in later for mixed-hardware
   setups.
5. **Transcode load.** Enabling the flag does not change the per-play
   CPU profile vs. the existing browser-transcode path — it just makes
   the output persist. Will document in the settings help text.

## 8. Specific feedback I'd like

One question first, everything else open:

- **Is `enableIosHlsPersist` in `ServerSettings` (plus the
  `ENABLE_IOS_HLS_PERSIST=1` env override) the right opt-in convention,
  or would you prefer a different shape?** A possible alternative is
  grouping it under a nested "transcoding" settings object if one is
  planned, or exposing it only via env var for now.

Everything else (marker-based cross-user auth, DELETE endpoint shape,
TTL-only eviction, no cache-size cap in v1, mpegts over fmp4) is
flexible; happy to change on your read.

## 9. What I'll do next

If direction is roughly acceptable, open a Draft PR from
`walkermc20/audiobookshelf:ios-hls-persistent` into
`advplyr/audiobookshelf:master`. If direction needs a substantive
change, adjust and either update this Discussion or open a revised
one.

---

*Opening this as a Discussion (not an Issue or PR) so the conversation
stays lightweight until the design is locked.*
