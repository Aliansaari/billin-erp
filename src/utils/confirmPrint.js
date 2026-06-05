import { createElement as h, useState } from 'react';
import { Modal, Checkbox } from 'antd';
import { PrinterFilled, WhatsAppOutlined } from '@ant-design/icons';
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

// Self-contained checkbox that mirrors its state into a plain ref so the
// static Modal.confirm (which doesn't re-render on our state) can read the
// latest value in onOk/onCancel.
function SendToggle({ stateRef, label, defaultChecked }) {
  const [checked, setChecked] = useState(!!defaultChecked);
  stateRef.current = checked;
  return h(Checkbox, {
    checked,
    onChange: (e) => { stateRef.current = e.target.checked; setChecked(e.target.checked); },
    style: { marginTop: 12 },
  }, label);
}

// confirmPrintWithSend — the post-save prompt with an optional
// "Also send on WhatsApp" checkbox. Resolves { print, whatsapp }.
//
//   const { print, whatsapp } = await confirmPrintWithSend(`Print bill ${no}?`, {
//     whatsappEnabled: true, whatsappDefault: false,
//   });
//
// The checkbox is independent of the print choice: ticking it sends on
// WhatsApp whether the operator picks Yes (print) or No (skip print).
export function confirmPrintWithSend(title, opts = {}) {
  const {
    printText = 'Yes',
    skipText  = 'No',
    content   = 'Do you want to print it now?',
    whatsappEnabled = false,
    whatsappDefault = false,
    whatsappLabel = 'Also send on WhatsApp',
  } = opts;

  // Not connected → no checkbox; behaves exactly like confirmPrint.
  if (!whatsappEnabled) {
    return confirmPrint(title, { printText, skipText, content })
      .then((print) => ({ print, whatsapp: false }));
  }

  const stateRef = { current: !!whatsappDefault };
  const body = h('div', null,
    h('div', { className: 'ck-msg' }, content),
    h(SendToggle, {
      stateRef,
      defaultChecked: whatsappDefault,
      label: h('span', null,
        h(WhatsAppOutlined, { style: { color: '#25D366', marginRight: 6 } }),
        whatsappLabel),
    }),
  );

  return new Promise((resolve) => {
    Modal.confirm({
      title,
      icon: h(PrinterFilled, { style: { color: 'var(--accent)' } }),
      content: body,
      okText: h('span', null, h('span', { className: 'ck-kbd' }, 'Enter'), printText),
      cancelText: h('span', null, h('span', { className: 'ck-kbd' }, 'Esc'), skipText),
      okButtonProps: { size: 'large', style: { minWidth: 132 } },
      cancelButtonProps: { size: 'large', style: { minWidth: 132 } },
      autoFocusButton: 'ok',
      centered: true,
      maskClosable: false,
      className: 'erp-confirm-modal',
      onOk:     () => resolve({ print: true,  whatsapp: !!stateRef.current }),
      onCancel: () => resolve({ print: false, whatsapp: !!stateRef.current }),
    });
  });
}
