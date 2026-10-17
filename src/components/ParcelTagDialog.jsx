import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AutoComplete, Button, Input, InputNumber, Modal, Select, message } from 'antd';
import { PrinterOutlined, MinusOutlined, PlusOutlined, CloseCircleFilled } from '@ant-design/icons';
import { useSystemSettings } from '../hooks/useSystemSettings';
import { getPref, setPref } from '../store/prefSync';
import {
  buildParcelTagHTML, printParcelTags, PARCEL_DESIGNS, normaliseParcelDesign,
} from '../utils/parcelTag';
import './parcel-tag-dialog.css';

/**
 * ParcelTagDialog — print 10 × 10 cm parcel labels from anywhere.
 *
 *   • Opened with a customer: their name, address, city, PIN and mobile are
 *     filled in, and any of it can be changed just for this label.
 *   • Opened without one (or for the Cash party): type the details, or pick
 *     a saved customer from the list, and print without adding anyone.
 *   • Bill number comes from the bill on screen; the transport ("via")
 *     remembers the last few used, per login.
 *   • Design defaults to the shop's choice (Settings → Parcel Labels) and
 *     can be switched for this print. The preview is the exact label.
 *
 * Keys while open: F1 or Ctrl+P prints, Esc closes. They are claimed here
 * so they never reach the bill form behind (F1 there saves the bill).
 */

const RECENT_VIA_KEY = 'parcel_recent_via';

const blank = { party_name: '', address_line_1: '', city: '', pincode: '', mobile_1: '' };

const fromParty = (p, walkInName) => {
  if (!p || p.is_system_cash) return { ...blank, party_name: (walkInName || '').trim() };
  return {
    party_name: p.party_name || '',
    address_line_1: [p.address_line_1, p.address_line_2].map((x) => (x || '').trim()).filter(Boolean).join(', '),
    city: (p.city || '').trim(),
    state: (p.state || '').trim(),
    pincode: (p.pincode || '').trim(),
    mobile_1: (p.mobile_1 || '').trim(),
  };
};

export default function ParcelTagDialog({
  open, onClose, party = null, walkInName = '', billNumber = '', company: companyProp, parties = null,
}) {
  const sys = useSystemSettings();
  const company = companyProp || sys || {};
  // The shared settings cache is refreshed when Settings saves, so it is the
  // freshest source for the shop's default design.
  const shopDesign = normaliseParcelDesign(sys?.parcel_tag_design || company?.parcel_tag_design);

  const [to, setTo]           = useState(blank);
  const [sourceId, setSourceId] = useState(null);   // saved customer the details came from
  const [bill, setBill]       = useState('');
  const [cartons, setCartons] = useState(1);
  const [via, setVia]         = useState('');
  const [design, setDesign]   = useState(shopDesign);
  const [html, setHtml]       = useState('');
  const [printing, setPrinting] = useState(false);
  const nameRef = useRef(null);

  const recentVia = useMemo(() => {
    const v = getPref(RECENT_VIA_KEY, []);
    return Array.isArray(v) ? v : [];
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fresh form every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const fromP = party && !party.is_system_cash;
    setTo(fromParty(party, walkInName));
    setSourceId(fromP ? party.party_id : null);
    setBill(billNumber || '');
    setCartons(1);
    setVia('');
    setDesign(shopDesign);
    if (!fromP) setTimeout(() => nameRef.current?.focus(), 120);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live preview: label 1 exactly as it will print.
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    // All cartons are built; the preview frame shows the first page only.
    buildParcelTagHTML({ company, party: to, billNumber: bill, totalParcels: cartons, note: via, design })
      .then((h) => { if (alive) setHtml(h); });
    return () => { alive = false; };
  }, [open, to, bill, via, design, cartons, company]);

  const set = (k) => (e) => setTo((t) => ({ ...t, [k]: e?.target ? e.target.value : e }));
  const canPrint = !!to.party_name.trim();

  const print = async () => {
    if (!canPrint) { message.warning('Type who it goes to'); nameRef.current?.focus(); return; }
    setPrinting(true);
    try {
      await printParcelTags({ company, party: to, billNumber: bill, totalParcels: cartons, note: via, design });
      const v = via.trim();
      if (v) setPref(RECENT_VIA_KEY, [v, ...recentVia.filter((x) => x.toLowerCase() !== v.toLowerCase())].slice(0, 6));
      message.success(`Sent ${cartons} label${cartons > 1 ? 's' : ''} to the printer`);
      onClose?.();
    } catch (e) {
      message.error('Could not print: ' + (e?.message || 'unknown error'));
    } finally {
      setPrinting(false);
    }
  };

  // Claim F1 / Ctrl+P / Esc before the page behind sees them.
  const printRef = useRef(print);
  printRef.current = print;
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      const k = e.key;
      const isPrint = k === 'F1' || ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'p');
      const isFn = /^F([2-9]|1[0-2])$/.test(k);
      if (!isPrint && !isFn && k !== 'Escape') return;
      // An open dropdown inside the dialog gets its own Esc.
      if (k === 'Escape' && document.querySelector('.ptd-root .ant-select-open, .ptd-pop:not(.ant-select-dropdown-hidden)')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (isPrint) printRef.current();
      else if (k === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  const pickSaved = (id) => {
    const p = (parties || []).find((x) => x.party_id === id);
    if (!p) return;
    setTo(fromParty(p));
    setSourceId(p.party_id);
  };
  const clearCustomer = () => {
    setTo(blank);
    setSourceId(null);
    setTimeout(() => nameRef.current?.focus(), 50);
  };

  const savedOptions = useMemo(() => (parties || [])
    .filter((p) => !p.is_system_cash)
    .map((p) => ({
      value: p.party_id,
      label: p.party_name,
      search: `${p.party_name} ${p.city || ''} ${p.mobile_1 || ''}`.toLowerCase(),
      city: p.city, mobile: p.mobile_1,
    })), [parties]);

  const missing = [!to.city && 'city', !to.pincode && 'PIN', !to.mobile_1 && 'mobile'].filter(Boolean);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={860}
      centered
      destroyOnClose
      keyboard={false}
      rootClassName="ptd-root"
      zIndex={1300}
      title={null}
    >
      <div className="ptd">
        <div className="ptd-form">
          <div className="ptd-head">
            <h2>Parcel label</h2>
            <p>10 × 10 cm · one label for each carton</p>
          </div>

          <div className="ptd-group">
            <div className="ptd-group-head">
              <span>Deliver to</span>
              {sourceId
                ? <button type="button" className="ptd-link" onClick={clearCustomer}><CloseCircleFilled /> Someone else</button>
                : savedOptions.length > 0 && (
                  <Select
                    size="small"
                    showSearch
                    placeholder="Fill from a saved customer"
                    className="ptd-pick"
                    popupClassName="ptd-pop"
                    value={null}
                    onChange={pickSaved}
                    filterOption={(input, opt) => opt.search.includes(input.toLowerCase())}
                    options={savedOptions}
                    optionRender={(o) => (
                      <div className="ptd-opt"><b>{o.data.label}</b><span>{[o.data.city, o.data.mobile].filter(Boolean).join(' · ')}</span></div>
                    )}
                    popupMatchSelectWidth={300}
                  />
                )}
            </div>
            <div className="ptd-fields">
              <Input ref={nameRef} className="ptd-name" placeholder="Name *" value={to.party_name} onChange={set('party_name')} maxLength={80} />
              <Input placeholder="Street, market, landmark" value={to.address_line_1} onChange={set('address_line_1')} maxLength={160} />
              <div className="ptd-row2">
                <Input placeholder="City" value={to.city} onChange={set('city')} maxLength={60} />
                <Input placeholder="PIN" value={to.pincode} maxLength={6} inputMode="numeric"
                       onChange={(e) => setTo((t) => ({ ...t, pincode: e.target.value.replace(/\D/g, '') }))} />
              </div>
              <Input placeholder="Mobile" value={to.mobile_1} maxLength={10} inputMode="numeric"
                     onChange={(e) => setTo((t) => ({ ...t, mobile_1: e.target.value.replace(/\D/g, '') }))} />
            </div>
            {sourceId && missing.length > 0 && (
              <div className="ptd-hint">No {missing.join(', ')} on file for this customer. Type it here for this label.</div>
            )}
            {sourceId && missing.length === 0 && (
              <div className="ptd-hint is-quiet">From the customer's details. Changes here are for this label only.</div>
            )}
          </div>

          <div className="ptd-group">
            <div className="ptd-group-head"><span>Parcel</span></div>
            <div className="ptd-parcel">
              <label className="ptd-cartons">
                <span>Cartons</span>
                <div className="ptd-stepper">
                  <button type="button" onClick={() => setCartons((n) => Math.max(1, n - 1))} aria-label="One less"><MinusOutlined /></button>
                  <InputNumber min={1} max={99} value={cartons} controls={false}
                               onChange={(v) => setCartons(Math.max(1, Math.min(99, parseInt(v, 10) || 1)))} />
                  <button type="button" onClick={() => setCartons((n) => Math.min(99, n + 1))} aria-label="One more"><PlusOutlined /></button>
                </div>
              </label>
              <label>
                <span>Bill no.</span>
                <Input value={bill} onChange={(e) => setBill(e.target.value)} placeholder="Optional" maxLength={30} />
              </label>
            </div>
            <label className="ptd-via">
              <span>Via (transport)</span>
              <AutoComplete
                value={via}
                onChange={setVia}
                options={recentVia.map((v) => ({ value: v }))}
                placeholder="e.g. VRL Logistics"
                popupClassName="ptd-pop"
                filterOption={(input, opt) => opt.value.toLowerCase().includes(input.toLowerCase())}
              />
            </label>
            {recentVia.length > 0 && !via && (
              <div className="ptd-chips">
                {recentVia.slice(0, 4).map((v) => (
                  <button type="button" key={v} onClick={() => setVia(v)}>{v}</button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="ptd-side">
          <div className="ptd-desk">
            <div className="ptd-paper">
              <iframe title="Parcel label preview" srcDoc={html} tabIndex={-1} />
            </div>
          </div>
          <div className="ptd-designs" role="radiogroup" aria-label="Label design">
            {PARCEL_DESIGNS.map((d) => (
              <button
                type="button" key={d.v} role="radio" aria-checked={design === d.v}
                className={`ptd-design${design === d.v ? ' is-on' : ''}`}
                onClick={() => setDesign(d.v)} title={d.d}
              >
                {d.l}{d.v === shopDesign && <i>Default</i>}
              </button>
            ))}
          </div>
          <div className="ptd-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="primary" icon={<PrinterOutlined />} loading={printing} disabled={!canPrint} onClick={print}>
              Print {cartons > 1 ? `${cartons} labels` : 'label'}
            </Button>
          </div>
          <div className="ptd-keys"><kbd>F1</kbd> print · <kbd>Esc</kbd> close</div>
        </div>
      </div>
    </Modal>
  );
}
