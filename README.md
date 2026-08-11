# P2P File Drop

Browser-to-browser file transfer with no cloud storage in the middle. Two people
open this app, pair with a short code, connect directly over WebRTC, and
transfer a file with true resumability — if the connection drops or a tab
closes mid-transfer, the download picks back up from exactly where it left
off instead of restarting.

A small Node server is included, but only to bootstrap the WebRTC handshake
(exchange pairing codes and SDP/ICE messages) and to serve the one HTML file.
It never sees file names, file contents, or file sizes — those travel only
over the encrypted WebRTC DataChannel, directly between the two browsers.

## Requirements

- **Chrome or Edge** (recent version) on both ends. This app relies on the
  File System Access API (`showOpenFilePicker` / `showSaveFilePicker`) for
  resumable, random-access disk writes, which Firefox and Safari don't
  support. There's no fallback — unsupported browsers get a clear message
  instead of a broken experience.
- **Node.js** (v18+; developed against v25) to run the signaling server.

## Running it

```bash
cd server
npm install
npm start
```

The port comes from `server/.env` (`PORT=...`; falls back to `8087` if the
file or variable is absent). Copy `server/.env.example` to `server/.env` and
edit it to change the port — `server/.env` is gitignored since it's local
config, not code.

This serves the app at `http://localhost:8097` (see `server/.env`). Open that URL in two
separate browser profiles (e.g. a normal window and an Incognito window, or
two different Chrome profiles) to act as the two participants — separate
profiles matter because each participant's pairing code, peer identity, and
transfer history live in that browser's own `localStorage`/IndexedDB.

## Using it

1. Each person opens the app and sees their own 6-character code at the top.
2. Person A pastes Person B's code into the "Connect" field and clicks
   **Connect**.
3. Person B sees an Accept/Deny prompt. Denying shows Person A an error
   dialog; accepting establishes the WebRTC connection.
4. Once connected, either person can click **Choose File…** to pick a file
   and share it. The other person sees it appear in their **Transfers** list
   with a **Download** button.
5. Clicking **Download** picks a save location and starts the transfer,
   with a live progress bar.
6. If the page is closed or the connection drops mid-transfer, reopening the
   app shows the file in the Transfers list as "interrupted." Re-pair with a
   fresh code (pairing codes are one-time use, so this step always needs a
   new code — see **Known limitations** below) and click **Resume** — only
   the missing chunks are re-transferred, not the whole file.

## Deploying beyond one machine

`http://localhost` is a "secure context" as far as the browser is concerned,
so the steps above work for two browser profiles on one machine. For two
people on two different networks, the server needs to be reachable over
**HTTPS** (the client automatically switches to `wss://` for signaling when
the page itself is loaded over `https://`, so no code changes are needed —
see `client/index.html`'s `Signaling.connect()`).

Two easy ways to get an HTTPS URL in front of the server (adjust the port
below to match `server/.env`):

- **A small VPS behind [Caddy](https://caddyserver.com/):** a one-line
  Caddyfile gets you automatic TLS:
  ```
  your-domain.com {
    reverse_proxy localhost:8097
  }
  ```
- **Ad-hoc testing with no server of your own:** `ngrok http 8097` or a
  Cloudflare Tunnel gives you an instant HTTPS URL pointed at your local
  process.

### Running as a systemd socket-activated service

For a VPS/always-on box, `deploy/install.sh` installs the server as a
systemd socket unit instead of a plain long-running service: systemd owns
port `8097` (from `server/.env`) and starts the Node process on demand on
the first incoming connection, restarting it automatically if it crashes.

```bash
cd server && npm install     # install ws once, if you haven't
sudo ./deploy/install.sh
```

The script must run with `sudo` (it writes to `/etc/systemd/system` and
calls `systemctl`) but must be invoked as your normal user (`sudo ...`, not
logged in as `root`) so the service runs as you rather than as root. It
reads `PORT` from `server/.env`, locates `node` on your `PATH` (nvm
installs included), and generates/installs two units from the templates in
`deploy/`:

- `webrtc-fileshare.socket` — owns the port, `WantedBy=sockets.target`
- `webrtc-fileshare.service` — runs `node server.js`, started by the socket

Useful commands afterwards:

```bash
systemctl status webrtc-fileshare.socket webrtc-fileshare.service
journalctl -u webrtc-fileshare.service -f
sudo ./deploy/uninstall.sh   # tear it down
```

If you change the port in `server/.env` later, re-run
`sudo ./deploy/install.sh` — the port is baked into the socket unit at
install time, since systemd unit files can't read `.env` files directly.

## Known limitations (by design, not bugs)

- **No TURN relay.** Only public STUN servers are used for NAT traversal, so
  the transfer stays genuinely peer-to-peer with no data-center intermediary.
  On some restrictive networks (notably symmetric NAT / strict corporate
  firewalls on both ends) a direct connection simply can't be established —
  the app shows a dialog explaining this rather than silently failing.
- **Pairing codes are one-time.** Reconnecting after a full page close
  always requires exchanging a fresh code — there's no silent auto-reconnect.
  The "Previous Connections" list is a local contact/history log to make
  that easier (you know who you were talking to and what you were
  transferring), not a live reconnect mechanism.
- **Chrome/Edge only**, no fallback for other browsers.
- **~32 MB / 2s worst-case data loss on an ungraceful crash** (tab killed via
  Task Manager, power loss). Graceful disconnects (closing the tab, losing
  the peer connection) checkpoint immediately with no loss beyond that
  point. This trade-off avoids constantly flushing to disk on every single
  256 KB chunk.
- **No cryptographic whole-file integrity check.** WebRTC's SCTP transport
  already carries a per-message checksum, which is why this wasn't deemed
  necessary for the MVP.
- If a participant's browser storage is cleared, their peer identity changes
  and any in-progress transfers with them become orphaned in the other
  side's Transfers list (removable, but not automatically cleaned up).

## Testing notes

The pairing → connect → accept/deny → connected flow was verified end to end
with an automated two-browser-context test (distinct codes, deny → error
dialog → fresh code reissued, accept → connected state on both sides,
invalid/self/busy code errors). That test isn't part of this repo — it was
a throwaway script, since there's no ongoing test suite here.

The file Share/Download/Resume path uses native OS file-picker dialogs
(`showOpenFilePicker` / `showSaveFilePicker`), which browser automation
tools can't drive (confirmed: Chromium doesn't route these through the
`filechooser` interception point automation tools use for `<input
type="file">`). That part needs a manual pass — walk through the "Using it"
steps above with two real browser windows, including killing a tab mid-
transfer and resuming, and diff the downloaded file against the source to
confirm it's byte-identical.
