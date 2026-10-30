import { useCallback, useEffect, useRef } from 'react';
import { useTabId } from '../tabs/tabContext';

/*
 * useBillAutosave — an unfinished bill survives a crash, a power cut, a
 * sign-out or a closed window.
 *
 * While a NEW bill has something on it, the form's draft (the same
 * sales/purchase draft that Hold uses) is written every few seconds:
 *
 *   server   sales_bill_drafts / purchase drafts, payload._autosave = true.
 *            Postgres is durable across power loss, and the draft shows in
 *            the Drafts list like any held bill.
 *   local    a copy in localStorage, for when the server can't be reached
 *            (session ended, server PC down).
 *
 * The draft becomes the form's recalled draft, so saving the bill deletes it
 * inside the same transaction (the existing Hold → Recall → Save path).
 * Hold turns it into an ordinary held draft; Reset discards it.
 *
 * On the next visit, findRecovery() returns this user's most recent
 * unfinished bill so the form can offer to continue it.
 *
 * The form supplies:
 *   enabled          new bill (not editing an existing one)
 *   dirty            something worth keeping is on the form
 *   buildPayload()   the same payload Hold sends
 *   draftApi         salesDraftAPI | purchaseDraftAPI
 *   recalledDraftId / setRecalledDraftId
 *   storageKey       e.g. 'zehen_autosave_sales_<userId>'
 *   userId
 */
const EVERY_MS = 4000;

/* Bills open in tabs right now. Two tabs can each hold a bill, so:
 *   openDrafts   draft id → tab id: a draft open in one tab is never offered
 *                for recovery (or recalled) in another.
 *   instances    storage key → tab ids with a form mounted: the local copy is
 *                shared per user, so while another tab has a bill it is not
 *                "an unfinished bill from last time".
 *   closeFlush   tab id → write-now, awaited before a tab with a bill closes. */
const openDrafts = new Map();
const instances = new Map();
const closeFlush = new Map();

/** The tab a draft is open in, if any. */
export const tabOfDraft = (draftId) => openDrafts.get(draftId) ?? null;

/** Save the bill in this tab right now (before the tab closes). */
export async function flushTabBill(tabId) {
  const f = closeFlush.get(tabId);
  if (f) { try { await f(); } catch { /* the 4-second copy stands */ } }
}

const readLocal = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
const writeLocal = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* full or blocked */ } };
const dropLocal = (key) => { try { localStorage.removeItem(key); } catch { /* blocked */ } };

export default function useBillAutosave({ enabled, dirty, buildPayload, draftApi, recalledDraftId, setRecalledDraftId, storageKey, userId }) {
  const tabId = useTabId() ?? 'root';
  const ownedId = useRef(null);        // draft created by autosave (ours to discard on Reset)
  const lastJson = useRef('');
  const busy = useRef(false);
  // Bumped when the bill is saved, held or reset. A write that started
  // before that must not leave a draft behind (it would offer a bill that
  // was already saved for billing again).
  const gen = useRef(0);
  const live = useRef({});
  live.current = { enabled, dirty, buildPayload, recalledDraftId };

  const tick = useCallback(async () => {
    const { enabled: on, dirty: has, buildPayload: build, recalledDraftId: rid } = live.current;
    if (!on || !has || busy.current || !build) return;
    let payload;
    try { payload = build(); } catch { return; }
    const json = JSON.stringify(payload);
    if (json === lastJson.current) return;
    const stamped = { ...payload, _autosave: rid == null || rid === ownedId.current, _autosaved_at: new Date().toISOString() };
    // Local copy first: it works even when the server does not.
    writeLocal(storageKey, { at: Date.now(), draft_id: rid || null, payload: stamped });
    busy.current = true;
    const myGen = gen.current;
    try {
      if (rid) {
        if (myGen !== gen.current) return;
        await draftApi.update(rid, stamped);
      } else {
        const { data } = await draftApi.create(stamped);
        if (data?.draft_id && myGen !== gen.current) {
          // The bill was saved / held / cleared while this was in flight.
          try { await draftApi.delete(data.draft_id); } catch { /* best effort */ }
          return;
        }
        if (data?.draft_id) {
          ownedId.current = data.draft_id;
          setRecalledDraftId(data.draft_id);
          writeLocal(storageKey, { at: Date.now(), draft_id: data.draft_id, payload: stamped });
        }
      }
      lastJson.current = json;
    } catch { /* offline or signed out: the local copy stands; retry next tick */ }
    finally { busy.current = false; }
  }, [draftApi, setRecalledDraftId, storageKey]);

  useEffect(() => {
    if (!instances.has(storageKey)) instances.set(storageKey, new Set());
    instances.get(storageKey).add(tabId);
    return () => { instances.get(storageKey)?.delete(tabId); };
  }, [storageKey, tabId]);

  useEffect(() => {
    if (recalledDraftId == null) return undefined;
    openDrafts.set(recalledDraftId, tabId);
    return () => { if (openDrafts.get(recalledDraftId) === tabId) openDrafts.delete(recalledDraftId); };
  }, [recalledDraftId, tabId]);

  const othersOpen = () => [...(instances.get(storageKey) || [])].some((t) => t !== tabId);

  useEffect(() => {
    if (!enabled) return undefined;
    closeFlush.set(tabId, tick);
    const t = setInterval(tick, EVERY_MS);
    const flush = () => { tick(); };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      clearInterval(t); window.removeEventListener('beforeunload', flush); document.removeEventListener('visibilitychange', flush);
      if (closeFlush.get(tabId) === tick) closeFlush.delete(tabId);
    };
  }, [enabled, tick, tabId]);

  /** The bill was saved (its draft is already deleted server-side) or held. */
  const settled = useCallback(() => {
    gen.current += 1;
    const mine = ownedId.current;
    ownedId.current = null; lastJson.current = '';
    // The local copy is per user: leave it if it is another open tab's bill.
    const loc = readLocal(storageKey);
    if (!othersOpen() || !loc?.draft_id || loc.draft_id === mine) dropLocal(storageKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, tabId]);

  /** The operator cleared the form on purpose: drop the draft autosave made. */
  const discard = useCallback(async () => {
    const id = ownedId.current;
    settled();
    if (id) { try { await draftApi.delete(id); } catch { /* already gone */ } }
  }, [draftApi, settled]);

  /** Continue writing into a recovered autosave draft. */
  const adopt = useCallback((draftId) => { ownedId.current = draftId; lastJson.current = ''; gen.current += 1; }, []);

  /** Was this draft created by autosave (not a deliberate Hold)? */
  const isOwned = useCallback((draftId) => draftId != null && draftId === ownedId.current, []);

  /**
   * This user's most recent unfinished bill, if any:
   *   { source: 'server', draft } — an autosave draft in the drafts list
   *   { source: 'local', payload, at } — only the local copy survived
   */
  const findRecovery = useCallback((drafts, listOk) => {
    const elsewhere = (id) => openDrafts.has(id) && openDrafts.get(id) !== tabId;
    const mine = (drafts || [])
      .filter((d) => d.payload?._autosave && !elsewhere(d.draft_id) && (!userId || d.created_by == null || d.created_by === userId))
      .sort((a, b) => String(b.payload._autosaved_at || b.updated_date || '').localeCompare(String(a.payload._autosaved_at || a.updated_date || '')));
    if (mine.length) return { source: 'server', draft: mine[0] };
    // Another tab has a bill going: the local copy is that bill, not a lost one.
    if (othersOpen()) return null;
    const loc = readLocal(storageKey);
    if (loc?.payload && Date.now() - (loc.at || 0) < 7 * 86400000) {
      // If the server list was read and the local copy's draft is no longer
      // in it, that bill was saved or discarded: never offer it again. If the
      // list could not be read (server down), the local copy is all we have.
      if (listOk && loc.draft_id && !(drafts || []).some((d) => d.draft_id === loc.draft_id)) { dropLocal(storageKey); return null; }
      const onServer = loc.draft_id && (drafts || []).find((d) => d.draft_id === loc.draft_id);
      if (onServer) return { source: 'server', draft: onServer };
      return { source: 'local', payload: loc.payload, at: loc.at };
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, userId, tabId]);

  return { settled, discard, adopt, isOwned, findRecovery, flush: tick };
}
