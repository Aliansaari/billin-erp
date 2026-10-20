/*
 * The voice layer talks to open screens through this tiny registry.
 * A screen that can take voice actions registers its handlers while
 * mounted:
 *
 *   useEffect(() => registerVoiceTarget('sale-form', { setCustomer, setQty, … }), [...]);
 *
 * callVoiceTarget('sale-form', 'setQty', 10) runs the handler, or, right
 * after a navigation (the form is still mounting), waits briefly for it.
 */
const targets = new Map();
const waiting = new Map();

export function registerVoiceTarget(name, handlers) {
  targets.set(name, handlers);
  const queue = waiting.get(name);
  if (queue) { waiting.delete(name); queue.forEach((go) => go()); }
  return () => { if (targets.get(name) === handlers) targets.delete(name); };
}

export const hasVoiceTarget = (name) => targets.has(name);

export function callVoiceTarget(name, action, payload, { waitMs = 0 } = {}) {
  const run = () => {
    const fn = targets.get(name)?.[action];
    return fn ? fn(payload) : undefined;
  };
  if (targets.has(name) || !waitMs) return Promise.resolve(targets.has(name) ? run() : { ok: false, error: 'not-open' });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'not-open' }), waitMs);
    const queue = waiting.get(name) || [];
    queue.push(() => { clearTimeout(timer); resolve(run()); });
    waiting.set(name, queue);
  });
}
