/**
 * Hook that returns ALT_MENUS with developer-tier flags applied AND the
 * Reports menu rebuilt from the user's pinned favourites.
 *
 * Flag filtering rules (same as the sidebar's useMenuItems):
 *   - dev_show_<feature> flag in system_settings is true → item visible
 *   - developer mode unlocked AND not previewing as user → all items visible
 *   - else → item hidden
 *
 * Reports menu (Alt+R / the Reports pill / collapsed-sidebar popup) is
 * favourites-driven: it lists the operator's pinned reports (permission +
 * flag filtered) with a Browse-hub anchor last, so every keyboard/mouse
 * surface mirrors the sidebar dropdown and what's starred on the hub.
 *
 * Three consumers need this:
 *   1. useKeyboardShortcuts (Alt+letter handler)        — keyboard reach
 *   2. Sidebar (CollapsedItem hover popup)              — mouse reach
 *   3. TopNav (horizontal-mode dropdown)                — mouse reach
 *
 * Without filtering at all three, a regular user with a hidden sidebar
 * link could still reach the gated page via keyboard or hover popup —
 * defeating the whole point of the flag.
 */
import { useMemo } from 'react';
import { ALT_MENUS, filterAltMenus } from '../components/keyboard/menuCatalog';
import { useSystemSettings } from './useSystemSettings';
import useDevModeStore from '../store/devModeStore';
import useFavoritesStore from '../store/favoritesStore';
import useAuthStore from '../store/authStore';
import { resolveReports, CATEGORY_META } from '../config/reports';
import { hasPermission } from '../utils/perms';

export default function useFilteredAltMenus() {
  const settings      = useSystemSettings();
  const devUnlocked   = useDevModeStore((s) => s.unlocked);
  const previewAsUser = useDevModeStore((s) => s.previewAsUser);
  const effectiveDev  = devUnlocked && !previewAsUser;
  // Favourites + the current user drive the Reports menu's item list.
  const favIds = useFavoritesStore((s) => s.ids);
  const user   = useAuthStore((s) => s.user);

  return useMemo(() => {
    const filtered = filterAltMenus(ALT_MENUS, settings, effectiveDev);

    // Rebuild the Reports menu from pinned favourites (perm + flag
    // filtered) so it matches the sidebar dropdown. A "Browse all
    // reports" anchor always trails the list — so the menu is never
    // empty and there's always a path to the full hub. When nothing is
    // pinned the list is a single item, and useKeyboardShortcuts'
    // 1-item short-circuit sends Alt+R straight to the hub.
    const pinned = resolveReports(favIds).filter((r) =>
      (!r.perm || hasPermission(user, r.perm)) &&
      (!r.flag || effectiveDev || !!settings?.[r.flag]),
    );
    const reportItems = pinned.map((r) => ({
      label: r.name,
      sub:   CATEGORY_META[r.category]?.label || 'Report',
      route: r.route,
    }));
    reportItems.push({
      letter: 'B',
      label:  pinned.length ? 'Browse all reports' : 'Browse Reports',
      sub:    'Open the Reports hub',
      route:  '/reports',
    });
    filtered.KeyR = { title: 'Reports', anchorKey: 'reports-menu', items: reportItems };

    return filtered;
  }, [settings, effectiveDev, favIds, user]);
}
