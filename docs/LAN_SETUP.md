# ZEHEN — LAN deployment guide

This guide gets ZEHEN running across an office with 10–20 PCs / laptops / tablets, all billing into a single PostgreSQL database in real time.

There are **two roles** any computer can play:

| Role            | What runs                                    | Who installs it                                       |
| --------------- | -------------------------------------------- | ----------------------------------------------------- |
| **Server PC**   | PostgreSQL + Node API + (optional) Electron  | One PC — usually the main billing counter             |
| **Client PC**   | Either the Electron app, or just a browser   | Every other staff member                              |

Wi-Fi is fine. You do not need a wired LAN.

---

## 1. On the server PC (one-time)

### 1.1 Install PostgreSQL

* Windows: run the official installer from <https://www.postgresql.org/download/windows/>. Set a password for the `postgres` superuser and remember it.
* macOS: `brew install postgresql@16 && brew services start postgresql@16`
* Ubuntu: `sudo apt install postgresql && sudo systemctl enable --now postgresql`

Create the database:

```bash
psql -U postgres -c "CREATE DATABASE billing_erp;"
```

### 1.2 Install the app

```bash
git clone <repo>
cd billing-erp
npm install
```

### 1.3 Configure `.env`

```bash
cp .env.example .env
```

Open `.env` and set at minimum:

```
JWT_SECRET=<paste a long random string here>
DB_PASSWORD=<your postgres password>
NODE_ENV=production
```

Leave `DB_POOL_MAX=30` for a 10–20 client office. Bump to 50 if you have 30+ clients.

### 1.4 Build the frontend

```bash
npm run build
```

This produces a `dist/` folder. The server will auto-detect it and serve the web UI to browser-only clients on port 3001.

### 1.5 Open the firewall

The server listens on TCP port 3001 (HTTP) on every network interface. Allow it through the OS firewall:

* **Windows**: `netsh advfirewall firewall add rule name="ZEHEN" dir=in action=allow protocol=TCP localport=3001`
* **macOS**: System Settings → Network → Firewall → Options → add Node, allow incoming.
* **Ubuntu**: `sudo ufw allow 3001/tcp`

### 1.6 Start the server

```bash
npm run server
```

You should see something like:

```
┌───────────────────────────────────────────────────────────┐
│  ZEHEN server is running                                  │
├───────────────────────────────────────────────────────────┤
│  Local:    http://localhost:3001                          │
│  LAN:      http://192.168.1.50:3001   (Wi-Fi)             │
│  API:      /api/*                                         │
│  Web UI:   served from /dist (browser clients OK)         │
│  Health:   /api/health                                    │
└───────────────────────────────────────────────────────────┘
```

Note the **LAN** URL — that's what every other PC connects to. To keep the server running after you log out, use a service manager:

* Windows: install with `nssm` (`https://nssm.cc`) or use Task Scheduler "At system startup".
* macOS / Linux: a `systemd` unit file or `pm2 start npm -- run server`.

If the server PC sleeps, clients lose the connection. Disable sleep on the server PC (Settings → Power → Sleep → Never).

---

## 2. On every client PC (one-time per machine)

Each client picks **one** of these. You can mix freely — some PCs in Electron, others in a browser, all connecting to the same server.

### 2.1 Option A — Electron app (recommended for billing counters)

Install Node.js + clone + `npm install` on the client too, then:

```bash
npm run build
npm run electron
```

The first time the app launches, the **Server Setup** screen appears. Pick **"Connect to a server on the network"** and type the URL the server PC printed at boot, e.g. `http://192.168.1.50:3001`. Click **Test connection** → **Save and continue**.

After setup the app behaves like any normal billing terminal — silent print to attached thermal/A4 printers works, PDF export goes to the local Downloads folder, Accounting sync runs locally.

### 2.2 Option B — Browser (any PC, laptop, tablet, even iPad / Android)

Just open the server URL in any modern browser:

```
http://192.168.1.50:3001
```

The server delivers the web UI directly. Login, billing, printing (system print dialog instead of silent), reports — everything works. Ideal for staff who only need to look up a customer balance or punch in a quick payment.

The browser path uses the same database as the Electron clients, so a bill saved in a browser appears immediately in another user's Electron list.

> **Bookmark it.** Tell every staff member to bookmark the LAN URL. Browser-mode clients have no Server Setup step; they're always pointed at the server they loaded the page from.

---

## 3. Performance & sizing notes

The defaults are sized for **20 active concurrent users**:

| Tunable                | Default | When to raise it                                        |
| ---------------------- | ------- | ------------------------------------------------------- |
| `DB_POOL_MAX`          | 30      | More than 20 active clients running simultaneously      |
| `DB_STATEMENT_TIMEOUT_MS` | 30000 | A specific report taking longer than 30 s legitimately |

If clients feel sluggish:

1. Run `EXPLAIN ANALYZE` on the slow query — most often it's a missing index in a custom report. The shipped indexes cover the dashboard, aging, party statements, and bill lists.
2. Check `/api/health` from a client browser. If `db: false`, your Postgres has run out of connections (default `max_connections = 100`). Either lower `DB_POOL_MAX` or raise `max_connections` in `postgresql.conf`.
3. Verify gzip is on: `curl -H "Accept-Encoding: gzip" -I http://<server>:3001/assets/index.js` should show `Content-Encoding: gzip`.

---

## 4. Backups

Daily automatic backups already run on the server PC (Settings → Backup). Make sure the backup folder lives on the **server PC**, not a network drive — restoring 5 GB across Wi-Fi is painfully slow.

For belt-and-braces protection, copy the daily backup off-machine nightly via a scheduled task / cron / Windows File History.

---

## 5. Updating

When you ship a new version:

1. Stop the server.
2. `git pull && npm install && npm run build`
3. `npm run server`

Existing client browsers pick up the new UI on next refresh (the server emits `Cache-Control: no-cache` on `index.html`, so they always re-check).

Electron clients: re-run `npm run build && npm run electron` on each client, or distribute a packaged build (out of scope for this guide).

---

## 6. Keeping the server always reachable (packaged ZEHEN.exe installs)

If you installed ZEHEN from the packaged installer (`ZEHEN-Setup-x.y.z.exe`) rather than running `npm run server`, the picture is simpler than sections 1–5 above:

* The **server PC** runs the normal `ZEHEN.exe`. That single app **contains its own PostgreSQL database and the API server** — you do *not* install Postgres separately, and you do *not* run `npm run server`.
* Every other PC runs the **client build** (`ZEHEN-Client-Setup.exe`), which is a thin window that only talks to the server PC over the LAN.

Two things must stay true for the shop to keep working. Both are one-time setups.

### 6.1 The server PC's IP address must never change

Each client remembers the server as a fixed address like `http://192.168.1.50:3001`, saved in `C:\Users\<name>\.zehen\client-config.json`. If the router later hands the server PC a **different** IP, every client shows *"Couldn't reach the shop PC"* and you'd have to re-type the new address on each one.

The fix is a **DHCP reservation** on your router — it permanently ties the server PC to one IP. Do this once and clients never drop because of an address change.

**Step-by-step (works on almost any home/shop router — TP-Link, D-Link, Netgear, Jio/Airtel fibre box, etc.):**

1. **Find the server PC's current IP and MAC address.** On the server PC, open Command Prompt and run:
   ```
   ipconfig /all
   ```
   Under your active adapter (Wi-Fi or Ethernet), note:
   * **IPv4 Address** — e.g. `192.168.1.50`
   * **Physical Address** — e.g. `A4-B1-C2-D3-E4-F5` (this is the MAC; it never changes for that PC).

2. **Log into the router.** Open a browser on any PC and go to the router's address — usually `192.168.1.1` or `192.168.0.1` (it's the "Default Gateway" line from `ipconfig`). Enter the router admin password (often printed on a sticker under the router).

3. **Find the DHCP reservation screen.** It's under a menu named one of: *DHCP → Address Reservation*, *LAN → DHCP Server → Static Leases*, *Advanced → IP Reservation*, or *Connected Devices → (pick device) → Reserve IP*. Terminology varies by brand but the idea is identical.

4. **Add a reservation:** pick the server PC (often listed by its computer name), or paste its **MAC address**, and assign it the IP it already has (`192.168.1.50`). Save / Apply. The router may reboot briefly.

5. **Verify.** Restart the server PC, run `ipconfig` again, and confirm it still shows `192.168.1.50`. From then on that IP is locked to the server PC.

> **Alternative — static IP on the PC itself.** If your router has no reservation option, set a fixed IP directly in Windows (Settings → Network → your adapter → IP assignment → Manual). Only do this if you're comfortable choosing an address *outside* the router's DHCP pool to avoid clashes — the DHCP reservation above is safer and preferred.

Once the IP is locked, point each client at it once (client's setup screen → type `http://192.168.1.50:3001` → Connect) and they'll stay connected across reboots.

### 6.2 The server ZEHEN app must be running

On the server PC, clients only work **while `ZEHEN.exe` is open**. Closing that window takes the whole shop offline (it stops the API). So:

* **Don't close ZEHEN on the server PC during business hours.** Minimise it instead.
* **Disable sleep** on the server PC: Settings → System → Power → *Screen and sleep* → set **"When plugged in, put my device to sleep after"** to **Never**. A sleeping server PC drops every client.

**Auto-start ZEHEN when the server PC boots** (so nobody has to remember to open it):

1. Press `Win + R`, type `shell:startup`, press Enter. This opens the Startup folder.
2. Right-click your desktop **ZEHEN** shortcut → **Copy**, then **Paste** it into that Startup folder.
3. ZEHEN will now launch automatically every time that PC reaches the Windows desktop.

For a truly hands-off server PC, also enable **automatic login** so it reaches the desktop without someone typing the Windows password after a power cut:

1. Press `Win + R`, type `netplwiz`, press Enter.
2. Select the user account, untick **"Users must enter a user name and password to use this computer"**, click Apply, and enter the password when prompted.

> Only enable auto-login on the dedicated server PC in a physically secure spot (e.g. behind the counter) — it removes the Windows password prompt on that machine.

With 6.1 + 6.2 done, the server PC boots → logs in → launches ZEHEN → serves clients, all on its own, at an address that never changes.

---

## Troubleshooting

**"Couldn't reach the server" in Server Setup**
The host PC, the firewall, or the LAN itself is blocking the connection. From a client browser, try `http://<server-ip>:3001/api/health`. If you see `{"status":"ok",…}`, the server is fine and the Electron app's URL was wrong. If the browser also can't reach it, fix the firewall first.

**Bills disappear / "Database connection lost"**
Server PC went to sleep, lost Wi-Fi, or PostgreSQL crashed. Check `/api/health` — if `db: false`, restart Postgres on the server. Sequelize auto-reconnects so clients recover within a few seconds once the DB is back.

**Printing doesn't work in browser mode**
Browser mode uses the system print dialog (Ctrl+P) — there's no silent print without Electron. If you need silent / thermal printing on a PC, install the Electron app on it instead of using a browser.

**Two users save the same bill number**
The DB enforces uniqueness on `(bill_number)` — the second save returns an error. The form auto-fetches the next number on every save attempt, so this is rare. If you see it consistently, your clients' clocks are out of sync; install NTP / Windows Time on every PC.
