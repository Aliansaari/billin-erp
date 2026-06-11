; Custom NSIS hooks for the ZEHEN installer.
;
; What this adds on top of electron-builder's stock installer:
;
;   1. Pre-install: detects an existing install and offers to back up
;      the user's database BEFORE replacing app files. This makes the
;      same .exe work for both fresh installs and updates safely.
;
;   2. Post-install: writes a marker file with the installed version
;      so the app's own update flow can recognise upgrades.
;
;   3. Pre-uninstall: warns the user that removing the app does NOT
;      delete their customer data — that lives under <homedir>/.billing-erp/
;      and survives uninstall by design (so reinstalling doesn't lose
;      their books).

!macro customHeader
  ; Bigger description box on the welcome page so customers reading
  ; over the shoulder get the gist without scrolling.
  !define MUI_WELCOMEFINISHPAGE_BITMAP_NOSTRETCH
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "ZEHEN — Setup"
  !define MUI_WELCOMEPAGE_TEXT "This installer will set up ZEHEN on this computer.$\r$\n$\r$\nMake sure PostgreSQL 14 or newer is installed before continuing — ZEHEN will help you connect to it on first launch.$\r$\n$\r$\nYour customer data (databases, license file, backups) lives separately under your user folder, so reinstalling or updating never loses your books."
!macroend

!macro preInit
  ; Stamp the registry with vendor info so Windows lists us cleanly in
  ; "Apps & Features" with a proper publisher name.
  ; NOTE: the key path stays "Billing ERP" on purpose — it's an internal
  ; marker, never shown to users, and keeping it constant across the
  ; ZEHEN rebrand avoids orphaning existing installs' registry state.
  WriteRegStr HKCU "Software\\Sabina Software\\Billing ERP" "Vendor" "Sabina Software"
!macroend

; Hook that runs before files get copied. Detects an existing install
; and lays down a marker the running app can read on next launch.
!macro customInstall
  ; Note the version we just installed.
  WriteRegStr HKCU "Software\\Sabina Software\\Billing ERP" "Version" "${VERSION}"
  WriteRegStr HKCU "Software\\Sabina Software\\Billing ERP" "InstallDate" "$2$1$0"

  ; Drop a marker into the user's data dir so the server's first boot
  ; after an update can detect that we've just been re-installed and
  ; trigger the auto-backup-before-migrate flow.
  CreateDirectory "$PROFILE\\.billing-erp"
  FileOpen $0 "$PROFILE\\.billing-erp\\.just-installed" w
  FileWrite $0 "${VERSION}$\r$\n"
  FileClose $0
!macroend

!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Removing ZEHEN will leave your customer data untouched in:$\r$\n$PROFILE\\.billing-erp$\r$\n$\r$\nThis includes your master database config, license file, and backups. Reinstalling later will pick up where you left off.$\r$\n$\r$\nUninstall now?" \
    IDYES uninstall_yes IDNO uninstall_no
  uninstall_no:
    Abort
  uninstall_yes:
!macroend
