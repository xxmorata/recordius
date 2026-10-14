# Contributing to Recordius

Thanks for helping. This page gets you from clone to a working local setup in about ten minutes, and explains how the project is laid out and released.

## Local setup

**Prerequisites:** Node 22+, Postgres 14+ (any way you like: Homebrew, Docker, Postgres.app) and `ffmpeg` if you want demo videos. Files are stored on disk (`web/storage/`) by default — no cloud account needed.

```bash
git clone https://github.com/xxmorata/recordius && cd recordius

# ── web ──
cd web && npm install
cp .env.example .env.local        # fill in:
#   DATABASE_URL=postgres://postgres@127.0.0.1:5432/recordius_dev   (create the database first)
#   AUTH_SECRET=$(openssl rand -hex 32)
#   APP_URL=http://localhost:3000
#   optional: S3_* or BLOB_READ_WRITE_TOKEN to develop against a bucket instead of web/storage/
npm run dev                       # http://localhost:3000 → /setup creates the schema and the first account
node scripts/seed-demo.mjs        # optional: demo workspace (demo@recordius.local / password1) + 3 real videos

# ── desktop ──
cd ../desktop && npm install
npm start                         # runs from source; connect it to http://localhost:3000 via Get the app → Connect
```

Or run everything (Postgres + the app) with Docker from the repository root: `cp .env.example .env`, set `AUTH_SECRET`, `docker compose up -d --build`.

A Postgres in Docker, if you need one: `docker run -d --name rcd-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 5432:5432 postgres:17 && docker exec rcd-pg createdb -U postgres recordius_dev`.

## Tests

| What | Command | Notes |
| --- | --- | --- |
| Web API, end to end (~180 checks) | `cd web && npm test` | against a running server; **needs an empty database** (it starts at `/setup`). `BASE=http://localhost:3100` to target another instance. Run it once per storage provider you touch (local, S3 — e.g. MinIO — and Vercel Blob); the suite adapts to whichever the server uses. |
| Desktop: panel UI | `cd desktop && RECORDIUS_USER_DATA=/tmp/rcd RECORDIUS_E2E=ui RECORDIUS_E2E_FAKE=1 RECORDIUS_E2E_CONNECT="http://localhost:3000 <device token>" npx electron .` | device token: web → Get the app → Connect desktop app → *Paste a connection code* value |
| Desktop: record → upload → ready | `RECORDIUS_E2E=cam:6000 RECORDIUS_E2E_FAKE=1 …` | fake camera/mic; `screen` / `screen-cam` need the Screen Recording permission |
| Desktop: upload queue, local-copy cleanup, live uploader | `cd desktop && npm test` | plain Node, no Electron or server needed; runs in CI. The uploader test simulates network outages, a slow uplink (memory cap) and disk errors |
| Desktop: camera & microphone released | `RECORDIUS_E2E=devices` (optionally `RECORDIUS_E2E_PROBE=<binary>` printing `{"mic":bool,"camera":bool}`) | opens, closes, unfocuses and minimizes the panel, records and cancels; fails if any window still holds a camera/mic track (the macOS indicator would stay on) |
| Desktop: crashes and interruptions | `RECORDIUS_E2E=source-ended`, `recorder-crash`, `quit-recording` … | the recorded window disappears; the capture process crashes; ⌘Q mid-recording (then start the app again with `RECORDIUS_E2E_RETRY=1` to see it upload) |
| Desktop: failed upload → retry | `RECORDIUS_E2E=retry RECORDIUS_E2E_FAKE=1 RECORDIUS_E2E_CONNECT=… npx electron .` | queues a "failed" recording, a deleted one and a missing file, then checks the banner and the retry |
| Desktop: quitting really quits | `RECORDIUS_E2E=quit …` | fails if any window blocks ⌘Q / shutdown |
| Desktop: in-app update | `RECORDIUS_E2E=update RECORDIUS_UPDATE_URL=http://127.0.0.1:8787/latest.json …` | serve a fake release JSON + tarball locally |

Results are written as JSON to `RECORDIUS_E2E_OUT`; `RECORDIUS_E2E_SHOTS=<dir>` saves PNGs of every window.

## Layout

```
web/                     Next.js 16 (App Router)
  app/(auth)/            setup, login, signup, join, reset
  app/(app)/             library, settings, download (signed-in shell)
  app/share/[id]         public share page   app/embed/[id]  iframe player
  app/api/               REST handlers; every handler is wrapped by route() in lib/auth.ts
  lib/                   auth, db (postgres + migrations), videos (access rules), workspace, rate-limit
  lib/blob.ts            storage facade; lib/storage/{local,s3,vercel-blob}.ts are the drivers
  lib/types.ts           shared types/constants — must stay free of server imports (client components import it)
  db/migrations/*.sql    applied in order on every server start (instrumentation.ts) or by scripts/migrate.mjs
desktop/                 Electron
  launcher/              the only code inside the signed .app; loads the newest app code if its signature verifies
  src/verify.js          signed manifests for in-app updates (also copied into the launcher)
  src/main.js            windows, state machine (idle → preparing → recording ⇄ paused → stopping), IPC
  src/uploader.js        live multipart upload while recording;  src/updater.js  GitHub-release updates
  renderer/              panel (recorder + sign-in + settings), camera bubble, controls bar, countdown, hidden recorder
  scripts/package.mjs    universal build, signing, DMG + update tarball
docs/                    self-hosting, desktop, architecture (incl. what was borrowed from Loom)
```

## Conventions

- Access control lives in one place: `accessFor()` in `web/lib/videos.ts`. New video features must go through it.
- Every mutation has a test in `web/scripts/test-api.mjs`; add one with your change.
- Errors shown to people are full sentences in plain English ("Sign in to watch this video"), never codes.
- Desktop windows never do their own networking; everything goes through `src/api.js` with the device token.
- Keep `lib/types.ts` dependency-free.

## Releasing the desktop app

1. Bump `version` in `desktop/package.json` (the tag must match it).
2. `git tag v1.2.3 && git push origin v1.2.3` — GitHub Actions builds the universal app, code-signs it, signs the update payload with `UPDATE_SIGNING_KEY`, and attaches the DMG, the update tarball and `SHA256SUMS.txt` to a release.
3. Installed apps pick it up through *Settings → Check for updates*.

Signing uses the `MAC_SIGNING_P12` / `MAC_SIGNING_P12_PASSWORD` secrets (a self-signed certificate is enough — see [docs/desktop.md](docs/desktop.md#permissions)). Forks without the secrets get ad-hoc-signed builds that work but ask for Screen Recording again after each update.

## Pull requests

CI runs type-checking and a production build of the web app plus a syntax check of the desktop app. Keep PRs focused; screenshots for UI changes are appreciated.
