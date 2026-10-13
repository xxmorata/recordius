# Self-hosting Recordius

Recordius is one web app (Next.js) plus a Postgres database and a place for files. You run all three; nothing is sent anywhere else. Pick whichever way of hosting fits you — they all run the same code and the same features.

| | You need | Files are stored | Good for |
| --- | --- | --- | --- |
| [**A — Docker Compose**](#option-a--docker-compose-any-server) | a server with Docker (any Linux VPS, a home server, a NAS, a Mac) | on that server (a Docker volume) — or your own bucket | full control, everything on your own machine |
| [**B — Vercel**](#option-b--vercel) | a Vercel account | your private Vercel Blob store — or your own bucket | zero maintenance, free tier |
| [**C — Any other platform**](#option-c--any-other-platform) | Railway, Render, Fly.io, Coolify, Dokku, Kubernetes… | an S3-compatible bucket, or a persistent disk | if you already use one of them |

Jump to: [storage](#storage) · [environment variables](#environment-variables) · [HTTPS and proxies](#https-and-reverse-proxies) · [accounts](#accounts-invites-and-passwords) · [updating](#updating) · [backups](#backups-and-moving-hosts) · [limits](#limits)

---

## Option A — Docker Compose (any server)

**Requirements:** Docker with the Compose plugin (`docker compose version` works), 1 GB of RAM, disk space for your videos. Works on x86-64 and ARM (Raspberry Pi 4/5, Apple Silicon, Graviton).

```bash
git clone https://github.com/xxmorata/recordius.git
cd recordius
cp .env.example .env
```

Edit `.env` — only two values are required:

```bash
AUTH_SECRET=<output of: openssl rand -hex 32>
APP_URL=http://localhost:3000          # the address people will open
```

Start it:

```bash
docker compose up -d
```

The first start builds the image (2–5 minutes). Open `APP_URL` → **Set up your workspace** → create your account (you become the owner).

**Check it works:** `curl -s http://localhost:3000/api/health` prints `{"ok":true}`, and `docker compose ps` shows `app` and `db` as `healthy`.

### With your own domain and HTTPS

1. Point your domain's DNS (an `A`/`AAAA` record) at the server and open ports 80 and 443.
2. In `.env`: `DOMAIN=videos.example.com` and `APP_URL=https://videos.example.com`.
3. `docker compose --profile https up -d`

The bundled [Caddy](https://caddyserver.com) gets a Let's Encrypt certificate and renews it by itself. Already running nginx, Traefik or Caddy? Skip the profile and proxy to `127.0.0.1:3000` — see [HTTPS and reverse proxies](#https-and-reverse-proxies).

> **Why HTTPS matters:** browsers only keep the sign-in cookie securely, and the Mac app only connects to servers, over HTTPS (plain `http://localhost` is fine for trying it out on your own computer).

### Trying it from another computer without a domain

The app port is only reachable from the server itself by default. For a quick test on your network, set `HTTP_BIND=0.0.0.0` and `APP_URL=http://<server-ip>:3000` in `.env` and run `docker compose up -d` again. For real use, set up a domain with HTTPS.

### What runs

| Service | What | Data |
| --- | --- | --- |
| `db` | Postgres 17 (not reachable from outside the Compose network) | volume `db` |
| `app` | Recordius, as an unprivileged user | volume `files` (`/data`) — recordings, thumbnails, avatars |
| `https` (optional) | Caddy with automatic certificates | volume `caddy` |

### Without Compose

```bash
cd web && docker build -t recordius .
docker run -d --name recordius -p 127.0.0.1:3000:3000 -v recordius-files:/data \
  -e DATABASE_URL='postgres://user:pass@db-host:5432/recordius' \
  -e AUTH_SECRET="$(openssl rand -hex 32)" \
  -e APP_URL='https://videos.example.com' \
  recordius
```

---

## Option B — Vercel

1. Click **Deploy with Vercel** in the [README](../README.md#vercel). Vercel copies the repository to your GitHub account and creates a project from `web/`.
2. In the *Storage* step, create a **Blob store** (keep it **Private**) and a **Neon Postgres** database. The free tiers are enough for a small team.
3. Enter `AUTH_SECRET` (e.g. the output of `openssl rand -hex 32`).
4. Deploy, open your domain → **Set up your workspace**.

Prefer your own bucket (R2, S3…) over Vercel Blob? Skip the Blob store and add the [S3 variables](#any-s3-compatible-bucket--storages3) to the project instead. Any Postgres works too (Supabase, RDS…): set `DATABASE_URL`.

With the CLI instead of the button:

```bash
git clone https://github.com/xxmorata/recordius && cd recordius/web
npm install
vercel link                                   # create or pick a project
vercel blob create-store recordius-videos --access private
vercel integration add neon --name recordius-db
openssl rand -hex 32 | vercel env add AUTH_SECRET production
vercel deploy --prod
```

Root directory `web`, framework Next.js — Vercel detects both.

---

## Option C — Any other platform

Recordius is a standard Node.js web app. Any platform that can run it and give it a Postgres database works.

1. **App:** build `web/Dockerfile` (Railway, Render, Fly.io, Coolify, Dokku, CapRover, Kubernetes…), or run it as a Node 22 service with root directory `web`, build command `npm ci && npm run build`, start command `npm start`.
2. **Database:** the platform's Postgres add-on, or any hosted Postgres 14+. Set `DATABASE_URL`.
3. **Files:** an [S3-compatible bucket](#any-s3-compatible-bucket--storages3) (recommended on platforms whose disks are temporary), or a persistent volume mounted at `/data` with `STORAGE=local`.
4. **Settings:** `AUTH_SECRET`, `APP_URL` (your public HTTPS address), plus the storage variables.

Schema migrations run automatically every time the app starts.

---

## Storage

Choose with `STORAGE` (or leave it out: the provider is picked from whichever settings are present — `S3_BUCKET`, then `BLOB_READ_WRITE_TOKEN`, otherwise local disk).

Whatever you choose, **files are never public**: the app hands out short-lived signed links (6 hours to watch, 12 hours to upload) only after checking that the person may see the video. Uploads are tied to one video and can't touch any other file.

### Local disk — `STORAGE=local`

The default for Docker and plain servers. Files are kept in `STORAGE_DIR` (`/data` in the Docker image, `./storage` otherwise) and served by Recordius itself through signed `/api/storage/…` links. Nothing to configure. Make sure the folder is on a persistent disk and part of your backups.

### Any S3-compatible bucket — `STORAGE=s3`

AWS S3, Cloudflare R2, Backblaze B2, Wasabi, Hetzner Object Storage, DigitalOcean Spaces, Scaleway, MinIO, Garage, SeaweedFS…

```bash
STORAGE=s3
S3_BUCKET=recordius
S3_REGION=auto                     # your bucket's region; "auto" for R2
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com   # leave empty for AWS S3
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
S3_FORCE_PATH_STYLE=false          # true for MinIO, Garage and most self-hosted servers
```

1. Create a **private** bucket (no public access).
2. Create an access key that can read, write and delete objects in that bucket only.
3. **CORS.** Browsers upload to and play straight from the bucket, so it must allow your site. Recordius tries to set this rule itself on start, and logs a warning if your provider doesn't allow that (MinIO and Garage allow every origin by default, so there's nothing to do there). To set it by hand:

   ```json
   [{ "AllowedOrigins": ["https://videos.example.com"], "AllowedMethods": ["GET", "HEAD", "PUT"],
      "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"], "MaxAgeSeconds": 3600 }]
   ```

   Cloudflare R2: *R2 → bucket → Settings → CORS policy*. AWS: *S3 → bucket → Permissions → CORS*. `ETag` must be exposed, or browser uploads fail.
4. Optional: a lifecycle rule that aborts incomplete multipart uploads after 7 days.

### Vercel Blob — `STORAGE=vercel-blob`

A **private** Vercel Blob store; set `BLOB_READ_WRITE_TOKEN` (done automatically when you connect the store to a Vercel project). Works from any host, not just Vercel.

### Switching later

Copy the files to the new place keeping their paths (`videos/…`, `avatars/…`), change the settings and restart. For example, from local disk to S3: `aws s3 sync /path/to/files s3://recordius/` (or `rclone copy`), then set the `S3_*` variables.

---

## Environment variables

| Variable | Required | What it is |
| --- | --- | --- |
| `AUTH_SECRET` | **yes** | Long random string (`openssl rand -hex 32`). Signs sessions and file links. Changing it signs everyone out. |
| `APP_URL` | **yes** (except on Vercel) | The public address, e.g. `https://videos.example.com`. Used in share links, file links and by the Mac app. `https://` here also makes cookies Secure. |
| `DATABASE_URL` | **yes** | Postgres connection string. `POSTGRES_URL` (set by Vercel's Neon integration) works too. Use the *pooled* URL on serverless hosts. Docker Compose sets it for you. |
| `STORAGE` | no | `local`, `s3` or `vercel-blob`. Default: picked from the settings below. |
| `STORAGE_DIR` | no | Folder for `STORAGE=local`. Default `/data` in Docker, `./storage` otherwise. |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | for S3 | See [S3-compatible bucket](#any-s3-compatible-bucket--storages3). `S3_SKIP_CORS=true` turns off the automatic CORS setup. |
| `BLOB_READ_WRITE_TOKEN` | for Vercel Blob | Token of a **private** Vercel Blob store. |
| `ALLOW_OPEN_SIGNUP` | no | `true` lets anyone create their own workspace on this server. Default: invite-only after the first account. |
| `SETUP_TOKEN` | no | If set, creating the very first account (the owner) asks for this value — useful when a fresh server is reachable from the internet before you've set it up. |
| `TRUSTED_PROXY_HOPS` | no | How many reverse proxies add an `X-Forwarded-For` entry in front of the app (default `1`). Used to rate-limit by the real client address. |
| Docker Compose only: `DOMAIN`, `HTTP_PORT`, `HTTP_BIND`, `POSTGRES_PASSWORD` | no | See the comments in [`.env.example`](../.env.example). |

---

## HTTPS and reverse proxies

Run Recordius behind HTTPS for anything other than a local test. With your own proxy, forward to the app and pass the usual headers:

```nginx
server {
  server_name videos.example.com;
  client_max_body_size 64m;           # upload parts are 8 MB
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;              # stream video and uploads
    proxy_request_buffering off;
  }
}
```

Rate limiting (sign-in, link passwords) uses the right-most `X-Forwarded-For` entries — the ones your proxies add. Keep the app port closed to the outside (Compose binds it to `127.0.0.1`) so nobody can talk to the app around the proxy, and set `TRUSTED_PROXY_HOPS` if more than one proxy sits in front of it.

---

## Accounts, invites and passwords

- The **first account** on an empty database becomes the **owner** of the first workspace (protect this step with `SETUP_TOKEN` if the server is public before you set it up).
- Everyone else joins through **invite links** (*Settings → Members & workspace*). Links expire after 14 days and can be revoked.
- Roles: **owner** (everything, incl. transferring ownership), **admin** (members, invites, workspace settings, any video), **member** (own videos + what's shared with them).
- **No email server needed.** Password resets are done by admins: *Members → ⋯ → Create password reset link*, then hand over the link (single-use, valid 2 days).
- Sharing a private video "by email" works for people who already have an account on this server; for everyone else, use a link with a password.
- Several independent teams on one server: `ALLOW_OPEN_SIGNUP=true` — each sign-up creates its own workspace.

---

## Updating

- **Docker Compose:** `git pull && docker compose up -d --build`
- **Vercel:** on GitHub, open your copy of the repository and click **Sync fork** — Vercel redeploys by itself.
- **Other platforms:** redeploy from the latest `main` (or a release tag).

Database migrations run automatically when the new version starts and only add tables and columns, so an older instance keeps working during a rolling update. The **Mac app** updates itself (*Settings → Check for updates*); updates are signed and verified before they're installed.

---

## Backups and moving hosts

- **Database:** your provider's backups, or `pg_dump "$DATABASE_URL" > recordius.sql` (Docker: `docker compose exec db pg_dump -U recordius recordius > recordius.sql`).
- **Files:** the `files` volume / `STORAGE_DIR` folder, or your bucket (most providers offer versioning). For Vercel Blob, copy with the `@vercel/blob` SDK or the `vercel blob` CLI.
- **Moving:** restore the dump into the new database, copy the files with their paths, point the new instance at both. Keep the same `AUTH_SECRET` to keep everyone signed in.

---

## Limits

- Videos up to 20 GB each. Uploads go in 8 MB parts (5 MB with Vercel Blob), several in parallel, and the Mac app resumes from its local copy after a failure.
- Watch links last 6 hours; open pages refresh them by themselves.
- The recorder is a Mac app (macOS 13+). Watching, commenting and uploading files work in any modern browser.
