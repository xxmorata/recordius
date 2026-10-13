# Architecture

## Components

```
┌──────────────────────┐   recordius://connect      ┌──────────────────────────────┐
│  Recordius for Mac   │ ◄──────────────────────────│  Web app (Next.js)           │
│  Electron            │   Bearer device token      │  /library /share/:id /embed  │
│  menu bar + dock     │ ──────────────────────────►│  /api/* (REST, JSON)         │
│                      │   POST /api/videos         │                              │
│  MediaRecorder       │   POST /api/videos/:id/…   │  Postgres  ──── videos, users│
│  multipart parts,    │                            │  Storage (private) ─── files │
│  uploaded live       │ ──────────────────────────►│  signed URLs for viewers     │
└──────────────────────┘   signed upload URLs       └──────────────────────────────┘
                                                      Storage = local disk, any S3-compatible
                                                      bucket, or Vercel Blob (web/lib/storage)
```

- **web/** — Next.js 16 (App Router, server components + a few client islands), Tailwind 4, `postgres` driver. No ORM: a handful of SQL files in `db/migrations` and typed query helpers in `lib/`. Files go through one small storage interface (`lib/blob.ts` → `lib/storage/{local,s3,vercel-blob}.ts`).
- **desktop/** — Electron. A hidden "recorder" window owns the capture streams and the `MediaRecorder`; the visible windows are the Loom-style panel, the camera bubble, the vertical control bar and the countdown overlay. The main process runs the state machine (`idle → preparing → recording ⇄ paused → stopping`), the uploader and the updater.

## A recording, step by step

1. **Start** — the desktop app acquires the capture streams (screen via `desktopCapturer`, camera, mic, optional system-audio loopback) and *in parallel* calls `POST /api/videos`. The server inserts a `videos` row (`status = recording`, privacy = workspace default, a random `secret` path segment) and returns the share URL plus an **upload grant** for exactly two files (`videos/<id>/<secret>/video.mp4` and `…/thumb.jpg`), valid 12 hours. With Vercel Blob the grant holds two client tokens restricted to those pathnames; with S3 or local storage the recorder asks `POST /api/videos/:id/upload` for signed part URLs (only the person who recorded the video can, and only for its two files). This mirrors Loom, which hands the recorder temporary per-video S3 credentials before the first frame.
2. **Countdown** — 3-2-1 overlay (content-protected, so it is not captured).
3. **Recording** — `MediaRecorder` emits a chunk every second (H.264/AAC MP4 when the OS provides it). Each chunk is appended to a local file in `~/Movies/Recordius` *and* packed into parts (8 MB; 5 MB with Vercel Blob) that are uploaded immediately as a multipart upload (3 in parallel, with retries). Loom does the same with HLS segments.
4. **Stop** — the link is copied and opened right away. The uploader flushes the last part, completes the multipart upload and calls `POST /api/videos/:id/complete` with duration and size (`status = ready`). The share page polls `GET /api/videos/:id` every 2.5 s until then. If the live upload broke, the whole local file is uploaded instead. If that fails too (or the app quits mid-upload), the recording stays in `pending-uploads.json` in the app's data folder: the app retries on start, every 5 minutes and after the Mac wakes up, asking `POST /api/videos/:id/upload-token` for fresh upload tokens (the original ones expire after 12 hours). A video deleted on the web meanwhile (404) or already finished (409) is dropped from the queue.
5. **Thumbnail** — a frame is grabbed ~1 s into the recording and uploaded with the second token; `POST /api/videos/:id/thumbnail` marks it.

## Access control

| privacy | who can watch |
| --- | --- |
| `link` | anyone with the URL (no account) |
| `workspace` | signed-in members of the video's workspace |
| `private` | the owner, workspace admins, and emails listed in `video_access` |

The share page, the embed page and `GET /api/videos/:id` all go through `accessFor()` in `web/lib/videos.ts`. Only when it returns an access level does the server **sign** URLs for the files (6 h validity): S3 presigned GETs, Vercel Blob presigned URLs, or for local storage `/api/storage/file?p=…&e=…&s=…` with an HMAC over path, expiry and download name. Nothing in storage is reachable without a signed URL; the raw object URL returns 403.

Owners and admins can change privacy, rename, archive and delete; members can only manage their own videos.

## Authentication

- **Browser:** email + password (scrypt), a random session token stored hashed in `sessions`, 90-day httpOnly cookie.
- **Desktop:** a device token (`rcd_…`) stored hashed in `device_tokens`, created by the browser session on `POST /api/desktop/connect` and handed over through the `recordius://connect?server=&token=` deep link (or pasted manually). The app keeps it in a file only the user can read (`~/Library/Application Support/Recordius/device-token`, mode 0600 — the same approach as the gh/vercel/aws CLIs; Keychain-backed storage would make macOS ask for the login password because the app isn't notarized). Tokens can be revoked under *Settings → Connected devices*; the app notices on its next request and shows the sign-in screen.
- **Invites:** random token, hashed in `invites`, optional expiry and max uses. **Password resets:** the same pattern, created by an admin.

## Desktop update model

`Recordius.app` contains only `launcher/index.js`; the actual app (`src/`, `renderer/`, `node_modules`) is in `Contents/Resources/app`. The updater downloads `recordius-app-<version>.tar.gz` from GitHub Releases, verifies it against `SHA256SUMS.txt`, extracts it to `~/Library/Application Support/Recordius/app/<version>/` and writes `current.json`; the launcher loads the newest version on next start. The signed bundle never changes, so macOS keeps the Screen Recording permission (which is tied to the code signature).

## What was taken from Loom

Loom's desktop app (`Loom.app` 0.379, Electron) was studied with [REA](https://github.com/morluto/rea) and static inspection of its JavaScript bundle before this project was designed. The findings that shaped Recordius:

| Observed in Loom | Recordius |
| --- | --- |
| `startNewRecordingSession` returns the video id, share URL and temporary S3 credentials *before* recording | `POST /api/videos` returns the share URL and a per-video upload grant |
| Native recorder (ScreenCaptureKit + VideoToolbox) writes HLS segments that are uploaded while recording | `MediaRecorder` chunks → live multipart upload |
| `CompleteVideo` mutation on stop | `POST /api/videos/:id/complete` |
| `openSharePageAndCopyUrl`: clipboard + open browser | identical |
| Share URL `/share/<32 hex>` | identical shape |
| Local copies for recovery (`RecoverVideo`) | `~/Movies/Recordius` + automatic retry queue |
| Recorder panel: source row, camera row with On/Off, mic row, big *Start recording* button, footer actions; vertical control bar on the left; camera bubble recorded as part of the screen | same layout and copy, minus features Recordius doesn't have (effects, notes, drawing, confetti) |

Nothing from Loom's code or assets is used; only its behaviour was reproduced.
