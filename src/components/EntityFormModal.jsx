// ── EntityFormModal ────────────────────────────────────────────────────
//
// One shared shell every entity create/edit form drops into. Goal: every
// form in the app (Product, Customer, Supplier, Category, Godown, Loan,
// User…) reads as a sibling — same chrome, same density, same F-key
// vocabulary, same dirty-state confirm — while each consumer keeps full
// control over its own field rendering.
//
// Why a compound component (Section / Field) instead of a config-driven
// "schema" form: each entity has bespoke logic (Product has the colour
// panel + batch fields; Customer has GST validation; Loan has interest
// math). Trying to express all that through a JSON schema invites the
// kind of "almost-but-not-quite" hacks that produce inconsistent forms.
// Compound children let consumers render whatever React they need; the
// shell only owns chrome (header / sections / footer / focus / keys).
//
// Keyboard contract — matches the bill forms verbatim:
//   • F1            — Save (stays open). Calls onSave.
//   • F8            — Save & Close. Calls onSaveAndClose; falls back to
//                     onSave + onClose if the consumer didn't pass one.
//   • F5            — Reset. Calls onReset; consumer decides what reset
//                     means (typically "rehydrate from initial values").
//   • Esc           — Cancel / close. If `dirty=true` is reported by
//                     the consumer, the first Esc shows an inline confirm
//                     ribbon instead of closing; the second Esc commits
//                     the close. F1 in confirm state saves and closes.
//   • Alt+1..9      — Jump to the Nth section. Only bound for forms with
//                     more than one Section child; otherwise a no-op.
//
// Relation `+ new` stacking is supported via `zIndex` prop — consumers
// open a second EntityFormModal at z+1 over the first, and the original
// stays focus-trapped behind. The shell doesn't manage the stack itself
// (state lives in the consumer); it just respects whatever zIndex the
// caller supplies.
//
// Usage:
//
//   <EntityFormModal
//     open={open}
//     onClose={() => setOpen(false)}
//     title="Add Product"
//     subtitle="New SKU · creates one inventory record"
//     entityIcon="P"
//     entityTone="accent"
//     dirty={isDirty}
//     onSave={handleSave}
//     onSaveAndClose={handleSaveAndClose}
//     onReset={handleReset}
//     saving={saving}
//   >
//     <EntityFormModal.Section label="Identifiers">
//       <EntityFormModal.Field label="Product Name" required>
//         <input className="efm-input" ... />
//       </EntityFormModal.Field>
//     </EntityFormModal.Section>
//
//     <EntityFormModal.Section label="Pricing">…</EntityFormModal.Section>
//   </EntityFormModal>

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom';
import './EntityFormModal.css';

// ── Tone palette ──────────────────────────────────────────────────────
//
// Tones drive the icon chip's background + border + foreground. Mirror
// of the .rpt-kpi tones in global.css so the whole app speaks one
// colour vocabulary. Default = `accent` (indigo); pick `success` for
// customers, `warning` for low-impact entities (categories), `info`
// for read-only stuff, etc.
const TONES = {
  accent:  { bg: 'rgba(129,140,248,.12)',  border: 'rgba(129,140,248,.32)', fg: 'var(--accent)'  },
  success: { bg: 'rgba(74,222,128,.12)',   border: 'rgba(74,222,128,.28)',  fg: 'var(--success)' },
  warning: { bg: 'rgba(251,191,36,.12)',   border: 'rgba(251,191,36,.28)',  fg: 'var(--warning)' },
  danger:  { bg: 'rgba(248,113,113,.12)',  border: 'rgba(248,113,113,.28)', fg: 'var(--danger)'  },
  info:    { bg: 'rgba(59,130,246,.12)',   border: 'rgba(59,130,246,.28)',  fg: 'var(--info)'    },
};

// ── Section component ────────────────────────────────────────────────
// Compound child. Renders a section header (eyebrow label + optional
// Alt+N anchor chip when the parent has 3+ sections) and the children
// below in the dense field grid. Consumers wrap their own fields in
// <EntityFormModal.Field> children for consistent label / required /
// help / error treatment.
function Section({ label, anchorKey, children }) {
  return (
    <section className="efm-section" data-section-label={label}>
      <div className="efm-section-hd">
        <span className="lbl">{label}</span>
        {anchorKey != null && (
          <span className="efm-anchor">
            <kbd>Alt</kbd>+<kbd>{anchorKey}</kbd>
          </span>
        )}
      </div>
      <div className="efm-grid">{children}</div>
    </section>
  );
}

// ── Field component ──────────────────────────────────────────────────
// Wraps a single form input. `label`, `required`, `help`, `error`, and
// `span` are normalised here so every entity gets identical label
// rendering. `span` accepts 'half' (default), 'third', or 'full'.
function Field({ label, required, help, error, span = 'half', children }) {
  const cls = `efm-field${span === 'full' ? ' full' : ''}${span === 'third' ? ' third' : ''}`;
  return (
    <div className={cls}>
      {label && (
        <label className="efm-lbl">
          {label}
          {required && <span className="req">*</span>}
        </label>
      )}
      {children}
      {error
        ? <span className="efm-err">{error}</span>
        : help ? <span className="efm-help">{help}</span> : null}
    </div>
  );
}

// ── Main shell ──────────────────────────────────────────────────────
function EntityFormModal({
  open,
  onClose,
  title,
  subtitle,
  entityIcon = '+',
  entityTone = 'accent',
  dirty = false,
  saving = false,
  onSave,
  onSaveAndClose,
  onReset,
  zIndex = 1100,
  children,
  // For controlled width — defaults to 540 (v1 mockup spec). Pass
  // a wider value (720+) for forms with denser two-column bodies.
  width = 540,
  // Optional left-aligned destructive action (e.g. "Delete Customer"
  // in edit mode). Rendered in the footer to the LEFT of Esc/Reset
  // so it's visually separated from the save controls. Pass:
  //   { label, onClick, loading?, icon? }
  // Omit entirely when there's no destructive action available.
  dangerAction,
}) {
  // Track whether Esc has been pressed once while dirty (first Esc
  // shows the confirm ribbon, second Esc actually closes).
  const [escConfirm, setEscConfirm] = useState(false);
  const modalRef = useRef(null);
  const previouslyFocusedRef = useRef(null);
  const tone = TONES[entityTone] || TONES.accent;

  // Count children Sections so we can decide whether to show Alt+N
  // anchors (only when 3+ sections — shorter forms don't need them).
  const sectionCount = useMemo(() => {
    return React.Children.toArray(children).filter(
      (c) => React.isValidElement(c) && c.type === Section,
    ).length;
  }, [children]);

  // Inject anchorKey into Section children when there are 3+. We don't
  // want consumers manually numbering them — they're positional.
  const enrichedChildren = useMemo(() => {
    let n = 0;
    return React.Children.map(children, (c) => {
      if (!React.isValidElement(c) || c.type !== Section) return c;
      n += 1;
      return sectionCount >= 3
        ? React.cloneElement(c, { anchorKey: n <= 9 ? n : null })
        : c;
    });
  }, [children, sectionCount]);

  // ── Focus management ────────────────────────────────────────────
  // When the modal opens: remember what was focused, focus the first
  // input inside the modal, trap Tab. On close: restore focus.
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement;
    const t = setTimeout(() => {
      const first = modalRef.current?.querySelector(
        'input, select, textarea, button:not([data-efm-skip-autofocus])',
      );
      first?.focus?.();
    }, 50);
    return () => {
      clearTimeout(t);
      try { previouslyFocusedRef.current?.focus?.(); } catch {}
    };
  }, [open]);

  // ── Esc / dirty-confirm reset on (re)open ──────────────────────
  useEffect(() => { if (open) setEscConfirm(false); }, [open]);

  // ── Keyboard contract ──────────────────────────────────────────
  // Window-level keydown so the bindings work no matter what's focused
  // inside the modal. We capture only when this modal is open AND the
  // event target lies within the modal — keeps stacked modals from
  // double-handling. stopImmediatePropagation prevents global F-key
  // shortcuts (e.g. F6 → /receipt/new) from firing while a form is
  // open.
  const handleSave = useCallback((e) => {
    e?.preventDefault?.();
    if (saving) return;
    onSave?.();
  }, [onSave, saving]);

  const handleSaveAndClose = useCallback((e) => {
    e?.preventDefault?.();
    if (saving) return;
    if (onSaveAndClose) { onSaveAndClose(); return; }
    // Fallback: save then close. Consumers can just rely on this.
    Promise.resolve(onSave?.()).finally(() => onClose?.());
  }, [onSave, onSaveAndClose, onClose, saving]);

  const handleReset = useCallback((e) => {
    e?.preventDefault?.();
    if (saving) return;
    onReset?.();
    setEscConfirm(false);
  }, [onReset, saving]);

  const handleEsc = useCallback((e) => {
    e?.preventDefault?.();
    if (!dirty) { onClose?.(); return; }
    if (!escConfirm) { setEscConfirm(true); return; }
    // Second Esc — actually close.
    setEscConfirm(false);
    onClose?.();
  }, [dirty, escConfirm, onClose]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      // Only handle when the event came from inside this modal (not
      // a stacked modal nested above it).
      const inMe = modalRef.current?.contains(e.target);
      if (!inMe) return;

      // F1 — Save
      if (e.key === 'F1') {
        e.stopImmediatePropagation();
        handleSave(e);
        return;
      }
      // F5 — Reset (browser tries to refresh on F5 — block it)
      if (e.key === 'F5') {
        e.stopImmediatePropagation();
        handleReset(e);
        return;
      }
      // F8 — Save & Close
      if (e.key === 'F8') {
        e.stopImmediatePropagation();
        handleSaveAndClose(e);
        return;
      }
      // Escape — Cancel (with dirty confirm)
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.stopImmediatePropagation();
        handleEsc(e);
        return;
      }
      // Alt+1..9 — jump to section
      if (e.altKey && /^[1-9]$/.test(e.key) && sectionCount >= 3) {
        const idx = parseInt(e.key, 10) - 1;
        const sections = modalRef.current?.querySelectorAll('.efm-section');
        const target = sections?.[idx];
        if (target) {
          e.preventDefault();
          e.stopImmediatePropagation();
          target.scrollIntoView({ block: 'start', behavior: 'smooth' });
          // Move focus to the first focusable inside the section so
          // Tab continues naturally from there.
          const f = target.querySelector('input, select, textarea, button');
          f?.focus?.();
        }
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, sectionCount, handleSave, handleSaveAndClose, handleReset, handleEsc]);

  if (!open) return null;

  // Render via portal so the stack ordering is honoured by the
  // browser regardless of where in the React tree the consumer
  // mounts the modal from.
  return ReactDOM.createPortal(
    <div className="efm-backdrop" style={{ zIndex }} onMouseDown={(e) => {
      // Only close on backdrop mousedown (not on selection drag from
      // inside the modal). Click-target check: must be the backdrop
      // itself, not a descendant.
      if (e.target === e.currentTarget) handleEsc(e);
    }}>
      <div
        ref={modalRef}
        className="efm"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ '--efm-w': `${width}px` }}
        onMouseDown={(e) => e.stopPropagation()}
      >

        {/* ── Title strip ──────────────────────────────────────── */}
        <header className="efm-hd">
          <div
            className="efm-hd-ic"
            style={{ background: tone.bg, borderColor: tone.border, color: tone.fg }}
            aria-hidden="true"
          >
            {entityIcon}
          </div>
          <div className="efm-hd-title">
            <h2>{title}</h2>
            {subtitle && <div className="efm-hd-sub">{subtitle}</div>}
          </div>
          <button
            type="button"
            className="efm-hd-x"
            aria-label="Close"
            onClick={(e) => handleEsc(e)}
          >×</button>
        </header>

        {/* ── Body ─────────────────────────────────────────────── */}
        <div className="efm-body">
          {enrichedChildren}
        </div>

        {/* ── Dirty-state Esc confirm ribbon ───────────────────── */}
        {escConfirm && (
          <div className="efm-confirm">
            <span className="efm-confirm-msg">
              You have unsaved changes. <kbd>Esc</kbd> again to discard, or
            </span>
            <button
              type="button"
              className="efm-confirm-keep"
              onClick={() => setEscConfirm(false)}
            >Keep editing</button>
            <button
              type="button"
              className="efm-confirm-save"
              onClick={(e) => handleSaveAndClose(e)}
            ><kbd>F1</kbd> Save & close</button>
          </div>
        )}

        {/* ── Footer (F-key strip) ─────────────────────────────── */}
        <footer className="efm-ft">
          {/* Destructive action — sits at the far left, visually
           *  separated from the save controls by the spacer below.
           *  Outline-style danger so it doesn't compete with the
           *  primary Save button. */}
          {dangerAction && (
            <button
              type="button"
              className="fkey danger-action"
              onClick={dangerAction.onClick}
              disabled={!!dangerAction.loading || saving}
              title={dangerAction.title}
            >
              {dangerAction.icon} {dangerAction.loading ? 'Working…' : dangerAction.label}
            </button>
          )}
          <button type="button" className="fkey danger" onClick={(e) => handleEsc(e)}>
            <kbd>Esc</kbd> Cancel
          </button>
          {onReset && (
            <button type="button" className="fkey" onClick={handleReset} disabled={saving}>
              <kbd>F5</kbd> Reset
            </button>
          )}
          <span className="efm-ft-spacer" />
          {onSaveAndClose !== undefined && (
            <button type="button" className="fkey" onClick={handleSaveAndClose} disabled={saving}>
              <kbd>F8</kbd> Save & Close
            </button>
          )}
          <button
            type="button"
            className="fkey primary"
            onClick={handleSave}
            disabled={saving}
          >
            <kbd>F1</kbd> {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>

      </div>
    </div>,
    document.body,
  );
}

EntityFormModal.Section = Section;
EntityFormModal.Field = Field;

export default EntityFormModal;
