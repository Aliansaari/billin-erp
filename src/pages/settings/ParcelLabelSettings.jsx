import React, { useEffect, useState } from 'react';
import { Button, Form, Input, Segmented, Select, Switch, Tooltip, message } from 'antd';
import { PrinterOutlined, CheckCircleFilled, ReloadOutlined } from '@ant-design/icons';
import {
  buildParcelTagHTML, printParcelTags, PARCEL_DESIGNS, PARCEL_DARKNESS, normaliseParcelDesign,
  getParcelPrinter, setParcelPrinter,
} from '../../utils/parcelTag';
import { listPrinters } from '../../services/printer';
import ParcelTagDialog from '../../components/ParcelTagDialog';
import { SettingsPage, Section, ToggleRow, useSystemSlice, SaveStrip } from './settingsKit';

/**
 * Parcel Labels — choose the shop's 10 × 10 cm parcel label design.
 *
 * Each card is the real label, drawn with this shop's own name and address
 * and a sample customer, so the choice is made on what will actually print.
 * The print dialog (sale form, customer details) starts on this design and
 * can still switch for a single print.
 */

const SAMPLE = {
  party: { party_name: 'NEW RAHUL GARMENTS', address_line_1: 'Shop 12, Kapda Market', city: 'Moradabad', pincode: '244001', mobile_1: '9876543210' },
  billNumber: 'SI-1043', totalParcels: 3, note: 'VRL Logistics',
};

const read = (s) => ({
  parcel_tag_design: normaliseParcelDesign(s.parcel_tag_design),
  parcel_tag_show_from: s.parcel_tag_show_from !== false,
  parcel_tag_on_sale_form: s.parcel_tag_on_sale_form !== false,
});
const write = (v) => ({
  parcel_tag_design: normaliseParcelDesign(v.parcel_tag_design),
  parcel_tag_show_from: v.parcel_tag_show_from !== false,
  parcel_tag_on_sale_form: v.parcel_tag_on_sale_form !== false,
});

export default function ParcelLabelSettings() {
  const [form] = Form.useForm();
  const { loading, saving, save, raw } = useSystemSlice(form, { read, write, savedText: 'Parcel label design saved' });
  const chosen = Form.useWatch('parcel_tag_design', form) || 'courier';
  const showFrom = Form.useWatch('parcel_tag_show_from', form) !== false;
  const [docs, setDocs] = useState({});
  const [testOpen, setTestOpen] = useState(false);
  // This computer's label printer — saved straight away, on this PC only.
  const [pp, setPp] = useState(getParcelPrinter);
  const [printers, setPrinters] = useState([]);
  const [printerErr, setPrinterErr] = useState('');
  const [testing, setTesting] = useState(false);
  const loadPrinters = () => listPrinters().then((r) => { setPrinters(r.printers || []); setPrinterErr(r.error || ''); });
  useEffect(() => { loadPrinters(); }, []);
  const changePrinter = (patch) => setPp(setParcelPrinter(patch));
  const testPrint = async () => {
    setTesting(true);
    try {
      await printParcelTags({ company: raw || {}, ...SAMPLE, totalParcels: 1, design: chosen, showFrom });
      message.success(pp.silent ? `Test label sent to ${pp.printer || 'the default printer'}` : 'Test label ready to print');
    } catch (e) {
      message.error('Could not print: ' + (e?.message || 'unknown error'));
    } finally { setTesting(false); }
  };

  // Draw every design with this shop's details once settings arrive.
  useEffect(() => {
    if (!raw) return;
    let alive = true;
    Promise.all(PARCEL_DESIGNS.map((d) => buildParcelTagHTML({ company: raw, ...SAMPLE, design: d.v, showFrom, darkness: pp.darkness }).then((h) => [d.v, h])))
      .then((pairs) => { if (alive) setDocs(Object.fromEntries(pairs)); });
    return () => { alive = false; };
  }, [raw, showFrom, pp.darkness]);

  return (
    <SettingsPage
      title="Parcel Labels"
      sub={<>The 10 × 10 cm label you stick on each carton. Pick a design, then save with <kbd>F1</kbd>.</>}
      actions={<Button icon={<PrinterOutlined />} onClick={() => setTestOpen(true)}>Print a label</Button>}
      strip={<SaveStrip form={form} loading={loading} saving={saving} />}
    >
      <Form form={form} onFinish={save} disabled={loading}>
        <Form.Item name="parcel_tag_design" hidden initialValue="courier"><Input /></Form.Item>
        <Section title="Design" desc="Shown with your shop's details and a sample customer. Every design is black and white, for thermal label printers.">
          <div className="pl-gallery" role="radiogroup" aria-label="Parcel label design">
            {PARCEL_DESIGNS.map((d) => {
              const on = chosen === d.v;
              return (
                <button
                  type="button" key={d.v} role="radio" aria-checked={on}
                  className={`pl-card${on ? ' is-on' : ''}`}
                  onClick={() => form.setFieldsValue({ parcel_tag_design: d.v })}
                >
                  <span className="pl-paper">
                    {docs[d.v] && <iframe title={d.l} srcDoc={docs[d.v]} tabIndex={-1} aria-hidden="true" />}
                  </span>
                  <span className="pl-cap">
                    <span className="pl-name">{d.l}{on && <CheckCircleFilled />}</span>
                    <span className="pl-desc">{d.d}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Section>

        <Section title="On the label">
          <ToggleRow name="parcel_tag_show_from" label={'Show "From"'}
                     desc="Your shop's name, address and phone on every label. Turn off for plain labels, or when the transporter fills the sender in. You can still change it for one print." />
        </Section>

        <Section title="Label printer" desc="For this computer only, and saved as soon as you change it. Each counter can use its own printer.">
          <div className="ms-row">
            <div>
              <div className="ms-row-label">Printer</div>
              <div className="ms-row-desc">{printerErr && !printers.length
                ? 'Printers can be picked in the ZEHEN desktop app.'
                : 'The thermal label printer with 100 × 100 mm labels loaded.'}</div>
            </div>
            <div className="ms-row-control">
              <Select
                value={pp.printer || ''}
                onChange={(v) => changePrinter({ printer: v || '' })}
                style={{ width: 260 }}
                showSearch
                options={[
                  { value: '', label: 'Windows default printer' },
                  ...printers.map((p) => ({ value: p.name, label: `${p.displayName || p.name}${p.isDefault ? ' (default)' : ''}` })),
                ]}
              />
              <Tooltip title="Look for printers again"><Button icon={<ReloadOutlined />} onClick={loadPrinters} /></Tooltip>
            </div>
          </div>
          <div className="ms-row">
            <div>
              <div className="ms-row-label">Print without asking</div>
              <div className="ms-row-desc">Sends labels straight to the printer at exactly 100 × 100 mm, edge to edge, with no print window. Off: the print window opens each time.</div>
            </div>
            <div className="ms-row-control">
              <Switch checked={pp.silent} onChange={(v) => changePrinter({ silent: v })} />
            </div>
          </div>
          <div className="ms-row">
            <div>
              <div className="ms-row-label">Print darkness</div>
              <div className="ms-row-desc">Thicker letters print darker on thermal labels. If small text comes out faint, choose Heavy.</div>
            </div>
            <div className="ms-row-control">
              <Segmented value={pp.darkness} onChange={(v) => changePrinter({ darkness: v })}
                         options={PARCEL_DARKNESS.map((d) => ({ value: d.v, label: d.l }))} />
            </div>
          </div>
          <div className="ms-row">
            <div>
              <div className="ms-row-label">Test print</div>
              <div className="ms-row-desc">Prints one sample label with the design and settings above.</div>
            </div>
            <div className="ms-row-control">
              <Button icon={<PrinterOutlined />} loading={testing} onClick={testPrint}>Print test label</Button>
            </div>
          </div>
        </Section>

        <Section title="Where you print it">
          <ToggleRow name="parcel_tag_on_sale_form" label="Button on the sale bill"
                     desc="A box button beside Add customer. Prints for the customer on the bill, or type anyone in. Off: the button is hidden." />
          <div className="ms-row">
            <div>
              <div className="ms-row-label">Customer details</div>
              <div className="ms-row-desc">Press F8 on a customer in the Customers list, then Print parcel label.</div>
            </div>
          </div>
        </Section>
      </Form>

      <ParcelTagDialog open={testOpen} onClose={() => setTestOpen(false)} company={raw ? { ...raw, parcel_tag_design: chosen, parcel_tag_show_from: showFrom } : undefined} />

      <style>{`
        .pl-gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(196px, 1fr)); gap: 14px; padding: 16px 0 18px; }
        .pl-card {
          display: flex; flex-direction: column; align-items: stretch; gap: 10px;
          padding: 12px; border-radius: 12px; cursor: pointer; text-align: left; font: inherit;
          border: 1.5px solid var(--border-subtle); background: var(--bg-muted);
          transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease;
        }
        .pl-card:hover { border-color: var(--border-strong); transform: translateY(-1px); }
        .pl-card.is-on { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-bg); background: var(--bg-panel); }
        .pl-paper {
          display: block; width: 100%; aspect-ratio: 1 / 1; position: relative; overflow: hidden;
          background: #fff; border-radius: 3px;
          box-shadow: 0 1px 2px rgba(0,0,0,.08), 0 10px 22px -12px rgba(30,20,10,.45);
        }
        /* The label is 378 px (100 mm); scale it to the card's width. */
        .pl-paper iframe { position: absolute; top: 0; left: 0; width: 378px; height: 378px; border: 0;
          transform-origin: 0 0; transform: scale(var(--pl-s, .46)); pointer-events: none; }
        .pl-cap { display: flex; flex-direction: column; gap: 3px; padding: 0 2px; }
        .pl-name { display: flex; align-items: center; justify-content: space-between; font-size: 13.5px; font-weight: 650; color: var(--fg-primary); }
        .pl-name .anticon { color: var(--accent); font-size: 15px; }
        .pl-desc { font-size: 12px; line-height: 1.45; color: var(--fg-tertiary); }
      `}</style>
      <PaperScale />
    </SettingsPage>
  );
}

// Keep each preview exactly as wide as its card: one shared scale var.
function PaperScale() {
  useEffect(() => {
    const fit = () => {
      const el = document.querySelector('.pl-paper');
      if (el) document.documentElement.style.setProperty('--pl-s', String(el.clientWidth / 378));
    };
    fit();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    const el = document.querySelector('.pl-gallery');
    if (ro && el) ro.observe(el);
    const t = setTimeout(fit, 300);
    return () => { ro?.disconnect(); clearTimeout(t); document.documentElement.style.removeProperty('--pl-s'); };
  }, []);
  return null;
}
