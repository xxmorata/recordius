# Recordius for Mac

## Install

1. Download `Recordius-<version>-mac.dmg` from the [latest release](https://github.com/xxmorata/recordius/releases/latest) (macOS 13+, Apple Silicon and Intel).
2. Open the DMG and drag **Recordius** to **Applications**.
3. First launch: **right-click the app → Open → Open**. The app is signed but not notarized with Apple, so macOS shows a warning once. (Alternatively: `xattr -dr com.apple.quarantine /Applications/Recordius.app`.)

Recordius lives in the menu bar and the Dock. It starts at login by default (Settings → *Open at login*).

## Connect it to your workspace

The app never asks for your password. It is connected from the web app:

1. Open Recordius. It shows **Welcome to Recordius** with a field for your workspace address.
2. Type the address of your Recordius site (for example `https://recordius.yourstudio.com`) and press **Continue in browser**. Already signed in on the web? You can also go straight to *Get the app* in the web app's sidebar.
3. In the browser, click **Connect desktop app**. The browser opens `recordius://connect?…`; the app stores a device token and shows your name and workspace.
4. If the browser can't open the app (some browsers block custom links), click **Paste a connection code instead** in the app and paste the code shown on the web page.

You can see and disconnect devices under **Settings → Connected devices** in the web app.

## Permissions

macOS asks for three things, once:

| Permission | Why | When |
| --- | --- | --- |
| Screen Recording | capture your screen | first time the recorder panel opens; **requires a restart of the app** — Recordius restarts itself when it sees the permission |
| Camera | the camera bubble | first time the panel opens |
| Microphone | your voice | first time the panel opens |

System audio uses macOS's built-in loopback (macOS 13+) and needs no extra driver; if it isn't available on your Mac, the recording continues without it and you get a notification.

**Updates keep your permissions.** macOS ties the Screen Recording permission to the app's code-signing identity. Recordius releases are signed with one stable certificate, and in-app updates (*Settings → Check for updates*) don't touch the signed bundle at all, so you are asked exactly once — not after every update, and not after installing a newer DMG.

If you build the app yourself, create your own certificate once so your builds behave the same way (any self-signed one works):

```bash
# one-time: creates "Recordius Code Signing" in its own keychain
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes -subj "/CN=Recordius Code Signing" \
  -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=critical,codeSigning" \
  -keyout /tmp/rcd.key -out /tmp/rcd.crt
openssl pkcs12 -export -inkey /tmp/rcd.key -in /tmp/rcd.crt -name "Recordius Code Signing" -passout pass:recordius -out /tmp/rcd.p12
KC=~/Library/Keychains/recordius-signing.keychain-db
security create-keychain -p recordius "$KC" && security unlock-keychain -p recordius "$KC"
security import /tmp/rcd.p12 -k "$KC" -P recordius -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k recordius "$KC"
security list-keychains -d user -s "$KC" login.keychain-db
```

`npm run package` picks the certificate up automatically; in GitHub Actions put the `.p12` (base64) and its password into the `MAC_SIGNING_P12` / `MAC_SIGNING_P12_PASSWORD` secrets. Without a certificate builds are ad-hoc signed and every build is a "new app" to macOS.

## Recording

| | |
| --- | --- |
| Start / stop | <kbd>⌘⇧R</kbd>, the menu-bar icon, the Dock menu, or the panel |
| Pause / resume | <kbd>⌘⇧P</kbd> or the control bar |
| What to record | **Full screen** (per display), a **window**, or **Camera only** |
| Camera | any camera or off; mirror on/off; bubble size S/M/L (hover the bubble); drag it anywhere; it is recorded as part of the screen |
| Microphone | any mic or off; live level meter; *Also record system audio* |
| Quality | 720p / 1080p / 1440p |
| Countdown | 3-2-1 on/off |

When you stop:

1. the share link is copied to your clipboard and opened in your browser,
2. the last seconds finish uploading (the video uploaded while you recorded),
3. the page starts playing by itself and you get a *Your video is ready* notification.

Every recording is also saved to `~/Movies/Recordius`. If an upload doesn't finish (offline, laptop closed, app quit), Recordius keeps it in a queue and uploads it by itself — on the next start, every few minutes and after the Mac wakes up. The panel shows a banner with **Retry now**, and the menu-bar menu has **Retry failed uploads**.

**Keep local copies** (Settings) removes copies older than 7 or 30 days, or never (the default is 30 days). Only files that finished uploading are ever removed — a copy that might be the only one is always kept.

The control bar (left edge of the screen) has: stop, timer, pause, restart, delete, and a camera-bubble toggle. It is excluded from the recording.

## Settings

Settings (gear icon or <kbd>⌘,</kbd>): countdown, mirror camera, quality, bubble size, open at login, shortcuts, recordings folder, how long to keep local copies, sign out, check for updates. The default **privacy** of new recordings is a *workspace* setting in the web app (Settings → Members & workspace); each video can be changed afterwards.

## Troubleshooting

- **"Screen recording is off" stays on after enabling it** — click *Relaunch* in the panel, or quit and reopen the app. If System Settings lists two "Recordius" entries, remove the stale one (−) and toggle the remaining one.
- **No windows in the picker** — the window list appears only after Screen Recording is allowed.
- **"macOS isn't sharing your screen yet"** — Recordius is allowed, but macOS is holding the screen back. Usually a macOS prompt is waiting for you ("… would like to record this screen", or the monthly "continue to allow?" question). If there's none, open *System Settings → Privacy & Security → Screen & System Audio Recording*, switch Recordius off and on, then click *Relaunch*.
- **The browser didn't open the app** — use *Paste a connection code instead*.
- **"Connect Recordius to …?"** — the app shows this when a connect link didn't come from the app's own *Continue in browser* step (for example after you signed in again in between). Check that the address is your Recordius server, then click *Connect*. Never connect to an address you don't recognise.
- **"Enter your workspace address" / can't connect** — the server must use `https://` (only `http://localhost` is allowed without it).
- **"This Mac is no longer connected"** — the device was disconnected from the web app; connect it again from *Get the app*.
- **Recording works but the share page says "uploading" for a long time** — open the panel: if the upload didn't finish, a banner shows **Retry now** (the app also retries by itself). The local file is in `~/Movies/Recordius`.
- Logs: run `/Applications/Recordius.app/Contents/MacOS/Recordius` from Terminal to see output.

## Build from source

```bash
cd desktop
npm install
npm start                         # run from source (connect it to your dev server, e.g. http://localhost:3000)
npm run package                   # Recordius.app → ~/Applications (universal binary)
node scripts/package.mjs --release  # + DMG, update tarball and SHA256SUMS in dist/release
```

Releases are built by GitHub Actions: bump `version` in `desktop/package.json`, then `git tag v1.2.3 && git push origin v1.2.3`. The workflow uploads the DMG, the update tarball and checksums to a GitHub release, which installed apps pick up through *Check for updates*.

### Signed updates

In-app updates only install when the app code is signed with the project's update key. The build writes `manifest.json` (SHA-256 of every file) and `manifest.sig` (Ed25519) into the app code; the updater refuses anything that doesn't verify, and the launcher inside the code-signed `.app` checks it again on every start before loading an update. The bundle is also built with Electron fuses that disable `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect`.

**Publishing your own releases (forks):**

```bash
# one-time: create your own update key
node -e 'const {generateKeyPairSync}=require("crypto");const k=generateKeyPairSync("ed25519");
console.log(k.privateKey.export({type:"pkcs8",format:"pem"}));console.log(k.publicKey.export({type:"spki",format:"pem"}))'
```

Put the private key in `~/.config/recordius/update-signing.pem` (local builds) and in the repository secret `UPDATE_SIGNING_KEY` (GitHub Actions); paste the public key into `PUBLIC_KEY` in `desktop/src/verify.js`; set `updateRepo` in `desktop/src/config.js` to your repository. Apps you build then only accept updates signed by you.

### Automated tests

```bash
RECORDIUS_USER_DATA=/tmp/rcd-test RECORDIUS_E2E=ui RECORDIUS_E2E_FAKE=1 \
  RECORDIUS_E2E_CONNECT="http://localhost:3000 rcd_…" npx electron .        # clicks through the panel
RECORDIUS_USER_DATA=/tmp/rcd-test RECORDIUS_E2E=cam:6000 RECORDIUS_E2E_FAKE=1 npx electron .   # records with a fake camera and uploads
```

Other modes: `retry` (failed uploads are queued and finished later), `deeplink` (connect links from other websites need confirmation), `quit`, `update` (with `RECORDIUS_UPDATE_URL` pointing at a test release), `signin`. `npm test` runs the upload-queue unit test without Electron.

`RECORDIUS_E2E_FAKE=1` uses Chromium's synthetic camera and microphone, so the tests need no macOS permissions; `screen` and `screen-cam` modes need Screen Recording.
