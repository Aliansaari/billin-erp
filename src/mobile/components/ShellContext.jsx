import { createContext, useContext } from 'react';

/**
 * Shell handles the screens need — currently just the side panel.
 *
 * Deliberately NOT React Router's outlet context. Tab screens are kept
 * mounted across navigations (see AppShell), so a hidden tab re-renders while
 * a different route is current; `useOutletContext()` resolves against the
 * route that is current NOW, and returned undefined for every pane that was
 * not it. A context owned by the shell wraps all the panes at once and does
 * not care which route matched.
 */
export const ShellContext = createContext({ setPanelOpen: () => {} });

export function useShell() {
  return useContext(ShellContext);
}
