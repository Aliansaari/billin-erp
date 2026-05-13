/*
 * useIndianStates — shared hook for state-picker dropdowns.
 *
 * Loads the canonical states list from GET /api/states. The endpoint
 * returns rows like { state_id, state_name, gst_code, is_union_territory }
 * already sorted by sort_order (so consumers can render straight through).
 *
 * Falls back to a built-in const if the request fails (offline / brand-
 * new server still booting). Either way the dropdown never goes blank.
 *
 * One global cache, hydrated lazily on first call. Mounting CompanyProfile
 * and OnboardingWizard in the same session shares the same fetch — no
 * duplicate requests.
 *
 * Returns:
 *   options  — Array<{ value, label }> ready for AntD <Select options={...} />
 *   loading  — true while the initial fetch is in flight
 *   names    — Array<string> of just state names (for callers that need
 *              a flat list, e.g. server-side validators on the client)
 */

import { useEffect, useState } from 'react';
import { statesAPI } from '../api';

// Hardcoded fallback. Used when the API call fails so the dropdown
// stays functional. Update list mirrored in
// server/seeders/defaultData.js — keep them in sync if states ever change.
export const FALLBACK_INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand',
  'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
  'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi',
  'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
];

// Process-level cache. Avoids the every-mount round trip when multiple
// components on the same page each call the hook.
let _cache = null;
let _inflight = null;

async function loadOnce() {
  if (_cache) return _cache;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const r = await statesAPI.list();
      const rows = r.data?.data || r.data || [];
      if (Array.isArray(rows) && rows.length > 0) {
        _cache = rows;
        return _cache;
      }
      // Empty response — fall back to the hardcoded list so the dropdown
      // doesn't render blank. Don't cache the fallback so a later boot
      // (where the seed has finished) will try the server again.
      return FALLBACK_INDIAN_STATES.map((name, i) => ({
        state_id: -1 - i, state_name: name, gst_code: null, is_union_territory: false,
      }));
    } catch {
      return FALLBACK_INDIAN_STATES.map((name, i) => ({
        state_id: -1 - i, state_name: name, gst_code: null, is_union_territory: false,
      }));
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

export default function useIndianStates() {
  const [rows, setRows] = useState(_cache || []);
  const [loading, setLoading] = useState(!_cache);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await loadOnce();
      if (cancelled) return;
      setRows(r);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const options = rows.map((r) => ({ value: r.state_name, label: r.state_name }));
  const names = rows.map((r) => r.state_name);

  return { options, names, loading, rows };
}
