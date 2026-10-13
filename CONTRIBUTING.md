# Contributing to Recordius

Thanks for helping. This page gets you from clone to a working local setup in about ten minutes, and explains how the project is laid out and released.

## Local setup

**Prerequisites:** Node 22+, Postgres 14+ (any way you like: Homebrew, Docker, Postgres.app), a Vercel account for a Blob store (free), and `ffmpeg` if you want demo videos.

```bash
git clone https://github.com/xxmorata/recordius && cd recordius

# ── web ──
cd web && npm install
cp .env.example .env.local        # fill in the three required values:
#   DATABASE_URL=postgres://postgres@127.0.0.1:5432/recordius_dev   (create the database first)
#   BLOB_READ_WRITE_TOKEN=…        a *private* Blob store: `vercel blob create-store recordius-dev --access private`,
#                                  then `vercel env pull` in a linked project, or copy the token from the Vercel dashboard
#   AUTH_SECRET=$(openssl rand -hex 32)
npm run dev                       # http://localhost:3000 → /setup creates the schema and the first account
node scripts/seed-demo.mjs        # optional: demo workspace (demo@recordius.local / password1) + 3 real videos

# ── desktop ──
cd ../desktop && npm install
npm start                         # runs from source; connect it to http://localhost:3000 via Get the app → Connect
```

A Postgres in Docker, if you need one: `docker run -d --name rcd-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 5432:5432 postgres:17 && docker exec rcd-pg createdb -U postgres recordius_dev`.

## Tests

| What | Command | Notes |
| --- | --- | --- |
| Web API, end to end (83 checks) | `cd web && npm test` | against the running dev server; **wipes nothing but needs an empty database** (it starts at `/setup`). `BASE=https://…` to target another server. |
| Desktop: panel UI | `cd desktop && RECORDIUS_USER_DATA=/tmp/rcd RECORDIUS_E2E=ui RECORDIUS_E2E_FAKE=1 RECORDIUS_E2E_CONNECT="http://localhost:3000 <device token>" npx electron .` | device token: web → Get the app → Connect desktop app → *Paste a connection code* value |
| Desktop: record → upload → ready | `RECORDIUS_E2E=cam:6000 RECORDIUS_E2E_FAKE=1 …` | fake camera/mic; `screen` / `screen-cam` need the Screen Recording permission |
| Desktop: in-app update | `RECORDIUS_E2E=update RECORDIUS_UPDATE_URL=http://127.0.0.1:8787/latest.json …` | serve a fake release JSON + tarball locally |

Results are written as JSON to `RECORDIUS_E2E_OUT`; `RECORDIUS_E2E_SHOTS=<dir>` saves PNGs of every window.

## Layout

```
web/                     Next.js 16 (App Router)
  app/(auth)/            setup, login, signup, join, reset
  app/(app)/             library, settings, download (signed-in shell)
  app/share/[id]         public share page   app/embed/[id]  iframe player
  app/api/               REST handlers; every handler is wrapped by route() in lib/auth.ts
  lib/                   auth, db (postgres + migrations), blob (private store + presigned URLs), videos (access rules), workspace
  lib/types.ts           shared types/constants — must stay free of server imports (client components import it)
  db/migrations/*.sql    applied in order by scripts/migrate.mjs or on first visit to /setup
desktop/                 Electron
  launcher/              the only code inside the signed .app; loads the newest app code
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

1. Bump `version` in `desktop/package.json` **and** `desktop/launcher/package.json` (they must match the tag).
2. `git tag v1.2.3 && git push origin v1.2.3` — GitHub Actions builds the universal app, signs it, and attaches the DMG, the update tarball and `SHA256SUMS.txt` to a release.
3. Installed apps pick it up through *Settings → Check for updates*.

Signing uses the `MAC_SIGNING_P12` / `MAC_SIGNING_P12_PASSWORD` secrets (a self-signed certificate is enough — see [docs/desktop.md](docs/desktop.md#permissions)). Forks without the secrets get ad-hoc-signed builds that work but ask for Screen Recording again after each update.

## Pull requests

CI runs type-checking and a production build of the web app plus a syntax check of the desktop app. Keep PRs focused; screenshots for UI changes are appreciated.
