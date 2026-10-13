# Security

Recordius is built for teams that care where their recordings go. This page explains, in plain words, how your data is protected — and how to tell us if you find a problem.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Instead, use GitHub's private reporting: **[Report a vulnerability](https://github.com/xxmorata/recordius/security/advisories/new)** (repository → *Security* → *Report a vulnerability*).

Include what you found, how to reproduce it, and what an attacker could do with it. We'll confirm within a few days, keep you updated, fix it as fast as we can, and credit you in the release notes unless you'd rather stay anonymous.

Security fixes go into the latest release. Self-hosters get them with a normal update ([how to update](docs/self-hosting.md#updating)).

## Where your data lives

- **On your infrastructure only.** Recordius has no central service. Videos, thumbnails and avatars are stored in the storage *you* configure — a folder on your server, your own S3-compatible bucket, or your own Vercel Blob store — and everything else in *your* Postgres database.
- **No telemetry, no analytics, no tracking.** The web app makes no requests to outside services. The Mac app talks only to your own server, plus GitHub to check for app updates.
- **Open source.** Every line that touches your data is in this repository (MIT license), so you — or anyone — can audit it.

## How it's protected

**Files are never public.**
- Storage is always private. Nobody can open a video by guessing its address.
- To play a video, the server first checks that the viewer may see it, then issues a signed link that expires (6 hours).
- Uploads get their own signed links, limited to that one video's own files.
- The local-disk storage signs links with your `AUTH_SECRET` and refuses any path outside its folder.

**Access control on every request.**
- Each video is *anyone with the link* (optionally with a **password** and an **expiry date**), *workspace members*, or *only you and people you invite*.
- The same check runs for the share page, the embed, the API and link previews.
- Rich previews (oEmbed, thumbnails in Slack or Notion) are only produced for videos anyone can watch: no password, not expired.
- Comments and viewer lists are never shown to anonymous viewers.

**Accounts.**
- Passwords are hashed with scrypt.
- Sessions are random tokens, stored only as hashes, in HttpOnly, SameSite cookies, which are Secure over HTTPS.
- Sign-in, sign-up, invite links, password-reset links and video passwords are rate-limited. Attempts are recorded as keyed hashes, never as raw IP addresses or emails.
- Requests from other websites are refused (Origin check, JSON-only API), which blocks cross-site request forgery.
- Admins reset passwords with single-use links; there's no email server to misconfigure.
- Optional `SETUP_TOKEN` protects the very first sign-up on a fresh public server.

**The Mac app.**
- It never sees your password. The browser hands it a device token through the `recordius://` link.
- That device token can only create and upload recordings; it can't change passwords, members or settings. It's revocable any time under *Settings → Connected devices*, and changing your password disconnects every device.
- Connect links that the user didn't start in the app need an explicit confirmation naming the server, and no website can start or stop a recording.
- **Updates are signed:**
  - Each release's code carries a manifest signed with an Ed25519 key.
  - The app refuses updates whose signature doesn't verify.
  - The launcher (inside the code-signed app) checks the signature again every time it starts.
- Electron is locked down: context isolation, no Node.js in web pages, a content security policy, and fuses that turn off "run as Node", `NODE_OPTIONS` and the debugger.

## Running it safely

- Serve it over **HTTPS** (the Docker setup includes automatic certificates: `docker compose --profile https up -d`).
- Use a long random `AUTH_SECRET` and keep it secret. Anyone with it can sign sessions and file links.
- Keep the app's port closed to the internet and let your HTTPS proxy talk to it (Docker Compose does this by default). Rate limits rely on the client address your proxy reports.
- Keep Postgres and your bucket private. Give Recordius an access key limited to its own bucket.
- Back up the database and files ([how](docs/self-hosting.md#backups-and-moving-hosts)), and update regularly.

## Out of scope

- Attacks that need control of the server, its environment variables or its database.
- Someone who can run programs as you on your Mac. They can do far more than read Recordius' files.
- Missing best-practice headers or scanner findings without a working attack.
- Social engineering, and physical access to unlocked devices.
