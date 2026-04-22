import React, { useEffect, useState } from 'react';
import { Button, Dropdown, message } from 'antd';
import { PrinterOutlined, DownOutlined, EyeOutlined } from '@ant-design/icons';
import { printAPI } from '../api';
import { printDocument } from '../services/printer';

/**
 * PrintButton — drop-in Print action for any bill/receipt row or detail page.
 *
 *   <PrintButton docType="sales" id={bill.sales_bill_id} />
 *   <PrintButton docType="sales" bill={fullyLoadedBill} size="small" />
 *
 * Behaviour:
 *   • Main click  → prints with the default profile for `docType` (silent
 *     when running in Electron, browser print dialog otherwise).
 *   • Caret arrow → dropdown listing every profile for this docType plus a
 *     "Preview" action; pick one to print ad-hoc without changing default.
 */
export default function PrintButton({ docType, id, bill, label = 'Print', size = 'middle', type = 'default' }) {
  const [profiles, setProfiles] = useState([]);

  // Lazy-load profiles only when the dropdown is opened the first time so
  // we don't fire one request per rendered row on list pages.
  const loadProfiles = async () => {
    if (profiles.length) return;
    try {
      const r = await printAPI.list({ doc_type: docType });
      setProfiles(r.data?.data || []);
    } catch {
      /* non-fatal — primary click path doesn't need the list */
    }
  };

  const handleQuickPrint = () => {
    printDocument({ docType, id, bill });
  };

  const handlePick = (profileId, { preview } = {}) => {
    printDocument({ docType, id, bill, profileId, preview });
  };

  const items = [
    ...profiles.map(p => ({
      key: `p-${p.profile_id}`,
      label: (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 200 }}>
          <span style={{ flex: 1 }}>{p.name}</span>
          <span style={{ fontSize: 11, color: '#888' }}>{p.format.toUpperCase()}</span>
          {p.is_default && <span style={{ fontSize: 10, color: '#F59E0B' }}>★</span>}
        </div>
      ),
      onClick: () => handlePick(p.profile_id),
    })),
    profiles.length ? { type: 'divider' } : null,
    {
      key: 'preview',
      icon: <EyeOutlined />,
      label: 'Preview in window',
      onClick: () => handlePick(undefined, { preview: true }),
    },
  ].filter(Boolean);

  return (
    <Dropdown.Button
      size={size}
      type={type}
      icon={<DownOutlined />}
      onClick={handleQuickPrint}
      onOpenChange={(open) => { if (open) loadProfiles(); }}
      menu={{ items }}
    >
      <PrinterOutlined /> {label}
    </Dropdown.Button>
  );
}
