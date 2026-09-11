# ZEHEN always-on server (Windows service)

This makes a shop's **server PC serve billing clients whenever it is powered on** —
no one has to log in, launch ZEHEN, or leave a window open, and the owner never
shares their Windows account. It's aimed at shops that run a **separate billing
PC** (most multi-PC shops).

> **Status: opt-in, test-machine-first.** The mechanism is built into the app but
> is **not** wired into the auto-installer yet. You enable it by running a script.
> Validate it on a TEST PC with a COPY of a shop's data before using it on any
> live counter. See "Roll-out protocol" below.

---

## How it works

Normally the database (PostgreSQL) and the API both run **inside `ZEHEN.exe`** —
close the window and clients go down. This feature runs those two as a background
**Windows service** instead:

- The service runs the **same bundled `ZEHEN.exe`** in Node mode
  (`ELECTRON_RUN_AS_NODE=1`) against `electron/service-headless.js` — no window,
  no Chromium. So there's no second runtime to ship.
- It runs as **LocalSystem**, so it starts at boot at the **login screen**, before
  anyone logs in.
- It reads the database **exactly where it already lives**
  (`C:\Users\<owner>\.zehen`). The installer sets `USERPROFILE` for the service so
  every path lookup (database, config, backups) lands on the owner's real data.
  **Nothing is moved.**
- A marker file (`.server-service.json`) tells the desktop `ZEHEN.exe` to stop
  self-hosting and just connect to the service as a local client. This prevents
  two processes ever touching the same database.

### Files involved

| File | Role |
|------|------|
| `electron/service-headless.js` | Headless entry the service runs (starts DB, then the API). |
| `electron/embeddedPostgres.js` | Now accepts `serviceMode:true` so it runs outside the app. |
| `electron/main.js` | Detects the marker and, in service mode, does NOT start its own DB/API. |
| `scripts/service/Install-ZehenServer.ps1` | Registers + starts the service, with backup + rollback. |
| `scripts/service/Uninstall-ZehenServer.ps1` | Removes the service, reverts to in-app mode. |

Nothing above changes behavior for a normal install: with no marker file present,
`ZEHEN.exe` boots its own DB + API **exactly as before**.

---

## Prerequisites

1. **nssm.exe** (the service wrapper). Download from <https://nssm.cc/download> and
   place it at `vendor\nssm\nssm.exe` (or pass `-Nssm <path>`).
2. The bundled Postgres binaries at `vendor\pgsql\bin` (already in the repo /
   packaged app).
3. Admin rights on the server PC.

---

## Roll-out protocol (do this in order)

**Never run the installer on a live shop PC as the first test.** Follow this:

1. **Test box.** On a spare Windows PC, restore a **copy** of a real shop's data to
   `C:\Users\<user>\.zehen` (or just install ZEHEN and enter some test bills).
2. **Install the service** (see below). Watch it report `HEALTHY`.
3. **Reboot the test PC. Do NOT log in.** From a second PC, open
   `http://<test-pc-ip>:3001` in a browser. Confirm you can log in and see the
   data. This is the whole point — it must work at the lock screen.
4. **Verify the data** matches (bill counts, party balances) against the original.
5. **Uninstall** and confirm the PC returns to normal in-app mode with data intact.
6. Only after all of the above pass, use it on a real shop — and even then, take a
   fresh backup first.

---

## Install

From the ZEHEN folder, in an **Administrator** PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\service\Install-ZehenServer.ps1
```

Common options:

```powershell
# The account whose .zehen holds the real data (if not the one you're logged in as):
-OwnerProfile "C:\Users\shopowner"

# A packaged install's exe instead of the dev electron:
-ExePath "C:\Program Files\ZEHEN\ZEHEN.exe" -ScriptPath "C:\Program Files\ZEHEN\resources\app.asar\electron\service-headless.js"

# A brand-new server with no data yet (permits creating a fresh empty DB):
-AllowFresh
```

What the installer does, in order:
1. Verifies admin + finds nssm, the exe, and the headless script.
2. **Refuses to run** if it can't find the existing database and you didn't pass
   `-AllowFresh` — so it can never spin up an empty second set of books.
3. **Backs up** `config.json` + a full `pg_dumpall` into a timestamped folder.
4. Grants SYSTEM + the owner full control on the data dir.
5. Writes the marker so the app stops self-hosting.
6. Registers + starts the service, then **health-checks** `http://127.0.0.1:3001/api/health`.
7. If it isn't healthy in time, it **rolls everything back** so the PC keeps working
   in normal in-app mode.

Then point each billing PC at `http://<server-ip>:3001` (see `LAN_SETUP.md`), and
give the server PC a fixed IP (DHCP reservation, `LAN_SETUP.md` section 6).

---

## Uninstall / revert

```powershell
powershell -ExecutionPolicy Bypass -File scripts\service\Uninstall-ZehenServer.ps1
# add -StopPostgres to also stop the DB cleanly
```

This removes the service + marker and returns the PC to normal in-app mode. **Your
data is never touched.**

---

## Will existing shops get it?

Yes. Because it reads the database where it already sits and requires no schema
change, an existing server PC just needs the new app version plus one run of the
install script (which backs up first). Existing **client** PCs need no change —
they keep pointing at the same `IP:3001`.

---

## Known risks to confirm on the test box

These are the specific things the test-machine run must prove out before any live
use. They are why this is opt-in and not auto-enabled:

1. **Postgres running as LocalSystem.** The data dir was originally created by the
   owner account; the service starts Postgres as SYSTEM. SYSTEM has full access to
   user profiles by default and the installer re-grants ACLs, but confirm Postgres
   actually starts as SYSTEM against the existing cluster after a real reboot.
2. **Running a script inside `app.asar` via `ELECTRON_RUN_AS_NODE`.** In a packaged
   build the headless script lives inside the asar. Confirm the service starts from
   the packaged `ZEHEN.exe` (dev/test from `node_modules\electron` is already
   covered by the script's defaults).
3. **`USERPROFILE` redirection.** Confirm the service's logs
   (`<owner>\.zehen\service.log`) show `home = C:\Users\<owner>\.zehen` — not the
   SYSTEM profile — proving it opened the real database.
4. **Upgrades.** When you ship a new app version, the service must be stopped before
   files are replaced and restarted after. Until the installer integration below is
   done, do this manually (uninstall service -> update -> reinstall service), or
   just re-run the install script after updating.

---

## Deferred: installer-checkbox integration (not yet applied)

Once the above is validated on real hardware, wire it into the host installer so
operators don't run scripts by hand. Planned changes (intentionally **not** made
yet, to avoid shipping an untested privileged installer to live shops):

- `package.json` build config: set `nsis.perMachine: true` for the host build
  (services are machine-level) and add `nssm.exe` to `extraResources`.
- `build/installer.nsh`: add an optional checkbox "Run ZEHEN as an always-on
  server (starts with Windows)"; on tick, run the equivalent of
  `Install-ZehenServer.ps1` with the installed exe + asar script paths; on
  update, stop the service before copying files and restart after; on uninstall,
  remove the service.
- The client build is unchanged throughout.
