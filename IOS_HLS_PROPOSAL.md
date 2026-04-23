# Proposal: opt-in HLS output for iOS clients (AVAssetDownloadURLSession support)

**Status:** Draft for upstream issue on `advplyr/audiobookshelf`
**Author:** (fill in)
**Audience:** ABS server maintainers + iOS client authors (ShelfPlayer, official app)

---

## 1. Motivation

Third-party iOS clients (notably [ShelfPlayer](https://github.com/rasmuslos/ShelfPlayer)) currently ship **two parallel playback paths**:

1. **Stream** — progressive MP3/M4B fetched from `/api/items/:id/file/:ino` and handed to `AVPlayer`.
2. **Offline** — a separately‑downloaded file copy played from local storage.

Downstream consequences in the client:

- Hundreds of lines of branching on `isDownloaded?` in playback, progress‑sync, and artwork paths.
- An artificial guard preventing a download while the same item is playing (the two paths can't share a file handle).
- A scrub/prefetch buffer the client has to manage by hand.
- Download progress and playback progress are separate subsystems that have to be kept in sync.

Apple's `AVAssetDownloadURLSession` is designed to collapse this into **one pipeline**:

- It streams HLS during playback *and* writes a persistent `.movpkg` to disk.
- The same `AVPlayer` replays the `.movpkg` offline without any code path change in the app.
- "Download this" becomes a boolean on the asset download task (keep the `.movpkg` vs. let the OS evict it) rather than a separate subsystem.
- Scrub buffering is handled by AVFoundation.

The only requirement on the server is: **return an HLS manifest URL from the iOS playback‑session response**, while leaving progressive MP3/M4B output in place for Android, the web client, and self‑hosters who don't want HLS.

## 2. Non‑goals

- **Not** replacing the direct‑play path for Android/web.
- **Not** turning on HLS by default. Weak‑hardware self‑hosters (RPi, NAS) should not be forced to transcode.
- **Not** introducing video HLS or adaptive bitrate — single audio rendition only.
- **Not** changing chapter metadata (already returned out‑of‑band, works today).
- **Not** addressing the "dumb client" / low‑power hardware case. That's the orthogonal direction proposed in [#5003](https://github.com/advplyr/audiobookshelf/issues/5003) (direct MP3 + server‑side seeking for ESPHome / Squeezebox / DLNA). Both proposals push ABS toward an explicit per‑client‑class output matrix rather than one‑size‑fits‑all, and they don't conflict — this one adds iOS‑HLS, #5003 adds a no‑HLS path for hardware that can't speak it at all.

## 2.5 Prior art

- **[#2040 — Playback Options (force HLS)](https://github.com/advplyr/audiobookshelf/issues/2040)** (opened Aug 2023, no maintainer response in 2+ years). Asks for a user‑facing checkbox / dropdown to force the existing browser HLS transcode when client codec detection is wrong. It's narrower than this proposal (UI only, no new client class, no persistent cache) and arguably already addressable today via the `forceTranscode` field on the play endpoint — closer to a user‑error workaround than a missing feature. **Suggest the maintainers consider closing #2040**: its stated problem ("certain files not playing because the client incorrectly reports the codec is supported") is a codec‑detection bug in the client, not a server capability gap. If a UI toggle is still wanted after this proposal ships, it becomes a trivial client‑side follow‑up on top of the `mediaPlayer: "ios-hls"` plumbing below.
- **[#5003 — Direct MP3 Stream with server‑side seeking](https://github.com/advplyr/audiobookshelf/issues/5003)** (opened Jan 2026). Complementary rather than overlapping — see Non‑goals above. Endorsed direction.

## 3. Current state in `advplyr/audiobookshelf`

Investigation performed on `master` (commit `b41db239`, v2.33.2).

### 3.1 HLS already exists — for browser transcode

- `server/objects/Stream.js` drives ffmpeg, produces a `.m3u8` + `output-%d.ts` (mpegts) in `{MetadataPath}/streams/{sessionId}/`. Segment length is 6 s. `hls_playlist_type vod`, `hls_list_size 0` — the manifest is complete up front.
- `server/utils/generators/hlsPlaylistGenerator.js` pre‑writes the full manifest before ffmpeg starts, so clients see the duration immediately.
- `server/routers/HlsRouter.js` serves `GET /hls/:stream/:file`, mounted in `server/Server.js` **outside** the auth middleware. It authenticates by looking up the streamId in `PlaybackSessionManager.getStream()`; an unguessable UUID is the bearer credential.
- `server/managers/PlaybackSessionManager.js` `startSession()` decides direct‑play vs. transcode:
  ```js
  const shouldDirectPlay = options.forceDirectPlay
    || (!options.forceTranscode
        && libraryItem.media.checkCanDirectPlay(options.supportedMimeTypes, episodeId))
  ```
  When it transcodes, it hands the client a single `AudioTrack` with `contentUrl = "/hls/{sessionId}/output.m3u8"` and `mimeType = application/vnd.apple.mpegurl`.

### 3.2 fmp4 is deliberately off on iOS

`Stream.js` hardcodes `hlsSegmentType = 'mpegts'` with a comment linking `advplyr/audiobookshelf-app#85` (fmp4 + iOS broke playback at the time). The fmp4 code path exists but is unreachable. **This workaround predates this proposal and may be stale** — worth retesting on modern iOS, but not a blocker.

### 3.3 Chapters are already segmentation‑independent

`PlaybackSession.setData()` populates `this.chapters = libraryItem.media.getChapters(episodeId)` and `toJSONForClient()` ships them on every session response. Nothing in the HLS pipeline aligns segment boundaries to chapter starts, and nothing needs to — chapters are consumed from the session JSON by the client, not from the manifest.

### 3.4 No persistent HLS cache

Stream directories are deleted on session close and by an orphan sweeper in `PlaybackSessionManager.removeOrphanStreams()`. Sessions idle‑expire at **36 hours**. That's fine for browser playback but a blocker for `AVAssetDownloadURLSession`, which may take longer than 36 h to finish on slow connections and will definitely be resumed across days.

### 3.5 Settings pattern

`server/objects/settings/ServerSettings.js` is the standard home for server‑wide booleans. Fields are declared in the constructor, rehydrated in `construct()`, serialized in `toJSON()` / `toJSONForBrowser()`, and surfaced in the admin settings UI.

## 4. Proposed design

Two server‑side knobs and a small request/response addition. **Default off.**

### 4.1 Server settings (new)

Added to `ServerSettings`:

| Field | Type | Default | Description |
|---|---|---|---|
| `enableHlsForIos` | bool | `false` | When true, iOS clients may request an HLS response from the play endpoint even if the source file would direct‑play. |
| `persistHlsCache` | bool | `false` | When true, HLS output for an item is written to a persistent cache dir and reused across sessions. Requires `enableHlsForIos`. |
| `hlsCacheMaxBytes` | int | `0` (unlimited) | Soft cap; LRU eviction when exceeded. |

Admin UI: a single "iOS HLS output" section under the existing transcoding/playback settings, with the second two checkboxes greyed out unless the first is on.

### 4.2 Play endpoint (changed)

`POST /api/items/:id/play` and `.../play/:episodeId` already accept `mediaPlayer`, `forceTranscode`, `forceDirectPlay`, `supportedMimeTypes`. Add one optional field:

```jsonc
{
  "mediaPlayer": "ios-hls",      // existing field, new recognized value
  "supportedMimeTypes": [...],   // unchanged
  "forceTranscode": false        // unchanged
}
```

`PlaybackSessionManager.startSession()` gains a branch: if `mediaPlayer === 'ios-hls'` **and** `serverSettings.enableHlsForIos`, bypass the direct‑play check and return HLS regardless of source MIME type. Otherwise the existing logic runs unchanged. No response‑schema change — the client gets the same `audioTracks[0].contentUrl = "/hls/{sessionId}/output.m3u8"` shape it would today under a transcode path.

### 4.3 Persistent cache path (when `persistHlsCache=true`)

- Cache dir: `{MetadataPath}/hlsCache/{libraryItemId}/{episodeId|'book'}/`
- On first iOS‑HLS request for an (itemId, episodeId): ffmpeg runs as today, but output goes to the cache dir instead of a session‑scoped dir, and the session's stream record is **not** unlinked on session close.
- Subsequent iOS‑HLS requests for the same (itemId, episodeId) skip ffmpeg and return a manifest URI directly.
- Invalidation: on library rescan, if the underlying audio file's mtime/size changed, delete the cache entry for that item.
- Eviction: LRU by `hlsCacheMaxBytes`. Manual purge via a new admin endpoint `DELETE /api/admin/hls-cache/:libraryItemId` (and a "Clear all" button).

### 4.4 Manifest URL and auth

Recommend **option A** for minimum change:

- Reuse `/hls/:stream/:file`. When persistent caching is on, `:stream` is a deterministic id derived from `(libraryItemId, episodeId)` rather than a per‑session UUID.
- `HlsRouter` gains a lookup that checks the cache dir in addition to `PlaybackSessionManager.getStream()`.
- Auth remains **session‑ID‑as‑bearer**: the manifest URL contains a secret. The play endpoint is authenticated, and only an authenticated user can obtain a manifest URL for an item they can access. Once obtained, the URL is the credential — equivalent to how cover image URLs work today.

Note for `AVAssetDownloadURLSession` implementers: AVFoundation does accept custom HTTP headers per request via `AVAssetResourceLoaderDelegate`, so a signed‑token scheme is possible as a follow‑up. Not required for v1.

**Open question:** should the cache URL embed a per‑user HMAC to prevent a leaked URL from being shared across users? Can be added later without breaking v1 clients.

### 4.5 Segment format

Stay on **mpegts**. The fmp4/iOS issue (`audiobookshelf-app#85`) predates this proposal; investigating whether it still applies on current iOS is a separate task and shouldn't gate this feature. mpegts already works on iOS today via `AVPlayer` and will work with `AVAssetDownloadURLSession`.

### 4.6 Chapters

No change. `PlaybackSession.chapters` already ships in the play‑endpoint response; ShelfPlayer reads it from JSON, not from the manifest. Segment boundaries remain fixed 6 s and do not need to align to chapters.

## 5. Scope estimate

Broken into two shippable phases:

### Phase 1 — on‑demand iOS HLS (MVP)

- Add `enableHlsForIos` setting + admin UI toggle.
- Add `mediaPlayer: "ios-hls"` branch in `startSession()`.
- Extend session idle timeout for `ios-hls` sessions (or better: keep session alive while `HlsRouter` is still serving its files).
- Integration tests against play endpoint (no existing HLS test coverage; will add).

**Estimated effort:** ~1–2 weeks of focused work. No new infra, mostly config plumbing and a test fixture.

### Phase 2 — persistent HLS cache

- Cache dir + lookup in `HlsRouter`.
- Cache invalidation hook in the library scanner.
- LRU eviction loop + `hlsCacheMaxBytes` wiring.
- Admin endpoint + UI for manual purge.
- Cache generation can reuse existing `Stream` by parameterizing output dir and "don't delete on close" flag.

**Estimated effort:** ~2–4 weeks. Bulk of the risk is invalidation and eviction correctness.

Phase 1 alone is usable by ShelfPlayer for streaming playback. `AVAssetDownloadURLSession` **downloads** need Phase 2 to survive multi‑day fetches and session expiry.

## 6. Compatibility

- Progressive MP3/M4B direct‑play: unchanged for all existing clients.
- Browser HLS transcode path (`mediaPlayer: 'web'` with unsupported MIME): unchanged.
- Android clients: unchanged; they do not send `mediaPlayer: 'ios-hls'`.
- Self‑hosters who do nothing: feature is off; no ffmpeg load added.

## 7. Risks and open questions

1. **fmp4/iOS status.** The comment in `Stream.js:81` references a 2021‑era bug. If it's resolved, a follow‑up could switch to fmp4 for better `AVAssetDownloadURLSession` ergonomics. Not blocking v1.
2. **Auth on leaked URLs.** Session‑ID‑as‑bearer is consistent with how the rest of ABS treats media URLs, but a signed per‑user token for cache URLs is a reasonable follow‑up.
3. **Cache eviction policy.** LRU by total bytes is the simplest; an alternative is per‑item age. Open to maintainer preference.
4. **Per‑library vs. server‑wide opt‑in.** Current proposal is server‑wide. A `LibrarySettings.enableHlsForIos` could layer on if libraries have mixed hardware budgets.
5. **Test coverage.** There are currently no HLS‑specific tests in `/test`. v1 should add a test fixture covering: play endpoint returning HLS when enabled, `HlsRouter` serving segments, and fallback when disabled.
6. **Transcode load on first play.** Even in Phase 1, any iOS‑HLS session triggers ffmpeg. Self‑hosters who enable the flag should expect the same CPU profile as a browser transcode session. Document in the settings help text.

## 8. What I'd like feedback on before writing code

- Does a new `mediaPlayer` value feel right, or would maintainers prefer a boolean like `preferHls: true`?
- Is `ServerSettings` the right home, or should this live under a nested "transcoding" settings object if one is being planned?
- Any objection to the cache path layout (`{MetadataPath}/hlsCache/...`)?
- Preference on auth model for cache URLs in Phase 2 (session‑ID‑as‑bearer vs. HMAC)?

---

*Filed against advplyr/audiobookshelf. No code changes proposed in this issue — scoping only.*
