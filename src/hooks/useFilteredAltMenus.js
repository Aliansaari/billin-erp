/**
 * Hook that returns ALT_MENUS with developer-tier flags applied.
 *
 * Same filtering rules as the sidebar's useMenuItems:
 *   - dev_show_<feature> flag in system_settings is true → item visible
 *   - developer mode unlocked AND not previewing as user → all items visible
 *   - else → item hidden
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

export default function useFilteredAltMenus() {
  const settings      = useSystemSettings();
  const devUnlocked   = useDevModeStore((s) => s.unlocked);
  const previewAsUser = useDevModeStore((s) => s.previewAsUser);
  const effectiveDev  = devUnlocked && !previewAsUser;

  return useMemo(
    () => filterAltMenus(ALT_MENUS, settings, effectiveDev),
    [settings, effectiveDev],
  );
}
