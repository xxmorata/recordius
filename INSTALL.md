# Installing Recordius — step by step

This page is written so that **a person or an AI coding agent** can follow it verbatim. Give an agent this link
(`https://github.com/xxmorata/recordius/blob/main/INSTALL.md`) and the instruction *"install Recordius for me"*.

Recordius has two parts: the **web app** (your team's library and share pages) and the **Mac app** (the recorder).
Install the web app once per team; every teammate installs the Mac app.

---

## Part 1 — Web app on Vercel (one-time, ~5 minutes)

**Prerequisites:** a Vercel account (free tier is fine). Nothing else.

### Fastest: one-click

1. Open <https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fxxmorata%2Frecordius%2Ftree%2Fmain%2Fweb&project-name=recordius&repository-name=recordius&env=AUTH_SECRET&envDescription=A%20long%20random%20string%20that%20signs%20sessions%20(e.g.%20openssl%20rand%20-hex%2032)&envLink=https%3A%2F%2Fgithub.com%2Fxxmorata%2Frecordius%2Fblob%2Fmain%2Fdocs%2Fself-hosting.md&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%2C%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D>
2. Vercel asks you to create a **Blob store** (keep **Private**) and a **Neon Postgres** database. Create both.
3. Enter `AUTH_SECRET`: any long random string (e.g. run `openssl rand -hex 32`).
4. Click **Deploy**. When it finishes, open the deployment URL — it shows **Set up your workspace**. Create your account; you are the workspace owner.

### Scriptable: Vercel CLI (what an agent should run)

```bash
npm i -g vercel            # if missing
vercel login               # opens the browser once
git clone https://github.com/xxmorata/recordius.git
cd recordius/web
npm install
vercel link --yes --project recordius          # creates the project (pick your team if asked)
vercel blob create-store recordius-videos --access private --region fra1   # pick a region near the team
#   → answer "yes" to link the store to the project (sets BLOB_READ_WRITE_TOKEN)
vercel integration add neon --name recordius-db                           # Postgres; sets DATABASE_URL
openssl rand -hex 32 | vercel env add AUTH_SECRET production
openssl rand -hex 32 | vercel env add AUTH_SECRET preview
vercel deploy --prod --yes
```

The last command prints the production URL. Open it → **Set up your workspace**.

**Verify:** `curl -sI https://<your-url>/` returns a redirect to `/setup` (empty database) or `/login`.

### Other hosts (Docker)

See [docs/self-hosting.md](docs/self-hosting.md#option-b--docker-anywhere). You need Postgres, a private Vercel Blob token and HTTPS.

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
# 3. the app is signed but not notarized by Apple — clear the download quarantine so it opens without the warning
xattr -dr com.apple.quarantine /Applications/Recordius.app
open -a Recordius
```

(Doing it by hand: open the DMG, drag Recordius to Applications, then **right-click → Open** the first time.)

### Connect the app to your workspace

1. In the app, type your Recordius address (e.g. `https://recordius.yourstudio.com`) and click **Continue in browser**.
2. The web app opens on *Get the app*. Click **Connect desktop app**. The browser hands the app a sign-in token (`recordius://connect?…`); you never type a password into the app.
   - If nothing happens, click *Paste a connection code instead* in the app and paste the code from the web page.
3. macOS asks for **Screen Recording** (and Camera/Microphone) once. Turn Recordius on in System Settings; the app restarts itself. You won't be asked again after updates.

**Verify:** press <kbd>⌘⇧R</kbd>, talk for a few seconds, press <kbd>⌘⇧R</kbd> again. The share link is on your clipboard and the page opens in your browser.

---

## Part 3 — Invite the team

Web app → **Settings → Members & workspace → Create invite link**. Send it. Each teammate creates their account with the link, then does Part 2.

---

## Updating

- **Web app on Vercel:** on GitHub, open your fork and click **Sync fork** (or merge `upstream/main`). Vercel redeploys automatically. New database migrations run on the next visit of `/setup` for empty databases; for a live database run `npm run db:migrate` with the production `DATABASE_URL` (see [docs/self-hosting.md](docs/self-hosting.md#updating-recordius)).
- **Mac app:** Settings → **Check for updates** inside the app. Updates install without asking for macOS permissions again.

## Something went wrong?

- Database or storage errors on the web → check the four variables in [docs/self-hosting.md](docs/self-hosting.md#environment-variables).
- Mac app issues → [docs/desktop.md](docs/desktop.md#troubleshooting).
- Still stuck → open an issue: <https://github.com/xxmorata/recordius/issues>.
