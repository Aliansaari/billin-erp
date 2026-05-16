import { createElement as h } from 'react';
import { PrinterFilled } from '@ant-design/icons';
import confirmDialog from './confirmDialog';

// confirmPrint — quick post-save print prompt.
//
//   const wantsPrint = await confirmPrint(`Print bill ${bill_number}?`);
//   if (wantsPrint) printDocument({ docType: 'sales', id });
//
// Resolves true on Print (Enter), false on Skip (Esc / click / backdrop).
// Print is the focused default so a single Enter prints — Esc skips.
//
// Optional opts: { printText, skipText, content } override the button
// labels / message (e.g. "Print barcode labels" on purchase forms).
export default function confirmPrint(title, opts = {}) {
  const {
    printText = 'Yes',
    skipText  = 'No',
    content   = 'Do you want to print it now?',
  } = opts;

  return confirmDialog({
    title,
    message: content,
    confirmText: printText,
    cancelText:  skipText,
    icon: h(PrinterFilled, { style: { color: 'var(--accent)' } }),
    // Non-destructive: Yes prints (Enter, the fast default), Esc = No.
    safeDefault: false,
  });
}
