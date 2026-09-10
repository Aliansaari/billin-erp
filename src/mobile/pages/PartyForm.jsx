/* ─────────────────────────────────────────────────────────────────────
 * PartyForm — shared mobile form for /customer/new and /supplier/new
 *
 * Per the mockup: four collapsible sections (Identity, Address,
 * Tax & Status, Credit & Opening). Identity opens by default because
 * it carries the required fields. Other sections collapsed but show
 * a hint so the operator knows what's inside. Section number circle
 * encodes empty / open / complete state with an accent ring.
 *
 * Type prop ('Customer' | 'Supplier') switches accent (green / amber),
 * party_type sent to the server, and the save button label.
 * ─────────────────────────────────────────────────────────────────── */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { Capacitor } from '@capacitor/core';
import { partyAPI } from '../../api';
import './PartyForm.css';
import { success as hapticSuccess, warn as hapticWarn } from '../utils/haptics';
import { friendlyError } from '../utils/offlineSnapshot';

const CloseIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
);
const TrashIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
);
const ChevDown = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>
);
const CheckIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
);
const ArrowRight = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
);

// GSTIN: 2-digit state code + 10-char PAN + entity number + Z + checksum.
// State code → state name. Top 36 codes (no UTs/PSU details needed).
const GST_STATE = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan',
  '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh',
  '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura',
  '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '25': 'Daman & Diu', '26': 'Dadra & Nagar Haveli', '27': 'Maharashtra',
  '28': 'Andhra Pradesh (old)', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep',
  '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman & Nicobar',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
};
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[0-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN_RE   = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

export default function PartyForm({ type }) {
  const navigate = useNavigate();
  const isCustomer = type === 'Customer';

  // Field state
  const [partyName, setPartyName]   = useState('');
  const [displayName, setDisplayName] = useState('');
  const [mobile1, setMobile1]       = useState('');
  const [mobile2, setMobile2]       = useState('');
  const [email, setEmail]           = useState('');

  const [addrLine1, setAddrLine1]   = useState('');
  const [city, setCity]             = useState('');
  const [state, setState]           = useState('');
  const [pincode, setPincode]       = useState('');

  const [gstin, setGstin]           = useState('');
  const [pan, setPan]               = useState('');
  const [status, setStatus]         = useState('Regular');

  const [creditAllowed, setCreditAllowed] = useState(false);
  const [creditLimit, setCreditLimit]     = useState('');
  const [creditDays, setCreditDays]       = useState('');
  const [openingBalance, setOpeningBalance] = useState('');
  const [openingType, setOpeningType]     = useState('Dr');  // Dr (they owe us) / Cr (we owe them)

  // Open section — only one at a time, like the mockup.
  const [openSection, setOpenSection] = useState('identity');

  const [saving, setSaving] = useState(false);
  const formRef = useRef(null);

  // Auto-derive state from GSTIN's first 2 chars, and PAN from chars 3-12.
  // We only OVERWRITE if the user hasn't manually typed something else.
  useEffect(() => {
    const g = gstin.trim().toUpperCase();
    if (g.length >= 2) {
      const code = g.slice(0, 2);
      if (GST_STATE[code] && !state) setState(GST_STATE[code]);
    }
    if (g.length >= 12) {
      const derivedPan = g.slice(2, 12);
      if (PAN_RE.test(derivedPan) && !pan) setPan(derivedPan);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gstin]);

  // Completion checks — drives the section number circle state.
  const identityComplete = !!(partyName.trim() && mobile1.trim().length >= 10);
  const addressComplete  = !!(city.trim() && state.trim());
  const taxComplete      = !!(gstin.trim() || pan.trim() || status !== 'Regular');
  const creditComplete   = creditAllowed && (Number(creditLimit) > 0 || Number(creditDays) > 0);

  const gstinIsValid = !gstin || GSTIN_RE.test(gstin.trim().toUpperCase());
  const panIsValid   = !pan   || PAN_RE.test(pan.trim().toUpperCase());

  const sections = [
    {
      key: 'identity',
      title: 'Identity',
      hint: 'Name & mobile required',
      complete: identityComplete,
      summary: identityComplete ? `${partyName} · ${mobile1}` : null,
    },
    {
      key: 'address',
      title: 'Address',
      hint: 'City, state, pincode',
      complete: addressComplete,
      summary: addressComplete
        ? [city, state, pincode].filter(Boolean).join(', ')
        : null,
    },
    {
      key: 'tax',
      title: 'Tax & status',
      hint: gstin && state ? `${state} detected from GSTIN` : 'GSTIN, PAN, status',
      complete: taxComplete,
      summary: taxComplete
        ? [gstin && `GSTIN ${gstin}`, status !== 'Regular' && status].filter(Boolean).join(' · ')
        : null,
    },
    {
      key: 'credit',
      title: 'Credit & opening',
      hint: 'Credit limit, days, balance',
      complete: creditComplete,
      summary: creditComplete
        ? `Limit ₹${Number(creditLimit).toLocaleString('en-IN')} · ${creditDays || 0}d`
        : null,
    },
  ];
  const progressDone = sections.filter((s) => s.complete).length;

  // Keyboard lift for the footer.
  useEffect(() => {
    const root = document.documentElement;
    const setKbd = (px) => root.style.setProperty('--pf-kbd-h', `${Math.max(0, px)}px`);
    let cleanup = () => {};
    if (Capacitor.isNativePlatform()) {
      let showH = null, hideH = null;
      import('@capacitor/keyboard').then(({ Keyboard }) => {
        Keyboard.addListener('keyboardWillShow', (info) => setKbd(info.keyboardHeight)).then((h) => { showH = h; });
        Keyboard.addListener('keyboardWillHide', () => setKbd(0)).then((h) => { hideH = h; });
      }).catch(() => {});
      cleanup = () => { showH?.remove?.(); hideH?.remove?.(); setKbd(0); };
    } else if (window.visualViewport) {
      const vv = window.visualViewport;
      const apply = () => setKbd(window.innerHeight - vv.height - vv.offsetTop);
      apply();
      vv.addEventListener('resize', apply);
      vv.addEventListener('scroll', apply);
      cleanup = () => { vv.removeEventListener('resize', apply); vv.removeEventListener('scroll', apply); setKbd(0); };
    }
    return cleanup;
  }, []);

  const handleSave = async () => {
    if (saving) return;
    if (!partyName.trim()) {
      hapticWarn(); Toast.show({ icon: 'fail', content: 'Party name is required' });
      setOpenSection('identity');
      return;
    }
    if (!mobile1.trim() || mobile1.replace(/\D/g, '').length < 10) {
      hapticWarn(); Toast.show({ icon: 'fail', content: 'Mobile number is required (10 digits)' });
      setOpenSection('identity');
      return;
    }
    if (gstin && !gstinIsValid) {
      hapticWarn(); Toast.show({ icon: 'fail', content: 'GSTIN format is invalid' });
      setOpenSection('tax');
      return;
    }
    if (pan && !panIsValid) {
      hapticWarn(); Toast.show({ icon: 'fail', content: 'PAN format is invalid' });
      setOpenSection('tax');
      return;
    }

    const body = {
      party_type: type,
      party_name: partyName.trim(),
      display_name: displayName.trim() || undefined,
      mobile_1: mobile1.replace(/\D/g, ''),
      mobile_2: mobile2.replace(/\D/g, '') || undefined,
      email: email.trim() || undefined,
      address_line_1: addrLine1.trim() || undefined,
      city: city.trim() || undefined,
      state: state.trim() || undefined,
      pincode: pincode.replace(/\D/g, '') || undefined,
      gstin: gstin.trim().toUpperCase() || undefined,
      pan_number: pan.trim().toUpperCase() || undefined,
      gst_status: status,
      credit_allowed: creditAllowed,
      credit_limit: Number(creditLimit) || 0,
      credit_days: Number(creditDays) || 0,
      opening_balance: Number(openingBalance) || 0,
      opening_balance_type: openingType,
    };

    setSaving(true);
    try {
      const res = await partyAPI.create(body);
      hapticSuccess(); Toast.show({ icon: 'success', content: `${type} saved` });
      const id = res.data?.party_id || res.data?.id;
      if (id) {
        // navigate to the party detail; fall back to /search where it'll show.
        navigate(-1);
      } else {
        navigate(-1);
      }
    } catch (e) {
      const msg = friendlyError(e, 'Could not save — nothing was recorded');
      hapticWarn(); Toast.show({ icon: 'fail', content: msg });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`pf-screen ${isCustomer ? 'pf-customer' : 'pf-supplier'}`} ref={formRef}>
      {/* Header */}
      <div className="pf-header">
        <button className="pf-icon-btn" onClick={() => navigate(-1)} aria-label="Close">
          <CloseIcon />
        </button>
        <div className="pf-header-mid">
          <div className="pf-header-avatar">{isCustomer ? 'C' : 'S'}</div>
          <div className="pf-header-title-block">
            <h1 className="pf-header-title">Add <em>{isCustomer ? 'customer' : 'supplier'}</em></h1>
            <div className="pf-header-sub">New record</div>
          </div>
        </div>
        <button className="pf-icon-btn" aria-label="Reset" onClick={() => {
          // light-weight reset — clear all fields
          setPartyName(''); setDisplayName(''); setMobile1(''); setMobile2('');
          setEmail(''); setAddrLine1(''); setCity(''); setState(''); setPincode('');
          setGstin(''); setPan(''); setStatus('Regular');
          setCreditAllowed(false); setCreditLimit(''); setCreditDays('');
          setOpeningBalance(''); setOpeningType('Dr');
          setOpenSection('identity');
        }}>
          <TrashIcon />
        </button>
      </div>

      {/* Progress */}
      <div className="pf-progress">
        {sections.map((s, idx) => (
          <div
            key={s.key}
            className={`pf-progress-bar${idx < progressDone ? ' pf-progress-bar--done' : ''}`}
          />
        ))}
      </div>

      {/* Content */}
      <div className="pf-content">
        {sections.map((s, idx) => {
          const isOpen = openSection === s.key;
          const sectionState = s.complete ? 'complete' : (isOpen ? 'open' : '');
          return (
            <div key={s.key} className={`pf-section ${sectionState}`.trim()}>
              <button
                className="pf-section-head"
                onClick={(e) => {
                  const next = isOpen ? '' : s.key;
                  setOpenSection(next);
                  // When opening a section, scroll its head into view at
                  // the TOP of the content area so the body has room to
                  // reveal below it. Without this, tapping a section near
                  // the bottom of the screen expands fields off-screen,
                  // which felt like the page "jumped".
                  if (next) {
                    const head = e.currentTarget;
                    requestAnimationFrame(() => {
                      head.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    });
                  }
                }}
              >
                <div className="pf-section-num">
                  {s.complete ? <CheckIcon /> : (idx + 1)}
                </div>
                <div className="pf-section-text">
                  <div className="pf-section-title">{s.title}</div>
                  <div className="pf-section-sub">
                    {s.summary || s.hint}
                  </div>
                </div>
                <span className="pf-section-chev"><ChevDown /></span>
              </button>

              {isOpen && (
                <div className="pf-section-body">
                  {s.key === 'identity' && (
                    <IdentitySection
                      partyName={partyName} setPartyName={setPartyName}
                      displayName={displayName} setDisplayName={setDisplayName}
                      mobile1={mobile1} setMobile1={setMobile1}
                      mobile2={mobile2} setMobile2={setMobile2}
                      email={email} setEmail={setEmail}
                    />
                  )}
                  {s.key === 'address' && (
                    <AddressSection
                      addrLine1={addrLine1} setAddrLine1={setAddrLine1}
                      city={city} setCity={setCity}
                      state={state} setState={setState}
                      pincode={pincode} setPincode={setPincode}
                    />
                  )}
                  {s.key === 'tax' && (
                    <TaxSection
                      gstin={gstin} setGstin={setGstin}
                      gstinIsValid={gstinIsValid}
                      stateDetected={state}
                      pan={pan} setPan={setPan} panIsValid={panIsValid}
                      status={status} setStatus={setStatus}
                    />
                  )}
                  {s.key === 'credit' && (
                    <CreditSection
                      creditAllowed={creditAllowed} setCreditAllowed={setCreditAllowed}
                      creditLimit={creditLimit} setCreditLimit={setCreditLimit}
                      creditDays={creditDays} setCreditDays={setCreditDays}
                      openingBalance={openingBalance} setOpeningBalance={setOpeningBalance}
                      openingType={openingType} setOpeningType={setOpeningType}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="pf-footer">
        <div className="pf-actions">
          <button className="pf-btn-secondary" onClick={() => navigate(-1)} disabled={saving}>
            Cancel
          </button>
          <button className="pf-btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : `Save ${type.toLowerCase()}`}
            <ArrowRight />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Section sub-components ─────────────────────────────────────── */

function Field({ label, required, optional, children, hint }) {
  return (
    <div className="pf-field">
      <div className="pf-field-label">
        {label}
        {required && <span className="pf-req">●</span>}
        {optional && <span className="pf-opt">{optional}</span>}
      </div>
      {children}
      {hint && <div className="pf-field-hint">{hint}</div>}
    </div>
  );
}

function Input({ value, onChange, placeholder, prefix, suffix, type, inputMode, autoCapitalize, maxLength }) {
  const [focused, setFocused] = useState(false);
  const filled = !!value;
  return (
    <div className={`pf-input${focused ? ' pf-input--focused' : ''}${filled ? ' pf-input--filled' : ''}`}>
      {prefix && <span className="pf-input-prefix">{prefix}</span>}
      <input
        className="pf-input-field"
        type={type || 'text'}
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        autoCapitalize={autoCapitalize}
        autoCorrect="off"
        spellCheck="false"
        maxLength={maxLength}
      />
      {suffix && <span className="pf-input-suffix">{suffix}</span>}
    </div>
  );
}

function IdentitySection(p) {
  return (
    <>
      <Field label="Party name" required>
        <Input
          value={p.partyName}
          onChange={p.setPartyName}
          placeholder="e.g. Patel Textiles"
          autoCapitalize="words"
        />
      </Field>
      <Field label="Display name" optional="optional · shown in pickers">
        <Input
          value={p.displayName}
          onChange={p.setDisplayName}
          placeholder="Same as party name"
          autoCapitalize="words"
        />
      </Field>
      <div className="pf-field-row">
        <Field label="Mobile 1" required>
          <Input
            value={p.mobile1}
            onChange={p.setMobile1}
            placeholder="98765 43210"
            prefix="+91"
            type="tel"
            inputMode="tel"
            maxLength={10}
          />
        </Field>
        <Field label="Mobile 2">
          <Input
            value={p.mobile2}
            onChange={p.setMobile2}
            placeholder="Optional"
            prefix="+91"
            type="tel"
            inputMode="tel"
            maxLength={10}
          />
        </Field>
      </div>
      <Field label="Email">
        <Input
          value={p.email}
          onChange={p.setEmail}
          placeholder="name@example.com"
          type="email"
          inputMode="email"
        />
      </Field>
    </>
  );
}

function AddressSection(p) {
  return (
    <>
      <Field label="Address" optional="optional">
        <Input
          value={p.addrLine1}
          onChange={p.setAddrLine1}
          placeholder="Street, building, area"
          autoCapitalize="words"
        />
      </Field>
      <div className="pf-field-row">
        <Field label="City">
          <Input value={p.city} onChange={p.setCity} placeholder="Mumbai" autoCapitalize="words" />
        </Field>
        <Field label="Pincode">
          <Input
            value={p.pincode}
            onChange={p.setPincode}
            placeholder="400001"
            inputMode="numeric"
            maxLength={6}
          />
        </Field>
      </div>
      <Field label="State">
        <Input value={p.state} onChange={p.setState} placeholder="Maharashtra" autoCapitalize="words" />
      </Field>
    </>
  );
}

function TaxSection(p) {
  return (
    <>
      <Field
        label="GSTIN"
        optional="15 chars · auto-fills state"
        hint={
          p.gstin && !p.gstinIsValid
            ? <span className="pf-hint-error">Invalid format — check the 15-character code</span>
            : (p.gstin && p.stateDetected
              ? <span className="pf-hint-ok">{p.stateDetected} detected from GSTIN</span>
              : null)
        }
      >
        <Input
          value={p.gstin}
          onChange={(v) => p.setGstin(v.toUpperCase())}
          placeholder="27ABCDE9876F2Z1"
          maxLength={15}
          autoCapitalize="characters"
        />
      </Field>
      <Field label="PAN number" hint={p.pan && !p.panIsValid ? <span className="pf-hint-error">PAN must be 10 chars</span> : null}>
        <Input
          value={p.pan}
          onChange={(v) => p.setPan(v.toUpperCase())}
          placeholder="ABCDE9876F"
          maxLength={10}
          autoCapitalize="characters"
        />
      </Field>
      <Field label="Status">
        <div className="pf-chips">
          {['Regular', 'Composition', 'Unregistered', 'Consumer'].map((s) => (
            <button
              key={s}
              type="button"
              className={`pf-chip${p.status === s ? ' pf-chip--active' : ''}`}
              onClick={() => p.setStatus(s)}
            >{s}</button>
          ))}
        </div>
      </Field>
    </>
  );
}

function CreditSection(p) {
  return (
    <>
      <Field label="Credit allowed">
        <div className="pf-toggle-row">
          <button
            type="button"
            className={`pf-toggle-opt${!p.creditAllowed ? ' pf-toggle-opt--active' : ''}`}
            onClick={() => p.setCreditAllowed(false)}
          >Cash only</button>
          <button
            type="button"
            className={`pf-toggle-opt${p.creditAllowed ? ' pf-toggle-opt--active' : ''}`}
            onClick={() => p.setCreditAllowed(true)}
          >Allow credit</button>
        </div>
      </Field>
      {p.creditAllowed && (
        <div className="pf-field-row">
          <Field label="Credit limit">
            <Input
              value={p.creditLimit}
              onChange={p.setCreditLimit}
              placeholder="0"
              inputMode="decimal"
              prefix="₹"
            />
          </Field>
          <Field label="Days">
            <Input
              value={p.creditDays}
              onChange={p.setCreditDays}
              placeholder="0"
              inputMode="numeric"
              suffix="d"
            />
          </Field>
        </div>
      )}
      <Field label="Opening balance" optional="optional">
        <Input
          value={p.openingBalance}
          onChange={p.setOpeningBalance}
          placeholder="0"
          inputMode="decimal"
          prefix="₹"
        />
      </Field>
      {Number(p.openingBalance) > 0 && (
        <Field label="Balance direction">
          <div className="pf-toggle-row">
            <button
              type="button"
              className={`pf-toggle-opt${p.openingType === 'Dr' ? ' pf-toggle-opt--active' : ''}`}
              onClick={() => p.setOpeningType('Dr')}
            >They owe us (Dr)</button>
            <button
              type="button"
              className={`pf-toggle-opt${p.openingType === 'Cr' ? ' pf-toggle-opt--active' : ''}`}
              onClick={() => p.setOpeningType('Cr')}
            >We owe them (Cr)</button>
          </div>
        </Field>
      )}
    </>
  );
}
