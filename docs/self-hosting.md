# Self-hosting Recordius

Recordius is a single Next.js app plus a Postgres database and a private Vercel Blob store. Everything your team records stays in *your* database and *your* store.

## Option A — Vercel (recommended)

### One-click

1. Click **Deploy with Vercel** in the [README](../README.md). Vercel forks the repository into your GitHub account and creates a project from the `web/` folder.
2. In the *Storage* step it offers a **Blob store** (keep **Private**) and a **Neon Postgres** database. Create both — the free tiers are enough for a small team.
3. Enter `AUTH_SECRET`: any long random string, for example the output of `openssl rand -hex 32`.
4. Deploy. When it's done, open your new domain: the first visit creates the database tables and shows **Set up your workspace**.

### Manually (existing project)

```bash
git clone https://github.com/xxmorata/recordius && cd recordius/web
npm install
vercel link                               # create or pick a project
vercel blob create-store recordius-videos --access private   # choose a region near your team
vercel integration add neon --name recordius-db              # or any other Postgres, see below
vercel env add AUTH_SECRET production     # paste a long random string
vercel deploy --prod
```

Vercel's own build settings work as-is (framework: Next.js, root directory: `web`).

## Option B — Docker, anywhere

The image is self-contained; you provide Postgres and a Vercel Blob token.

```bash
cd web
docker build -t recordius .
docker run -d --name recordius -p 3000:3000 \
  -e DATABASE_URL='postgres://user:pass@host:5432/recordius' \
  -e BLOB_READ_WRITE_TOKEN='vercel_blob_rw_…' \
  -e AUTH_SECRET="$(openssl rand -hex 32)" \
  -e APP_URL='https://recordius.example.com' \
  recordius
```

Put it behind HTTPS (Caddy, nginx, Traefik, a cloud load balancer). `APP_URL` must be the public HTTPS address — it is embedded in share links and in the desktop app handoff. The database schema is created automatically on the first visit, or run `npm run db:migrate` by hand.

> Why Vercel Blob even when the app runs elsewhere? It is the only storage with everything Recordius relies on — multipart uploads straight from the desktop app with per-video tokens, and signed expiring download URLs — and it works from any host; you only need the token. Create a store at vercel.com → Storage → Blob (choose **Private**) and copy its read-write token. S3-compatible storage is on the roadmap.

## Environment variables

| Variable | Required | What it is |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. `POSTGRES_URL` (set by Vercel's Neon integration) is accepted too. Use the *pooled* URL on serverless hosts. |
| `BLOB_READ_WRITE_TOKEN` | yes | Read-write token of a **private** Vercel Blob store. Set automatically when the store is created from the Vercel dashboard. |
| `AUTH_SECRET` | yes | Signs sessions and sign-in links. Long random string. Changing it signs everyone out. |
| `APP_URL` | on non-Vercel hosts | Public origin, e.g. `https://recordius.example.com`. On Vercel the production domain is detected. |
| `TRUSTED_PROXY_HOPS` | no | Self-hosted only: how many reverse proxies add an `X-Forwarded-For` entry in front of the app (default `1`). Used to find the real client IP for rate limiting password attempts. |
| `ALLOW_OPEN_SIGNUP` | no | `true` lets anyone create their own workspace on this server. Default: invite-only. |

## Database

Any Postgres 14+ works: Neon, Supabase, RDS, Cloud SQL, Railway, Fly, or a container. Migrations live in `web/db/migrations/*.sql` and are applied in order, once, tracked in `schema_migrations`:

- **automatically every time a server instance starts** (`web/instrumentation.ts`), protected by a Postgres advisory lock so parallel instances don't race. Upgrading is therefore just *deploy the new version* — on Vercel, Docker or anywhere else;
- or manually with `npm run db:migrate` (reads `DATABASE_URL` from the environment or `.env.local`), if you prefer to migrate before switching traffic.

Migrations only add tables and columns, so an older deployment keeps working against a newer schema during a rollout.

## Accounts, invites and passwords

- The **first account** created on an empty database becomes the **owner** of the first workspace.
- Everyone else joins through **invite links** (Settings → Members & workspace). Links expire after 14 days and can be revoked. Each account belongs to one workspace.
- Roles: **owner** (everything, incl. transferring ownership), **admin** (members, invites, workspace settings, any video), **member** (own videos + what is shared with them).
- There is **no email sending** in Recordius on purpose — nothing to configure. Password resets are handled by admins: *Members → ⋯ → Create password reset link*, then hand the link over (it is single-use and valid for 2 days).
- Want several independent teams on one server? Set `ALLOW_OPEN_SIGNUP=true`; each sign-up then creates its own workspace.

## Storage layout and privacy

```
videos/<id>/<secret>/video.mp4   the recording (multipart-uploaded while recording)
videos/<id>/<secret>/thumb.jpg   poster frame
videos/<id>/<secret>/thumb-<nonce>.jpg   custom thumbnail (a frame the owner picked)
avatars/<userId>/<nonce>.jpg     profile pictures
```

- The store is **private**: nothing is readable by URL. The desktop app uploads with a token that can only write its own video's two files and expires after 12 hours.
- When someone opens a share page, the server checks the video's privacy (`link` / `workspace` / `private` + invited emails) and only then presigns a URL that expires after 6 hours.
- Deleting a video deletes the database row and the files.

## Updating Recordius

- **Vercel:** merge the upstream changes into your fork (GitHub's *Sync fork* button) — Vercel redeploys automatically.
- **Docker:** `git pull`, rebuild the image, restart the container (migrations run on start).
- The **desktop app** checks the GitHub releases of `xxmorata/recordius` and updates itself without re-asking for macOS permissions. If you fork the project and build your own releases, change `updateRepo` in `desktop/src/config.js`.

## Backups

- Database: your Postgres provider's backups or `pg_dump "$DATABASE_URL" > recordius.sql`.
- Files: Vercel Blob keeps them durably; to export, use `vercel blob list`/`get` or the `@vercel/blob` SDK (`list()` + `get()` with your token).

## Limits worth knowing

- Max video size is 20 GB per recording (set in `web/lib/blob.ts`).
- Share-page video URLs are valid for 6 hours; the page refreshes them in the background.
- Desktop app uploads are chunked in 5 MB parts, 3 in parallel; on a bad connection it finishes the upload from the local copy when you stop, and keeps retrying (also after a restart) until it's done.
- Link previews (oEmbed, `og:image`) are only offered for videos anyone can watch: *Anyone with the link*, no password, not expired. Everything else shows a plain link.
- Comments are visible to workspace members and invited people only — never to anonymous viewers of a public link.
