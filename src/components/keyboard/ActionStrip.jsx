import React, { useEffect, useMemo, useRef } from 'react';
import './ActionStrip.css';

// Tally-style bottom action strip.
//
//   <ActionStrip actions={[
//     { id: 'open',    key: 'F1', label: 'Open',    onAction: handleOpen },
//     { id: 'edit',    key: 'F2', label: 'Edit',    onAction: handleEdit, disabled: !row },
//     { id: 'new',     key: 'F3', label: 'New',     onAction: handleNew },
//     { id: 'cancel',  key: 'F8', label: 'Cancel',  onAction: handleCancel, tone: 'danger' },
//     { id: 'back',    key: 'Esc', label: 'Back',   onAction: handleBack },
//   ]} />
//
// Each action declares ONE source of truth — the key binding and the
// button render both come from the same record. The strip:
//   • renders the buttons left-to-right in declared order
//   • registers a window keydown listener for every action's key
//   • fires the handler iff the action is not `disabled` and not `hidden`
//   • calls preventDefault on the matched key so browser doesn't act
//
// Actions with `hidden: true` are NOT rendered but the key binding
//   stays active — useful for aliases like a hidden 'Ctrl+Enter' that
//   maps to the same handler as the visible F1 button.
// Actions with `disabled: true` ARE rendered (greyed) but the key
//   binding is suppressed — both click and keypress are no-ops.
//
// Tone presets:
//   default — neutral panel
//   primary — accent (use for the screen's main action, F1)
//   danger  — red-ish (Cancel, Delete)
//   warn    — amber (Save Credit / unstructured save)
//
// Note on key matching:
//   F-keys ('F1'..'F12') match e.key directly.
//   'Esc' matches 'Escape'.
//   'Del' matches 'Delete'.
//   Single letters like 'A' match e.key case-insensitively.
//   Combos: 'Ctrl+Enter', 'Ctrl+L', 'Shift+F1' — left-to-right modifiers.
const SPECIAL_ALIASES = {
  'esc': 'escape',
  'del': 'delete',
  'ins': 'insert',
  'space': ' ',
  'spacebar': ' ',
};

function parseBinding(binding) {
  if (!binding) return null;
  const parts = String(binding).split('+').map(s => s.trim());
  const main = parts.pop();
  const mods = new Set(parts.map(p => p.toLowerCase()));
  const lower = main.toLowerCase();
  return {
    key: SPECIAL_ALIASES[lower] || main,
    keyLower: SPECIAL_ALIASES[lower] || lower,
    ctrl:  mods.has('ctrl') || mods.has('control'),
    meta:  mods.has('meta') || mods.has('cmd') || mods.has('command'),
    shift: mods.has('shift'),
    alt:   mods.has('alt') || mods.has('option'),
  };
}

function eventMatches(e, parsed) {
  if (!parsed) return false;
  // Key compare: e.key for F-keys is 'F1'..'F12'; for Escape is 'Escape'.
  const ek = String(e.key || '').toLowerCase();
  if (ek !== parsed.keyLower) return false;
  // Treat ctrl and meta as interchangeable so Mac users get Cmd+X for
  // shortcuts declared as Ctrl+X.
  const ctrlOrMeta = e.ctrlKey || e.metaKey;
  const wantCtrlOrMeta = parsed.ctrl || parsed.meta;
  if (wantCtrlOrMeta !== ctrlOrMeta) return false;
  if (!!parsed.shift !== !!e.shiftKey) return false;
  if (!!parsed.alt   !== !!e.altKey)   return false;
  return true;
}

export default function ActionStrip({ actions, dense = false, scope = 'global', info = null }) {
  // Keep latest actions in a ref so the keydown listener doesn't need
  // to tear down + reattach on every render. Without this, fast keypresses
  // could miss the latest handler closures during rapid state updates.
  const actionsRef = useRef(actions);
  useEffect(() => { actionsRef.current = actions; });

  // Pre-parse bindings once per render so the keydown handler doesn't
  // re-parse strings on every keypress.
  const parsed = useMemo(() => actions.map(a => ({
    action: a,
    parsed: parseBinding(a.key),
  })), [actions]);
  const parsedRef = useRef(parsed);
  useEffect(() => { parsedRef.current = parsed; });

  useEffect(() => {
    const handler = (e) => {
      const list = parsedRef.current;
      // First match wins. Iterate the live actions ref so the freshest
      // disabled/hidden state is honoured, even between renders.
      const live = actionsRef.current;
      for (let i = 0; i < list.length; i++) {
        const { parsed } = list[i];
        const a = live[i];
        // `hidden` actions stay bound so they can act as keyboard
        // aliases for visible buttons. `disabled` suppresses both the
        // visual click AND the key binding.
        if (!a || a.disabled) continue;
        if (!parsed) continue;
        if (eventMatches(e, parsed)) {
          e.preventDefault();
          // stopImmediatePropagation suppresses ANY other window-level
          // keydown listener (e.g. useGlobalShortcuts F6 → /receipt/new)
          // on the same key, so a page-level binding in this strip
          // always wins over a global. stopPropagation alone wouldn't
          // do this because both handlers attach at the same target.
          e.stopImmediatePropagation();
          try { a.onAction?.(e); }
          catch (err) { console.error('[ActionStrip]', a.id, err); }
          return;
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <section className={`astrip${dense ? ' dense' : ''}`} data-scope={scope} role="toolbar" aria-label="Action strip">
      <div className="astrip-inner">
        {info != null && info !== '' && (
          <span className="astrip-info">{info}</span>
        )}
        {actions.filter(a => !a.hidden).map((a) => (
          <button
            key={a.id}
            type="button"
            className={`astrip-btn tone-${a.tone || 'default'}`}
            onClick={(e) => { e.preventDefault(); a.onAction?.(e); }}
            disabled={!!a.disabled}
            title={a.title || (a.label && a.key ? `${a.label} (${a.key})` : a.label)}
          >
            {a.key && <span className="astrip-kbd">{a.key}</span>}
            <span className="astrip-lbl">{a.label}</span>
            {a.badge != null && <span className="astrip-badge">{a.badge}</span>}
          </button>
        ))}
      </div>
    </section>
  );
}
