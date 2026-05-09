import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/* ── Developer-mode store ──────────────────────────────────────────────
 *
 * Tracks whether the user has unlocked developer mode on THIS machine.
 * The unlock decision is per-device (not per-account) because dev mode
 * is a UI-level safety gate, not an auth boundary — the actual
 * destructive operations are still admin-role-protected on the server.
 *
 * State is persisted in localStorage so an unlocked machine stays
 * unlocked across reloads. Locking back is one click in the user menu.
 *
 * Usage:
 *   const isDev = useDevModeStore(s => s.unlocked);
 *   const unlock = useDevModeStore(s => s.unlock);
 *   const lock = useDevModeStore(s => s.lock);
 *
 * Most consumers should use `useDeveloperOrFlag(flagName)` from
 * useSystemSettings instead — it returns `true` when EITHER dev mode
 * is unlocked OR the corresponding system_settings flag is on.
 * ────────────────────────────────────────────────────────────────── */

const useDevModeStore = create(
  persist(
    (set) => ({
      unlocked: false,
      // Optional metadata captured at unlock time. Used to show
      // "Developer mode active since 2:34 PM" in the user menu so
      // it doesn't get forgotten.
      unlockedAt: null,

      // ── "Preview as regular user" mode ────────────────────────────
      //
      // When ON, the developer's UI behaves as if they were a normal
      // user: every dev_show_* toggle that's currently OFF hides its
      // feature, the Developer Settings entry disappears from the user
      // dropdown, etc. Lets the developer verify what their staff
      // actually see without having to lock dev mode (and re-enter
      // the password).
      //
      // Transient — does NOT persist across reload. A page refresh
      // always returns to "developer view" so a one-click preview
      // can't leave the developer accidentally locked out.
      previewAsUser: false,
      togglePreviewAsUser: () => set((s) => ({ previewAsUser: !s.previewAsUser })),

      unlock: () => set({ unlocked: true, unlockedAt: Date.now(), previewAsUser: false }),
      lock:   () => set({ unlocked: false, unlockedAt: null, previewAsUser: false }),
    }),
    {
      name: 'billing_erp_dev_mode',
      // Only persist the unlock flag itself. previewAsUser is intentionally
      // excluded so a reload always restores full developer view — see the
      // comment above togglePreviewAsUser.
      partialize: (s) => ({ unlocked: s.unlocked, unlockedAt: s.unlockedAt }),
    },
  ),
);

export default useDevModeStore;
