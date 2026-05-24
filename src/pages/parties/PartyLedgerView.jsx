import React, { useEffect, useState } from 'react';
import { Input, Tooltip, Spin, DatePicker, Empty, message } from 'antd';
import {
  PlusOutlined, SearchOutlined, EditOutlined, PrinterOutlined,
  DownloadOutlined, PhoneOutlined, StopOutlined, CloseOutlined,
  WhatsAppOutlined, FilterOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { partyAPI, dataAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import PartyForm from './PartyForm';

const fmt  = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

function printHTML(title, html) {
  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html><head><title>${title}</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 20px; color: #111; }
      h2 { margin-bottom: 4px; } p { margin: 0 0 12px; color: #555; font-size: 13px; }
      table { width: 100%; border-collapse: collapse; }
      th { background: #f3f4f6; font-weight: 600; font-size: 12px; padding: 7px 10px; border: 1px solid #d1d5db; text-align: left; }
      td { padding: 6px 10px; border: 1px solid #e5e7eb; font-size: 12px; }
      tr:nth-child(even) td { background: #f9fafb; }
      .right { text-align: right; }
      .footer { margin-top: 14px; text-align: right; font-weight: 600; font-size: 13px; }
    </style>
  </head><body>${html}</body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}

const TYPE_COLOR = {
  'Sales Bill':          { color:'#1d4ed8', bg:'#eff6ff' },
  'Purchase Bill':       { color:'#b45309', bg:'#fffbeb' },
  'Receipt':             { color:'#15803d', bg:'#f0fdf4' },
  'Payment':             { color:'#b91c1c', bg:'#fef2f2' },
  'Payment at Billing':  { color:'#4338ca', bg:'#eef2ff' },
  'Opening Balance':     { color:'#6b7280', bg:'#f9fafb' },
};

export default function PartyLedgerView({ partyType }) {
  const isCustomer = partyType === 'Customer';
  const navigate   = useNavigate();
  const { fyStart, fyEnd } = useFinancialYear();

  const [parties, setParties]         = useState([]);
  const [loading, setLoading]         = useState(false);
  const [search, setSearch]           = useState('');
  const [showInactive, setShowInactive] = useState(false);

  const [selected, setSelected]       = useState(null);
  const [ledger, setLedger]           = useState({ entries: [], total_debit: 0, total_credit: 0, closing_balance: 0 });
  const [ledgerLoading, setLedgerLoading] = useState(false);

  const [txSearch, setTxSearch]       = useState('');
  // Default to company FY for consistency.
  const [dateRange, setDateRange]     = useState([
    fyStart ? dayjs(fyStart) : null,
    fyEnd   ? dayjs(fyEnd)   : null,
  ]);

  const [formVisible, setFormVisible] = useState(false);
  const [editingParty, setEditingParty] = useState(null);
  const [formLoading, setFormLoading] = useState(false);

  useEffect(() => { loadParties(); }, [search]);

  const loadParties = async () => {
    setLoading(true);
    try {
      partyAPI.recalculateBalances().catch(() => {});
      const { data } = isCustomer
        ? await partyAPI.getCustomers({ search, limit: 5000 })
        : await partyAPI.getSuppliers({ search, limit: 5000 });
      const list = data.data || [];
      setParties(list);
      if (!selected && list.length > 0) setSelected(list[0]);
    } catch { message.error(`Failed to load ${partyType.toLowerCase()}s`); }
    setLoading(false);
  };

  useEffect(() => {
    if (selected?.party_id) { setDateRange([null, null]); loadLedger(selected.party_id, [null, null]); }
  }, [selected?.party_id]);

  const loadLedger = async (partyId, range) => {
    if (!partyId) return;
    setLedgerLoading(true);
    const params = {};
    if (range?.[0]) params.from_date = dayjs(range[0]).format('YYYY-MM-DD');
    if (range?.[1]) params.to_date   = dayjs(range[1]).format('YYYY-MM-DD');
    try {
      const { data } = await partyAPI.getLedger(partyId, params);
      // Prepend a synthetic "Opening Balance" row so the ledger list looks the same
      // as before (backend now returns opening_balance as a separate signed value,
      // not as the first entry). Keeps the UI's italic-opening-row styling working.
      if (data && Array.isArray(data.entries)) {
        const ob = parseFloat(data.opening_balance || 0);
        const openingRow = {
          date: params.from_date || (data.party?.created_date || null),
          particulars: 'Opening Balance',
          ref_number: '-',
          debit:   ob > 0 ?  ob : 0,
          credit:  ob < 0 ? -ob : 0,
          balance: +ob.toFixed(2),
          type: 'opening',
        };
        data.entries = [openingRow, ...data.entries];
      }
      setLedger(data || { entries: [], total_debit: 0, total_credit: 0, closing_balance: 0 });
      if (data?.party) {
        const bal = parseFloat(data.party.current_balance || 0);
        setParties(prev => prev.map(p => p.party_id === partyId ? { ...p, current_balance: bal } : p));
        setSelected(prev => prev?.party_id === partyId ? { ...prev, current_balance: bal } : prev);
      }
    } catch { setLedger({ entries: [], total_debit: 0, total_credit: 0, closing_balance: 0 }); }
    setLedgerLoading(false);
  };

  const applyDateRange = (r) => { setDateRange(r); if (selected?.party_id) loadLedger(selected.party_id, r); };

  const handleSubmit = async (values) => {
    setFormLoading(true);
    try {
      if (editingParty) {
        await partyAPI.update(editingParty.party_id, values);
        message.success(`${partyType} updated`);
      } else {
        const { data } = await partyAPI.create({ ...values, party_type: partyType });
        message.success(`${partyType} added`);
        setSelected(data);
      }
      setFormVisible(false); setEditingParty(null);
      await loadParties();
      const rid = editingParty ? editingParty.party_id : selected?.party_id;
      if (rid) loadLedger(rid, [null, null]);
    } catch (e) { message.error(e.response?.data?.error || 'Failed to save'); }
    setFormLoading(false);
  };

  const handleDeleted = (partyId) => {
    setFormVisible(false); setEditingParty(null);
    setParties(prev => prev.filter(p => p.party_id !== partyId));
    if (selected?.party_id === partyId) setSelected(null);
    loadParties();
  };

  const handleExport = async () => {
    try {
      // Pass the search filter so the workbook reflects whatever the user has
      // currently typed in the search box, not the entire customer/supplier master.
      const { data } = await dataAPI.exportExcel(
        isCustomer ? 'customers' : 'suppliers',
        search ? { search } : {}
      );
      const url = window.URL.createObjectURL(new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      // Date-stamp with LOCAL date — lets users identify which export is newest.
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `${partyType.toLowerCase()}s_${stamp}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch { message.error('Export failed'); }
  };

  const handlePrintList = () => {
    const rows = parties.map(p => {
      const bal = parseFloat(p.current_balance || 0);
      return `<tr><td>${p.party_name}</td><td>${p.mobile_1||'—'}</td><td>${p.city||'—'}</td>
              <td class="right" style="color:${bal>0?'#dc2626':bal<0?'#16a34a':'#6b7280'}">${fmt(Math.abs(bal))}</td></tr>`;
    }).join('');
    printHTML(`${partyType} List`,
      `<h2>${partyType} List</h2><p>Total: ${parties.length} — ${dayjs().format('DD/MM/YYYY HH:mm')}</p>
       <table><thead><tr><th>Name</th><th>Mobile</th><th>City</th><th class="right">Balance</th></tr></thead>
       <tbody>${rows}</tbody></table>`);
  };

  const handlePrintLedger = () => {
    if (!selected) return;
    const rows = (ledger.entries || []).map(e => `<tr>
      <td>${e.particulars}</td><td>${e.ref_number||'—'}</td>
      <td>${e.date?dayjs(e.date).format('DD/MM/YYYY'):'—'}</td>
      <td class="right" style="color:#1d4ed8">${e.debit>0?fmt(e.debit):'—'}</td>
      <td class="right" style="color:#059669">${e.credit>0?fmt(e.credit):'—'}</td>
      <td class="right">${e.balance===0?'—':fmt(Math.abs(e.balance))+(e.balance>0?' Dr':' Cr')}</td>
    </tr>`).join('');
    const bal = ledger.closing_balance || 0;
    printHTML(`Ledger — ${selected.party_name}`,
      `<h2>Ledger: ${selected.party_name}</h2><p>Printed: ${dayjs().format('DD/MM/YYYY HH:mm')}</p>
       <table><thead><tr><th>Type</th><th>Number</th><th>Date</th><th class="right">Debit</th><th class="right">Credit</th><th class="right">Balance</th></tr></thead>
       <tbody>${rows}</tbody></table>
       <div class="footer">Debit: ${fmt(ledger.total_debit||0)} | Credit: ${fmt(ledger.total_credit||0)} | Balance: ${fmt(Math.abs(bal))} ${bal>0?'Dr':bal<0?'Cr':''}</div>`);
  };

  const filteredEntries = (ledger.entries || []).filter(e => {
    if (!txSearch) return true;
    const q = txSearch.toLowerCase();
    return (e.particulars||'').toLowerCase().includes(q) || (e.ref_number||'').toLowerCase().includes(q) ||
           (e.date ? dayjs(e.date).format('DD/MM/YYYY') : '').includes(q);
  });

  const visibleParties = parties.filter(p => showInactive ? !p.is_active : p.is_active !== false);
  const balance = selected?.current_balance || 0;

  /* ── shared button style ── */
  const btn = (bg, color = '#fff', border = 'none') => ({
    display:'flex', alignItems:'center', gap:6,
    background:bg, border, borderRadius:8, color,
    fontWeight:600, fontSize:13, padding:'7px 16px',
    cursor:'pointer', whiteSpace:'nowrap', lineHeight:1,
  });
  const iconBtn = (bg = '#f3f4f6', color = '#374151') => ({
    display:'flex', alignItems:'center', justifyContent:'center',
    background:bg, border:'1px solid #e5e7eb', borderRadius:8,
    color, cursor:'pointer', padding:'7px 10px', fontSize:14,
  });

  const PRESETS = [
    { label:'This Month', v:[dayjs().startOf('month'), dayjs().endOf('month')] },
    { label:'Last Month', v:[dayjs().subtract(1,'month').startOf('month'), dayjs().subtract(1,'month').endOf('month')] },
    { label:'This Year',  v:[dayjs().startOf('year'), dayjs().endOf('year')] },
  ];

  return (
    <div style={{ height:'calc(100vh - 64px)', display:'flex', flexDirection:'column', background:'#f8fafc', overflow:'hidden' }}>

      {/* ══ Top bar ══ */}
      <div style={{ background:'#fff', borderBottom:'1px solid #e5e7eb', padding:'10px 24px', flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:10 }}>

          {/* Left: title + search */}
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <span style={{ fontSize:16, fontWeight:700, color:'#111827' }}>{isCustomer ? 'Customers' : 'Suppliers'}</span>
            <span style={{ fontSize:12, background:'#eff6ff', color:'#1d4ed8', borderRadius:20, padding:'3px 12px', fontWeight:600 }}>
              {visibleParties.length}
            </span>
          </div>

          {/* Right: actions */}
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            {isCustomer && (
              <button onClick={() => navigate('/sale/new')} style={btn('#ef4444')}>
                <PlusOutlined/> New Sale
              </button>
            )}
            <button onClick={() => navigate(isCustomer ? '/receipt/new' : '/payment/new')} style={btn('#fff','#374151','1px solid #e5e7eb')}>
              <PlusOutlined/> {isCustomer ? 'Add Receipt' : 'Add Payment'}
            </button>
            {!isCustomer && (
              <button onClick={() => navigate('/purchase/new')} style={btn('#f59e0b')}>
                <PlusOutlined/> New Purchase
              </button>
            )}
            <button onClick={() => { setEditingParty(null); setFormVisible(true); }} style={btn('#4f46e5')}>
              <PlusOutlined/> Add {partyType}
            </button>
            <Tooltip title={`Print ${partyType} list`}>
              <button onClick={handlePrintList} style={iconBtn()}><PrinterOutlined/></button>
            </Tooltip>
            <Tooltip title="Export Excel">
              <button onClick={handleExport} style={iconBtn()}><DownloadOutlined/></button>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* ══ Split panel ══ */}
      <div style={{ flex:1, display:'flex', overflow:'hidden' }}>

        {/* ── LEFT: party list ── */}
        <div style={{ width:260, flexShrink:0, borderRight:'1px solid #e5e7eb', display:'flex', flexDirection:'column', background:'#fff', overflow:'hidden' }}>

          {/* Search + toggle */}
          <div style={{ padding:'10px 12px', borderBottom:'1px solid #f3f4f6', display:'flex', flexDirection:'column', gap:8 }}>
            <Input
              prefix={<SearchOutlined style={{ color:'#9ca3af' }}/>}
              placeholder={`Search ${partyType.toLowerCase()}s…`}
              value={search}
              onChange={e => setSearch(e.target.value)}
              allowClear size="small"
            />
            <div style={{ display:'flex', gap:4 }}>
              {[false, true].map(inactive => (
                <button
                  key={String(inactive)}
                  onClick={() => setShowInactive(inactive)}
                  style={{
                    flex:1, fontSize:12, fontWeight:600, padding:'4px 0',
                    borderRadius:6, cursor:'pointer', border:'none',
                    background: showInactive === inactive ? (inactive ? '#fef2f2' : '#eff6ff') : '#f3f4f6',
                    color: showInactive === inactive ? (inactive ? '#dc2626' : '#1d4ed8') : '#6b7280',
                  }}
                >
                  {inactive ? 'Inactive' : 'Active'}
                </button>
              ))}
            </div>
          </div>

          {/* Column labels */}
          <div style={{ display:'flex', justifyContent:'space-between', padding:'5px 14px', background:'#fafafa', borderBottom:'1px solid #f3f4f6' }}>
            <span style={{ fontSize:11, fontWeight:700, color:'#9ca3af', textTransform:'uppercase', letterSpacing:.5 }}>Party Name</span>
            <span style={{ fontSize:11, fontWeight:700, color:'#9ca3af', textTransform:'uppercase', letterSpacing:.5 }}>Balance</span>
          </div>

          {/* List */}
          <div style={{ flex:1, overflowY:'auto' }}>
            {loading ? (
              <div style={{ display:'flex', justifyContent:'center', padding:30 }}><Spin/></div>
            ) : visibleParties.length === 0 ? (
              <div style={{ padding:24, textAlign:'center', color:'#9ca3af', fontSize:13 }}>No {partyType.toLowerCase()}s found</div>
            ) : visibleParties.map(p => {
              const isActive = selected?.party_id === p.party_id;
              const bal = parseFloat(p.current_balance || 0);
              return (
                <div
                  key={p.party_id}
                  onClick={() => setSelected(p)}
                  style={{
                    display:'flex', justifyContent:'space-between', alignItems:'center',
                    padding:'9px 14px', cursor:'pointer',
                    background: isActive ? '#eff6ff' : '#fff',
                    borderBottom:'1px solid #f9fafb',
                    borderLeft:`3px solid ${isActive ? '#4f46e5' : 'transparent'}`,
                    transition:'background .12s',
                  }}
                  onMouseEnter={e => { if (!isActive) e.currentTarget.style.background='#f9fafb'; }}
                  onMouseLeave={e => { if (!isActive) e.currentTarget.style.background='#fff'; }}
                >
                  <span style={{ fontSize:13, fontWeight: isActive ? 600 : 400, color: isActive ? '#1d4ed8' : '#374151', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', flex:1, minWidth:0 }}>
                    {p.party_name}
                  </span>
                  <span style={{ fontSize:12, fontWeight:700, color: bal > 0 ? '#ef4444' : bal < 0 ? '#10b981' : '#9ca3af', flexShrink:0, marginLeft:6 }}>
                    {Math.abs(bal).toLocaleString('en-IN', { minimumFractionDigits:2 })}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── RIGHT: ledger ── */}
        <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:'#fff' }}>
          {!selected ? (
            <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center' }}>
              <Empty description={`Select a ${partyType.toLowerCase()} to view ledger`}/>
            </div>
          ) : (
            <>
              {/* Party header */}
              <div style={{ padding:'12px 24px', borderBottom:'1px solid #e5e7eb', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <span style={{ fontSize:16, fontWeight:700, color:'#111827' }}>{selected.party_name}</span>
                  <Tooltip title="Edit">
                    <button onClick={() => { setEditingParty(selected); setFormVisible(true); }}
                      style={{ background:'none', border:'none', cursor:'pointer', color:'#6366f1', fontSize:14, padding:'2px 4px', display:'flex', alignItems:'center' }}>
                      <EditOutlined/>
                    </button>
                  </Tooltip>
                  {balance !== 0 && (
                    <span style={{ fontSize:12, fontWeight:600, padding:'3px 12px', borderRadius:20, background: balance > 0 ? '#fef2f2' : '#f0fdf4', color: balance > 0 ? '#ef4444' : '#10b981' }}>
                      {balance > 0 ? 'Receivable' : 'Payable'}: {fmt(Math.abs(balance))}
                    </span>
                  )}
                </div>
                <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                  {selected.mobile_1 && (
                    <>
                      <Tooltip title={`Call ${selected.mobile_1}`}>
                        <button onClick={() => window.location.href=`tel:+91${selected.mobile_1}`} style={iconBtn('#f0fdf4','#16a34a')}><PhoneOutlined/></button>
                      </Tooltip>
                      <Tooltip title={`WhatsApp ${selected.mobile_1}`}>
                        <button onClick={() => window.open(`https://wa.me/91${selected.mobile_1}`)} style={iconBtn('#f0fdf4','#16a34a')}><WhatsAppOutlined/></button>
                      </Tooltip>
                    </>
                  )}
                  <Tooltip title="Print ledger">
                    <button onClick={handlePrintLedger} style={iconBtn()}><PrinterOutlined/></button>
                  </Tooltip>
                  <Tooltip title="Export Excel">
                    <button onClick={handleExport} style={iconBtn()}><DownloadOutlined/></button>
                  </Tooltip>
                </div>
              </div>

              {/* Filter bar */}
              <div style={{ padding:'8px 24px', borderBottom:'1px solid #f3f4f6', background:'#fafafa', display:'flex', alignItems:'center', justifyContent:'space-between', gap:10, flexShrink:0, flexWrap:'wrap' }}>
                {/* Date range */}
                <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                  <div style={{ display:'flex', alignItems:'center', background:'#fff', border:'1px solid #d1d5db', borderRadius:8, overflow:'hidden', height:32 }}>
                    <DatePicker
                      size="small" value={dateRange[0]}
                      onChange={d => applyDateRange([d, dateRange[1]])}
                      format="DD MMM YY" placeholder="From" allowClear={false}
                      style={{ border:'none', boxShadow:'none', width:100, background:'transparent' }}
                      suffixIcon={null}
                    />
                    <span style={{ color:'#d1d5db', padding:'0 6px', borderLeft:'1px solid #e5e7eb', borderRight:'1px solid #e5e7eb' }}>–</span>
                    <DatePicker
                      size="small" value={dateRange[1]}
                      onChange={d => applyDateRange([dateRange[0], d])}
                      format="DD MMM YY" placeholder="To" allowClear={false}
                      style={{ border:'none', boxShadow:'none', width:100, background:'transparent' }}
                      suffixIcon={null}
                    />
                    {(dateRange[0] || dateRange[1]) && (
                      <button onClick={() => applyDateRange([null, null])}
                        style={{ border:'none', borderLeft:'1px solid #e5e7eb', background:'none', cursor:'pointer', padding:'0 8px', height:'100%', color:'#9ca3af', display:'flex', alignItems:'center' }}>
                        <CloseOutlined style={{ fontSize:9 }}/>
                      </button>
                    )}
                  </div>
                  {PRESETS.map(p => {
                    const active = dateRange[0] && dateRange[1] &&
                      dayjs(dateRange[0]).format('YYYY-MM-DD') === p.v[0].format('YYYY-MM-DD') &&
                      dayjs(dateRange[1]).format('YYYY-MM-DD') === p.v[1].format('YYYY-MM-DD');
                    return (
                      <button key={p.label} onClick={() => applyDateRange(active ? [null,null] : p.v)}
                        style={{ fontSize:12, fontWeight:600, padding:'5px 14px', borderRadius:20, cursor:'pointer', border: `1px solid ${active?'#4f46e5':'#e5e7eb'}`, background: active ? '#4f46e5' : '#fff', color: active ? '#fff' : '#6b7280', transition:'all .15s' }}>
                        {p.label}
                      </button>
                    );
                  })}
                </div>

                {/* Search */}
                <Input
                  prefix={<SearchOutlined style={{ color:'#9ca3af' }}/>}
                  placeholder="Search transactions…"
                  value={txSearch}
                  onChange={e => setTxSearch(e.target.value)}
                  allowClear size="small"
                  style={{ width:200 }}
                />
              </div>

              {/* Column headers */}
              <div style={{ display:'grid', gridTemplateColumns:'160px 130px 110px 1fr 130px 130px 150px', padding:'8px 24px', borderBottom:'2px solid #e5e7eb', background:'#f9fafb', flexShrink:0 }}>
                {['Type','Number','Date','Particulars','Debit','Credit','Balance'].map(h => (
                  <div key={h} style={{ fontSize:11, fontWeight:700, color:'#9ca3af', textTransform:'uppercase', letterSpacing:.5 }}>{h}</div>
                ))}
              </div>

              {/* Ledger rows */}
              <div style={{ flex:1, overflowY:'auto' }}>
                {ledgerLoading ? (
                  <div style={{ display:'flex', justifyContent:'center', padding:40 }}><Spin/></div>
                ) : filteredEntries.length === 0 ? (
                  <Empty description="No transactions yet" style={{ marginTop:60 }}/>
                ) : filteredEntries.map((e, i) => {
                  const isOpening = e.particulars === 'Opening Balance';
                  const tc = TYPE_COLOR[e.particulars] || { color:'#374151', bg:'#f3f4f6' };
                  return (
                    <div key={`${e.ref_number||'x'}-${i}`}
                      style={{
                        display:'grid', gridTemplateColumns:'160px 130px 110px 1fr 130px 130px 150px',
                        padding:'10px 24px', borderBottom:'1px solid #f3f4f6',
                        background: isOpening ? '#f8fafc' : i%2===0 ? '#fff' : '#fafafa',
                        alignItems:'center', transition:'background .1s',
                        fontStyle: isOpening ? 'italic' : 'normal',
                      }}
                      onMouseEnter={ev => ev.currentTarget.style.background='#eff6ff'}
                      onMouseLeave={ev => ev.currentTarget.style.background = isOpening ? '#f8fafc' : i%2===0 ? '#fff' : '#fafafa'}
                    >
                      <div>
                        <span style={{ fontSize:12, fontWeight:600, padding:'3px 10px', borderRadius:20, color:tc.color, background:tc.bg }}>
                          {e.particulars}
                        </span>
                      </div>
                      <div style={{ fontSize:13 }}>
                        {e.type==='sales'
                          ? <a style={{ color:'#4f46e5', fontWeight:600 }} onClick={() => navigate(`/sale/edit/${e.id}`)}>{e.ref_number||'—'}</a>
                          : e.type==='purchase'
                          ? <a style={{ color:'#4f46e5', fontWeight:600 }} onClick={() => navigate(`/purchase/edit/${e.id}`)}>{e.ref_number||'—'}</a>
                          : <span style={{ color:'#374151' }}>{e.ref_number||'—'}</span>
                        }
                      </div>
                      <div style={{ fontSize:13, color:'#6b7280' }}>{e.date ? dayjs(e.date).format('DD/MM/YYYY') : '—'}</div>
                      <div style={{ fontSize:13, color:'#9ca3af', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{e.remarks||e.particulars}</div>
                      <div style={{ fontSize:13, fontWeight:600, color: e.debit>0?'#1d4ed8':'#d1d5db', textAlign:'right', paddingRight:8 }}>
                        {e.debit > 0 ? fmt(e.debit) : '—'}
                      </div>
                      <div style={{ fontSize:13, fontWeight:600, color: e.credit>0?'#059669':'#d1d5db', textAlign:'right', paddingRight:8 }}>
                        {e.credit > 0 ? fmt(e.credit) : '—'}
                      </div>
                      <div style={{ fontSize:13, fontWeight:700, textAlign:'right', color: e.balance>0?'#ef4444':e.balance<0?'#10b981':'#6b7280' }}>
                        {e.balance === 0 ? '—' : `${fmt(Math.abs(e.balance||0))} ${e.balance>0?'Dr':'Cr'}`}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Footer totals */}
              <div style={{ padding:'10px 24px', borderTop:'1px solid #e5e7eb', background:'#fafafa', display:'flex', justifyContent:'flex-end', gap:24, flexShrink:0, flexWrap:'wrap' }}>
                <span style={{ fontSize:13, color:'#6b7280' }}>
                  Total Debit: <strong style={{ color:'#1d4ed8' }}>{fmt(ledger.total_debit||0)}</strong>
                </span>
                <span style={{ fontSize:13, color:'#6b7280' }}>
                  Total Credit: <strong style={{ color:'#059669' }}>{fmt(ledger.total_credit||0)}</strong>
                </span>
                <span style={{ fontSize:13, fontWeight:700, color:'#111827' }}>
                  Closing Balance:{' '}
                  <span style={{ color:(ledger.closing_balance||0)>0?'#ef4444':'#10b981' }}>
                    {fmt(Math.abs(ledger.closing_balance||0))} {(ledger.closing_balance||0)>0?'Dr':'Cr'}
                  </span>
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      <PartyForm
        visible={formVisible}
        onCancel={() => { setFormVisible(false); setEditingParty(null); }}
        onSubmit={handleSubmit}
        onDeleted={handleDeleted}
        initialValues={editingParty}
        partyType={partyType}
        loading={formLoading}
      />
    </div>
  );
}
