import { createElement as h, useState } from 'react';
import { Modal, Checkbox } from 'antd';
import { PrinterFilled, WhatsAppOutlined } from '@ant-design/icons';
import confirmDialog from './confirmDialog';
import { describePrinter } from '../services/printer';

// confirmPrint — quick post-save print prompt.
//
//   const wantsPrint = await confirmPrint(`Print bill ${bill_number}?`, {
//     summary: printSummary(savedBill),   // party · detail · amount box
//     docType: 'sales',                   // names the printer it goes to
//   });
//   if (wantsPrint) printDocument({ docType: 'sales', id });
//
// Resolves true on Print (Enter), false on Skip (Esc / click / backdrop).
// Print is the focused default so a single Enter prints — Esc skips.
//
// Without summary/docType it is the plain question (barcode labels etc.);
// with them it shows what is about to print and where, so the operator can
// see the customer, the amount and the printer before pressing Enter.
//
// Optional opts: { printText, skipText, content } override the button
// labels / message (e.g. "Print barcode labels" on purchase forms).
export default async function confirmPrint(title, opts = {}) {
  const { summary, docType } = opts;
  if (!summary && !docType) {
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
  const { print } = await confirmPrintWithSend(title, opts);
  return print;
}

const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

// Summary for a saved bill / return straight from the save response:
// who it is for, line count + how it was paid, and the total.
export function printSummary(doc, { partyKey = 'customer' } = {}) {
  if (!doc) return null;
  const p = doc[partyKey];
  const party = p?.is_system_cash
    ? (doc.walk_in_name || 'Cash sale')
    : (p?.party_name || doc.walk_in_name || '');
  const lines = Array.isArray(doc.items) ? doc.items.length : 0;
  const detail = [
    lines ? `${lines} ${lines === 1 ? 'item' : 'items'}` : '',
    doc.payment_method || doc.payment_mode || '',
  ].filter(Boolean).join(' · ');
  const amount = doc.total_amount ?? doc.amount;
  return { party, detail, amount };
}

// The box + printer line the prompt shows above the buttons.
function summaryBody(summary, printer) {
  const parts = [];
  if (summary && (summary.party || summary.amount != null)) {
    parts.push(h('div', { className: 'pp-facts', key: 'f' },
      h('div', { className: 'pp-who' },
        h('div', { className: 'pp-party' }, summary.party || ''),
        summary.detail ? h('div', { className: 'pp-detail' }, summary.detail) : null),
      summary.amount != null ? h('div', { className: 'pp-amt' }, inr(summary.amount)) : null,
    ));
  }
  if (printer) {
    parts.push(h('div', { className: 'pp-printer', key: 'p' }, 'Prints on ', h('b', null, printer)));
  }
  return parts;
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
//     summary, docType: 'sales', whatsappEnabled: true, whatsappDefault: false,
//   });
//
// The checkbox is independent of the print choice: ticking it sends on
// WhatsApp whether the operator picks Print or Not now.
export async function confirmPrintWithSend(title, opts = {}) {
  const {
    summary,
    docType,
    printText = summary || docType ? 'Print' : 'Yes',
    skipText  = summary || docType ? 'Not now' : 'No',
    content,
    whatsappEnabled = false,
    whatsappDefault = false,
    whatsappLabel = 'Also send on WhatsApp',
  } = opts;

  // Not connected and nothing to show → the plain question.
  if (!whatsappEnabled && !summary && !docType) {
    return confirmPrint(title, { printText, skipText, content })
      .then((print) => ({ print, whatsapp: false }));
  }

  // Name the printer, but never hold the prompt up for it.
  const printer = docType
    ? await Promise.race([describePrinter(docType), new Promise((r) => setTimeout(() => r(null), 800))])
    : null;

  const stateRef = { current: !!whatsappDefault };
  const body = h('div', null,
    ...summaryBody(summary, printer),
    content ? h('div', { className: 'ck-msg', style: { marginTop: summary || printer ? 10 : 0 } }, content) : null,
    !summary && !printer && !content ? h('div', { className: 'ck-msg' }, 'Do you want to print it now?') : null,
    whatsappEnabled ? h(SendToggle, {
      stateRef,
      defaultChecked: whatsappDefault,
      label: h('span', null,
        h(WhatsAppOutlined, { style: { color: '#25D366', marginRight: 6 } }),
        whatsappLabel),
    }) : null,
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
      className: 'erp-confirm-modal erp-print-modal',
      onOk:     () => resolve({ print: true,  whatsapp: whatsappEnabled && !!stateRef.current }),
      onCancel: () => resolve({ print: false, whatsapp: whatsappEnabled && !!stateRef.current }),
    });
  });
}
