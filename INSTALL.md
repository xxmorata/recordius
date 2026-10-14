# Installing Recordius — step by step

This page is written so that **a person or an AI coding agent** can follow it exactly. Give an agent this link
(`https://github.com/xxmorata/recordius/blob/main/INSTALL.md`) and say *"install Recordius for me"*.

Recordius has two parts:

- the **web app** — your team's library and share pages. Install it **once per team**, on a server you control.
- the **Mac app** — the recorder. **Every teammate** installs it.

Everything is free and open source. Your videos stay on the server and storage you choose.

**Pick one way to run the web app:**

| | Choose this if… |
| --- | --- |
| [**Part 1A — Docker**](#part-1a--web-app-with-docker-any-server) | you have (or want) your own server: a VPS, a home server, a NAS. Files stay on that machine. |
| [**Part 1B — Vercel**](#part-1b--web-app-on-vercel) | you want nothing to maintain. Uses free Vercel + Neon tiers. |
| [Other platforms](docs/self-hosting.md#option-c--any-other-platform) | you already use Railway, Render, Fly.io, Coolify… |

---

## Part 1A — Web app with Docker (any server)

**Prerequisites:** a Linux server (or a Mac) with Docker and the Compose plugin. Check with:

```bash
docker compose version      # prints a version → OK
```

No Docker yet? On Ubuntu/Debian: `curl -fsSL https://get.docker.com | sh`.

### 1. Download and configure

```bash
git clone https://github.com/xxmorata/recordius.git
cd recordius
cp .env.example .env
# a random secret for sessions and file links (Linux; on macOS use: sed -i '' …)
sed -i "s/^AUTH_SECRET=.*/AUTH_SECRET=$(openssl rand -hex 32)/" .env
```

### 2a. Just trying it on this computer

```bash
docker compose up -d
```

Open <http://localhost:3000>.

### 2b. On a server with your own domain (recommended)

1. Create a DNS record for your domain (e.g. `videos.example.com`) pointing to the server's IP, and allow ports 80 and 443 in the firewall.
2. Set the domain in `.env`:

   ```bash
   sed -i "s#^APP_URL=.*#APP_URL=https://videos.example.com#" .env
   echo "DOMAIN=videos.example.com" >> .env
   ```

3. Start with automatic HTTPS:

   ```bash
   docker compose --profile https up -d
   ```

### 3. Verify

```bash
docker compose ps                                   # app and db show "healthy" after ~1 minute
curl -s http://localhost:3000/api/health            # {"ok":true}
```

Open your address — it shows **Set up your workspace**. Create your account; you become the owner.

The first start builds the image, which takes 2–5 minutes. To see what's happening: `docker compose logs -f app`.

Files are stored on this server in the `files` Docker volume. To use an S3-compatible bucket (R2, S3, B2, MinIO…) instead, see [storage](docs/self-hosting.md#storage).

---

## Part 1B — Web app on Vercel

**Prerequisites:** a Vercel account (the free tier is fine).

### Fastest: one click

1. Open <https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fxxmorata%2Frecordius%2Ftree%2Fmain%2Fweb&project-name=recordius&repository-name=recordius&env=AUTH_SECRET&envDescription=A%20long%20random%20string%20that%20signs%20sessions%20(e.g.%20openssl%20rand%20-hex%2032)&envLink=https%3A%2F%2Fgithub.com%2Fxxmorata%2Frecordius%2Fblob%2Fmain%2Fdocs%2Fself-hosting.md&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%2C%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D>
2. Vercel asks you to create a **Blob store** (keep it **Private**) and a **Neon Postgres** database. Create both.
3. Enter `AUTH_SECRET`: any long random string (for example, the output of `openssl rand -hex 32`).
4. Click **Deploy**. When it finishes, open the deployment URL. It shows **Set up your workspace**; create your account, and you become the workspace owner.

### Scriptable: Vercel CLI (what an agent should run)

```bash
npm i -g vercel            # if missing
vercel login               # opens the browser once
git clone https://github.com/xxmorata/recordius.git
cd recordius/web
npm install
vercel link --yes --project recordius          # creates the project (pick your team if asked)
vercel blob create-store recordius-videos --access private   # answer "yes" to link it to the project
vercel integration add neon --name recordius-db              # Postgres; sets DATABASE_URL
openssl rand -hex 32 | vercel env add AUTH_SECRET production
openssl rand -hex 32 | vercel env add AUTH_SECRET preview
vercel deploy --prod --yes
```

The last command prints the production URL.

**Verify:** `curl -s https://<your-url>/api/health` returns `{"ok":true}`, and opening the URL shows **Set up your workspace**.

---

## Part 2 — Mac app (every teammate, ~2 minutes)

**Requirements:** macOS 13 or newer (Apple Silicon or Intel).

```bash
# 1. download the latest DMG
curl -L -o ~/Downloads/Recordius.dmg \
  "$(curl -s https://api.github.com/repos/xxmorata/recordius/releases/latest | grep browser_download_url | grep '\.dmg' | cut -d '"' -f 4)"
# 2. install
hdiutil attach ~/Downloads/Recordius.dmg -quiet -nobrowse -mountpoint /Volumes/Recordius
cp -R /Volumes/Recordius/Recordius.app /Applications/
hdiutil detach /Volumes/Recordius -quiet
# 3. the app is signed but not notarized by Apple — clear the download quarantine so it opens without a warning
xattr -dr com.apple.quarantine /Applications/Recordius.app
open -a Recordius
```

(By hand: open the DMG, drag Recordius to Applications, then **right-click → Open** the first time.)

### Connect the app to your workspace

1. In the app, type your Recordius address (e.g. `https://videos.example.com`) and click **Continue in browser**.
2. The web app opens on *Get the app*. Click **Connect desktop app**. The browser hands the app a sign-in token; you never type a password into the app.
   - If nothing happens, click *Paste a connection code instead* in the app and paste the code shown on the web page.
   - If you connect from a link the app didn't open itself, it asks you to confirm the server first. That's a safety check.
3. macOS asks for **Screen Recording** (and Camera/Microphone) once. Turn Recordius on in System Settings, and the app restarts itself. You won't be asked again after updates.

The Mac app needs your server to use **HTTPS**; `http://localhost` also works for testing.

**Verify:** press <kbd>⌘⇧R</kbd>, talk for a few seconds, press <kbd>⌘⇧R</kbd> again. The share link is on your clipboard and the page opens in your browser.

---

## Part 3 — Invite the team

Web app → **Settings → Members & workspace → Create invite link**. Send it. Each teammate creates their account with the link, then does Part 2.

---

## Updating

- **Docker:** `cd recordius && git pull && docker compose up -d --build` (add `--profile https` if you use it).
- **Vercel:** on GitHub, open your copy of the repository and click **Sync fork**. Vercel redeploys automatically.
- **Mac app:** Settings → **Check for updates** inside the app. Updates are signed, verified, and never ask for macOS permissions again.

Database changes are applied automatically when the new version starts.

## Something went wrong?

| Symptom | Fix |
| --- | --- |
| `docker compose up` says `.env` not found | Run `cp .env.example .env` in the `recordius` folder. |
| The page shows errors, or the logs say `AUTH_SECRET is missing` | Set `AUTH_SECRET` in `.env` (step 1), then run `docker compose up -d`. |
| Links point to `localhost` | Set `APP_URL` to your real address, then run `docker compose up -d`. |
| Can't sign in over plain `http://<ip>` | Use HTTPS (step 2b). Plain HTTP only works for `localhost`. |
| HTTPS certificate isn't issued | The domain's DNS must point to this server, and ports 80 and 443 must be open. Check with `docker compose logs https`. |
| Uploads fail with an S3 bucket | The bucket's CORS rule must allow your site and expose `ETag`. See [storage](docs/self-hosting.md#any-s3-compatible-bucket--storages3). |
| Mac app says *Can't reach https://…* | Open that address in the browser. If it doesn't load either, the server is blocked on that network (some countries block `*.vercel.app`): add your own domain or self-host. If it loads, update the app to 1.0.13 or newer; it then uses the Mac's proxy/VPN settings like the browser. The recording is kept locally and uploads on **Retry now**. |
| Mac app issues | See [docs/desktop.md](docs/desktop.md#troubleshooting). |

Still stuck? Open an issue: <https://github.com/xxmorata/recordius/issues>.
