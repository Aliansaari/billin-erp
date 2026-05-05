import { Modal } from 'antd';

// confirmPrint — quick post-save print prompt.
//
//   const wantsPrint = await confirmPrint(`Print bill ${bill_number}?`);
//   if (wantsPrint) printDocument({ docType: 'sales', id });
//
// Resolves to `true` when the user presses Enter (Print) and `false`
// on Esc / Skip / outside-click. The Print button is autoFocused so
// Enter is the print path; Esc skips. Both options are equally fast,
// matching the user's "drop the dual save key, prompt instead" rule.
//
// Pass an optional second argument with `{ printText, skipText }` to
// override the button labels. Defaults are sensible for bills /
// vouchers; pass overrides only when the print action is unusual
// (e.g. "Print barcode labels" on purchase forms).
export default function confirmPrint(title, opts = {}) {
  const {
    printText = 'Print',
    skipText  = 'Skip',
    content   = 'Enter to print · Esc to skip',
  } = opts;

  return new Promise((resolve) => {
    const modal = Modal.confirm({
      title,
      content,
      okText: printText,
      cancelText: skipText,
      okButtonProps: { autoFocus: true },
      // Antd modals natively close on Esc → triggers onCancel.
      onOk:     () => { resolve(true);  },
      onCancel: () => { resolve(false); },
    });
    return modal;
  });
}
