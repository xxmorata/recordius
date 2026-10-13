# Loom desktop teardown (REA) → wclone design

Target: `/Applications/Loom.app` 0.379.4 (Electron). Investigated with REA 6.4.0 + static inspection of
the extracted `app.asar`. Nothing was executed; findings are static (shipped-artifact) observations.

REA evidence: application graph of `entrypoint/dist/main` → `ev_43051267ba067d1daceb3eba32b798581ebf2ca22f1c3184afef8582aad8fc25`
(partial: the 11 MB `index.js` exceeded the semantic-analysis heap; string/module facts retained).

## Observed

| # | Observation | Where |
|---|---|---|
| 1 | App code lives in `@loomhq-desktop/entrypoint/dist` — webpacked main process + ~40 renderer windows (`pre_recording_panel`, `camera`, `countdown`, `control_menu`, `recorder`, `cropping`, `drawing`, …). | asar layout |
| 2 | Capture is done by a separate native helper `binaries/loom-recorder-production` (Swift/C++), which links **ScreenCaptureKit**, **VideoToolbox**, AVFoundation, CoreAudio and contains `HlsEncoder`, `HLS sink`, `hls_av_split`. Electron drives it over flatbuffers IPC (`ScreenCaptureSettingsT{displayId, cropRect, enableWindowHiding, windowIdsToHide, …}`). | `otool -L`, `strings`, main bundle |
| 3 | Before recording starts, the app calls GraphQL `startNewRecordingSession(title, videoProperties, privacy…)` which returns the video `id`, an `uploadProxyUrl`, and **temporary S3 credentials scoped to a bucket/path** (`AccessKeyId, SecretAccessKey, SessionToken, Bucket, Region, Path`). So the share URL exists before the first frame. | main bundle |
| 4 | Recording output is **HLS segments** (`mediaMuxingType = hls_av_split`), uploaded **while recording** by an `hlsUploader` (queue size 4, websocket upload proxy with S3 multipart fallback via `@aws-sdk/lib-storage`). Stopping only has to flush the tail, which is why links are instant. | main bundle |
| 5 | On stop: `CompleteVideo(id, videoProperties)` mutation. | main bundle |
| 6 | `openSharePageAndCopyUrl(videoId)`: `clipboard.writeText(\`${host}/share/${videoId}\`)` then `shell.openExternal(url)`. Upload state tracks `shareLinkOpened`. | main bundle |
| 7 | Share URL shape: `/share/([slug-])?{32 hex videoId}`. | renderer + main |
| 8 | The recorder keeps local recordings for recovery (`RecoverVideo`, `CreateTdpRecoveryUploadCredentials`). | main bundle |

## Inferred
- The camera "bubble" is an always-on-top window that is captured as part of the screen (it is not composited in software); control UI windows are excluded from capture via window-hiding (#2).

## Unknown / not investigated
- Server-side transcoding pipeline and the web player (not in the desktop artifact).
- Exact flatbuffers schema of the recorder IPC.

## wclone design (decisions, not observations)

| Loom | wclone |
|---|---|
| `startNewRecordingSession` → id + scoped S3 creds | `POST /api/videos` → id + share URL + **Vercel Blob client tokens scoped to that video's pathnames** |
| Native SCK/VideoToolbox → HLS segments | Electron desktop capture (`getUserMedia` with a `desktopCapturer` source) + `MediaRecorder` → H.264/AAC MP4, 1 s timeslices |
| Live HLS segment upload | Live **Blob multipart upload**: chunks are buffered into 5 MB parts and uploaded during recording |
| `CompleteVideo` | `completeMultipartUpload` + `POST /api/videos/:id/complete` |
| copy link + open share page | identical: clipboard + `shell.openExternal` + notification |
| local recovery copy | every recording is also written to `~/Movies/wclone/` and can be re-uploaded from the tray |
| loom.com/share/:id | Next.js on Vercel: `/share/:id` (public, unlisted), `/` library (key-protected) |
