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

/*
 * themedConfirm — drop-in for Modal.confirm(config) with the same look and
 * keys as confirmDialog. Takes Modal.confirm's own config (title, content,
 * okText, onOk returning a promise keeps the spinner, …) so a call site
 * only changes its name.
 *
 * A destructive confirm (okType 'danger' or okButtonProps.danger) starts on
 * Cancel: Enter and Esc both back out, doing it takes a click. Anything
 * else starts on OK so Enter confirms.
 */
export function themedConfirm(config = {}) {
  const {
    okType, okButtonProps = {}, cancelButtonProps = {},
    okText = 'OK', cancelText = 'Cancel',
    icon, className, autoFocusButton, ...rest
  } = config;
  const danger = okType === 'danger' || !!okButtonProps.danger;
  const kbd = (k) => h('span', { className: 'ck-kbd' }, k);

  return Modal.confirm({
    centered: true,
    maskClosable: false,
    ...rest,
    icon: icon !== undefined
      ? icon
      : h(danger ? ExclamationCircleFilled : QuestionCircleFilled, {
          style: { color: danger ? 'var(--danger)' : 'var(--accent)' },
        }),
    okText: danger ? okText : h('span', null, kbd('Enter'), okText),
    cancelText: h('span', null, kbd('Esc'), cancelText),
    okButtonProps: { size: 'large', ...okButtonProps, danger, style: { minWidth: 132, ...okButtonProps.style } },
    cancelButtonProps: { size: 'large', ...cancelButtonProps, style: { minWidth: 132, ...cancelButtonProps.style } },
    autoFocusButton: autoFocusButton ?? (danger ? 'cancel' : 'ok'),
    className: ['erp-confirm-modal', className].filter(Boolean).join(' '),
  });
}

/*
 * themedNotice — drop-in for Modal.info / Modal.warning / Modal.error: a
 * one-button notice in the same themed shell. Enter or Esc closes it.
 */
export function themedNotice(type, config = {}) {
  const { okText = 'OK', okButtonProps = {}, className, ...rest } = config;
  const kbd = (k) => h('span', { className: 'ck-kbd' }, k);
  return Modal[type]({
    centered: true,
    ...rest,
    okText: h('span', null, kbd('Enter'), okText),
    okButtonProps: { size: 'large', ...okButtonProps, style: { minWidth: 132, ...okButtonProps.style } },
    className: ['erp-confirm-modal', className].filter(Boolean).join(' '),
  });
}
