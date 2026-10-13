<p align="center">
  <img src="web/public/brand/mascot-512.png" alt="" width="140">
</p>
<h1 align="center">Recordius</h1>
<p align="center">
  Record your screen and camera, share a link in seconds — like Loom, but open source and <b>hosted by you</b>.<br>
  Your team's videos live in your own database and storage. No limits, no per-seat pricing.
</p>

<p align="center">
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fxxmorata%2Frecordius%2Ftree%2Fmain%2Fweb&project-name=recordius&repository-name=recordius&env=AUTH_SECRET&envDescription=A%20long%20random%20string%20that%20signs%20sessions%20(e.g.%20openssl%20rand%20-hex%2032)&envLink=https%3A%2F%2Fgithub.com%2Fxxmorata%2Frecordius%2Fblob%2Fmain%2Fdocs%2Fself-hosting.md&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%2C%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D"><img src="https://vercel.com/button" alt="Deploy with Vercel"></a>
</p>

---

**Recordius** is two things:

- **A web app** (Next.js) — your team's video library, share pages with a polished player, workspaces, invites, and privacy controls. Deploy it to Vercel in a few clicks, or run it anywhere with Docker.
- **A Mac app** (Electron) — press <kbd>⌘⇧R</kbd>, record your screen with a camera bubble, press it again: the link is already on your clipboard. The video uploads *while* you record, so there is nothing to wait for.

<p align="center">
  <img src="docs/images/library.jpg" alt="Library" width="49%">
  <img src="docs/images/share.jpg" alt="Share page" width="49%">
</p>
<p align="center">
  <img src="docs/images/desktop-panel.png" alt="Desktop recorder" width="32%">
  <img src="docs/images/desktop-settings.png" alt="Desktop settings" width="32%">
</p>

## Features

- **Instant links** — the share URL exists before the first frame; stopping just flushes the last few seconds.
- **Screen + camera bubble, screen only, or camera only**, any display or a single window, mic, optional system audio.
- **Privacy per video**: anyone with the link · workspace members only · only you and people you invite by email.
- **Workspaces & invites** — the first person to open the site becomes the owner; teammates join through invite links. Roles: owner, admin, member.
- **Library**: search, rename, archive, delete, view counts, "Workspace" tab for videos shared by teammates.
- **Player**: speed control, keyboard shortcuts, picture-in-picture, fullscreen, link-at-timestamp (`?t=1m23s`), embed code.
- **Private storage** — files sit in a private Vercel Blob store; viewers get short-lived signed URLs only after the access check.
- **Updates that keep permissions** — the Mac app is signed with a stable certificate and updates itself; macOS never asks for Screen Recording access twice.
- **No vendor lock-in for your data**: Postgres (any provider) + Vercel Blob. Everything is exportable.

## Get started

> **Using an AI coding agent?** Give it this link and say *"install Recordius for me"*:
> `https://github.com/xxmorata/recordius/blob/main/INSTALL.md` — it contains every command, in order, with verification steps.

### 1. Deploy the web app

**Vercel (recommended, ~5 minutes):** click the *Deploy with Vercel* button above. It creates the project, a private Blob store and a Neon Postgres database, and asks you for one value: `AUTH_SECRET` (any long random string, e.g. `openssl rand -hex 32`). When the deployment finishes, open it — the first visit creates the database schema and lets you create your account and workspace.

**Anywhere else (Docker):** see [docs/self-hosting.md](docs/self-hosting.md).

### 2. Install the Mac app

Download `Recordius-<version>-mac.dmg` from the [latest release](https://github.com/xxmorata/recordius/releases/latest), drag it to Applications, and **right-click → Open** the first time (the app is not notarized with Apple).

### 3. Connect the app to your workspace

In the web app go to **Get the app → Connect desktop app**. Your browser opens Recordius and signs it in; no password typing. Then allow *Screen Recording* when macOS asks and you are ready: <kbd>⌘⇧R</kbd> to record.

### 4. Invite your team

**Settings → Members & workspace → Create invite link.** Send the link; teammates create their account with it and connect their own Mac the same way.

## Documentation

- [Self-hosting](docs/self-hosting.md) — Vercel, Docker, environment variables, database, storage, updates, backups.
- [Desktop app](docs/desktop.md) — install, connect, permissions, shortcuts, troubleshooting, building from source.
- [Architecture](docs/architecture.md) — how recording, uploading and access control work; what was borrowed from Loom.

## Development

```bash
# web
cd web && cp .env.example .env.local   # fill in DATABASE_URL, BLOB_READ_WRITE_TOKEN, AUTH_SECRET
npm install && npm run dev             # http://localhost:3000 → /setup
npm test                               # end-to-end API test against the running dev server (needs a scratch DB)
node scripts/seed-demo.mjs             # demo workspace + sample videos (needs ffmpeg)

# desktop
cd desktop && npm install && npm start # runs from source; connect it to http://localhost:3000
npm run package                        # builds Recordius.app and installs it to ~/Applications
```

## License

[MIT](LICENSE). Recordius is not affiliated with Loom.
