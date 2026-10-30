/* Open dialogs, dropdowns and popups. Used by Esc (AppLayout) and by the
 * tab keys (src/tabs), which wait until these are closed. */
// If any of these is in the DOM when Esc is pressed, that Esc belongs to
// the overlay (Esc closes it). A second Esc — overlay now gone — cascades
// Home. Covers the app's custom popups + every AntD overlay layer.
export const ESC_OVERLAY_SELECTOR = [
  '.gs-modal-backdrop',          // ⌘K global search palette
  '.mc-backdrop',                // Master chooser
  '.mp-popup',                   // Alt-letter menu popup
  '.dp-backdrop',                // F2 date popup
  '.erp-shortcuts-overlay',      // keyboard cheat-sheet
  '.ant-modal-wrap:not([style*="display: none"])',
  '.ant-drawer-open',
  '.ant-dropdown:not(.ant-dropdown-hidden)',
  '.ant-select-dropdown:not(.ant-select-dropdown-hidden)',
  '.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)',
  '.ant-popover:not(.ant-popover-hidden)',
  '.ant-image-preview-wrap',
].join(', ');
