import { createElement as h } from 'react';
import { Modal } from 'antd';
import { ExclamationCircleFilled, QuestionCircleFilled } from '@ant-design/icons';

/*
 * confirmDialog — one themed, keyboard-first confirmation for the whole app.
 *
 *   const ok = await confirmDialog({
 *     title: 'Discard unsaved changes?',
 *     message: 'This bill has changes that have not been saved.',
 *     confirmText: 'Discard & leave',
 *     cancelText:  'Keep editing',
 *     danger: true,        // confirm button reads as destructive
 *     safeDefault: true,   // Enter/Esc both stay safe; proceed needs a click
 *   });
 *
 * Resolves true on confirm, false on cancel / Esc / backdrop.
 *
 * Uses Modal.confirm (static) so the app's `.erp-confirm-modal` theme in
 * global.css applies — that CSS targets the `.ant-modal-confirm-*` DOM
 * only the static method emits, keeping every confirm theme-correct in
 * light/dark · classic/modern.
 *
 * The triggering key is shown as a pill INSIDE each button (same language
 * as the ActionStrip / barcode-modal key chips), so the keyboard binding
 * is obvious without a separate hint line:
 *   • normal — Enter = confirm, Esc = cancel        (autoFocusButton 'ok')
 *   • safe   — Enter & Esc = cancel (the safe one); confirming is a
 *              deliberate click, so the confirm button shows no key
 *              (autoFocusButton 'cancel')
 */
export default function confirmDialog({
  title,
  message,
  confirmText = 'OK',
  cancelText  = 'Cancel',
  danger       = false,
  safeDefault  = false,
  icon,
} = {}) {
  const kbd = (k) => h('span', { className: 'ck-kbd' }, k);

  // Esc always cancels. Enter triggers the autofocused button: the OK
  // button on a normal dialog, the Cancel button on a safe-default one.
  const okNode = safeDefault
    ? confirmText
    : h('span', null, kbd('Enter'), confirmText);
  const cancelNode = h('span', null, kbd('Esc'), cancelText);

  const content = message ? h('div', { className: 'ck-msg' }, message) : null;

  return new Promise((resolve) => {
    Modal.confirm({
      title,
      icon: icon !== undefined
        ? icon
        : h(danger ? ExclamationCircleFilled : QuestionCircleFilled, {
            style: { color: danger ? 'var(--danger)' : 'var(--accent)' },
          }),
      content,
      okText: okNode,
      cancelText: cancelNode,
      okButtonProps: { danger, size: 'large', style: { minWidth: 132 } },
      cancelButtonProps: { size: 'large', style: { minWidth: 132 } },
      autoFocusButton: safeDefault ? 'cancel' : 'ok',
      centered: true,
      maskClosable: false,
      className: 'erp-confirm-modal',
      onOk:     () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}
