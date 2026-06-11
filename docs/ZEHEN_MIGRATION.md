# Migrating an existing install from `billing_erp` to `zehen`

As of the clean-codebase rebrand (commit `5131270`), a ZEHEN build looks for its
data under `~/.zehen` and Postgres databases named `zehen` / `zehen_master` /
`zehen_co_<id>`. An install created **before** the rebrand still has `~/.billing-erp`
and `billing_erp*` databases, so the new build would see an empty system until the
data is migrated.

This one-time migration is **non-destructive** — it renames databases (a catalog-only
`ALTER DATABASE`, the table data never moves) and renames the data folder. It was
performed and verified on the primary dev PC (988 parties / 14,260 sales bills,
every total matched to the paisa). Follow it on any other machine that has real data.

> **Golden rule:** take the verified `pg_dump` backup in Step 1 first. If anything
> goes wrong you can always restore it into a fresh cluster.

Paths below assume the bundled Postgres that ships with the app. Adjust `$bin` if the
machine uses a system Postgres.

```powershell
# 0. Setup — close the app first, then locate binaries + creds
Get-Process -Name "Billing ERP","ZEHEN" -ErrorAction SilentlyContinue | Stop-Process -Force
$bin  = "C:\Program Files\Billing ERP\resources\pgsql\bin"   # or C:\Program Files\ZEHEN\resources\pgsql\bin
$cfg  = Get-Content "$env:USERPROFILE\.billing-erp\config.json" -Raw | ConvertFrom-Json
$port = $cfg.db.port            # embedded PG is usually 5433, NOT 5432
$env:PGPASSWORD = $cfg.db.password
$C = @("-h","127.0.0.1","-p","$port","-U","postgres")

# Embedded PG only runs while the app runs. If `psql ... -l` fails, start it:
#   & "$bin\pg_ctl.exe" start -D "$env:USERPROFILE\.billing-erp\pgdata" -o "-p $port -c listen_addresses=127.0.0.1" -w

# 1. BACKUP every billing_erp* database, then verify the main one restores clean
$bkp = "$env:USERPROFILE\zehen-migration-backup-$(Get-Date -Format yyyyMMdd_HHmm)"
New-Item -ItemType Directory -Force $bkp | Out-Null
$dbs = & "$bin\psql.exe" @C -d postgres -tAc "SELECT datname FROM pg_database WHERE datname LIKE 'billing_erp%'"
foreach ($d in $dbs) { & "$bin\pg_dump.exe" @C -Fc -f "$bkp\$d.dump" $d }
Copy-Item "$env:USERPROFILE\.billing-erp\config.json" "$bkp\"
# verify: restore the primary DB into a scratch copy and eyeball the row counts
& "$bin\psql.exe" @C -d postgres -c "DROP DATABASE IF EXISTS zehen_verify_tmp; CREATE DATABASE zehen_verify_tmp;"
& "$bin\pg_restore.exe" @C -d zehen_verify_tmp --no-owner "$bkp\billing_erp.dump"
& "$bin\psql.exe" @C -d zehen_verify_tmp -c "SELECT count(*) AS parties FROM parties;"
& "$bin\psql.exe" @C -d postgres -c "DROP DATABASE zehen_verify_tmp;"

# 2. Confirm nothing is connected, then RENAME every billing_erp* database
& "$bin\psql.exe" @C -d postgres -c "SELECT datname,count(*) FROM pg_stat_activity WHERE datname LIKE 'billing_erp%' GROUP BY datname;"
foreach ($d in $dbs) {
  $new = $d -replace '^billing_erp','zehen'
  & "$bin\psql.exe" @C -d postgres -v ON_ERROR_STOP=1 -c "ALTER DATABASE `"$d`" RENAME TO `"$new`";"
}

# 3. Repoint the company registry (handles primary + every billing_erp_co_N)
& "$bin\psql.exe" @C -d zehen_master -v ON_ERROR_STOP=1 -c "UPDATE companies SET db_name = replace(db_name,'billing_erp','zehen');"

# 4. Stop PG, rename the data folder, fix the master name in config.json
& "$bin\pg_ctl.exe" stop -D "$env:USERPROFILE\.billing-erp\pgdata" -m fast -w
Move-Item "$env:USERPROFILE\.billing-erp" "$env:USERPROFILE\.zehen"
$c = Get-Content "$env:USERPROFILE\.zehen\config.json" -Raw | ConvertFrom-Json
$c.db.master_db_name = "zehen_master"
$c | ConvertTo-Json -Depth 10 | Set-Content "$env:USERPROFILE\.zehen\config.json" -Encoding UTF8

# 5. Verify, then install the new ZEHEN build and launch it
& "$bin\pg_ctl.exe" start -D "$env:USERPROFILE\.zehen\pgdata" -o "-p $port -c listen_addresses=127.0.0.1" -w
& "$bin\psql.exe" @C -d zehen -c "SELECT count(*) FROM parties;"
& "$bin\pg_ctl.exe" stop -D "$env:USERPROFILE\.zehen\pgdata" -m fast -w   # let the new app manage PG itself
```

After Step 5: install `ZEHEN-Setup-<version>.exe` (installs fresh to `C:\Program Files\ZEHEN`
under the new `com.sabina.zehen` identity), launch it, and confirm the company and its
books load. Then uninstall the old **Billing ERP** entry from Apps & Features. Keep the
`zehen-migration-backup-*` folder until you've confirmed everything is correct.
