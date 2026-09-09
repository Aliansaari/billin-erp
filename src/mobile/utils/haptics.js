/**
 * Haptic feedback.
 *
 * The single clearest difference between a native app and a web page in a
 * shell is that a native app answers your finger. Tapping a row, committing a
 * bill, or hitting a validation error all feel different in your hand before
 * you have read anything on screen.
 *
 * Everything here is fire-and-forget and safe on the web (where the plugin is
 * absent): feedback that fails is simply feedback that did not happen, and it
 * must never interrupt the action it was decorating.
 *
 * Restraint matters more than coverage. Buzzing on every tap is worse than
 * silence — it stops meaning anything and drains battery. These are the four
 * moments worth marking:
 *
 *   tap()      light   — a row, a tab, a chip: "I registered that"
 *   select()   soft    — a value changed: filter, toggle, company switch
 *   success()  notify  — something was committed: a bill saved, a payment
 *   warn()     notify  — a refusal: validation failed, offline write blocked
 */
import { Capacitor } from '@capacitor/core';

let impl = null;
let loading = null;

async function plugin() {
  if (impl) return impl;
  if (!Capacitor.isNativePlatform()) return null;
  if (!loading) {
    loading = import('@capacitor/haptics')
      .then((m) => { impl = m; return m; })
      .catch(() => null);
  }
  return loading;
}

const fire = (fn) => { plugin().then((m) => { if (m) fn(m); }).catch(() => {}); };

export const tap = () =>
  fire(({ Haptics, ImpactStyle }) => Haptics.impact({ style: ImpactStyle.Light }));

export const select = () =>
  fire(({ Haptics }) => (Haptics.selectionChanged
    ? Haptics.selectionChanged()
    : Haptics.impact({ style: 'LIGHT' })));

export const success = () =>
  fire(({ Haptics, NotificationType }) =>
    Haptics.notification({ type: NotificationType.Success }));

export const warn = () =>
  fire(({ Haptics, NotificationType }) =>
    Haptics.notification({ type: NotificationType.Warning }));

export default { tap, select, success, warn };
