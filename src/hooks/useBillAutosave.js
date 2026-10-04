import { useCallback, useEffect, useRef } from 'react';

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

const readLocal = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
const writeLocal = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* full or blocked */ } };
const dropLocal = (key) => { try { localStorage.removeItem(key); } catch { /* blocked */ } };

export default function useBillAutosave({ enabled, dirty, buildPayload, draftApi, recalledDraftId, setRecalledDraftId, storageKey, userId }) {
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
    if (!enabled) return undefined;
    const t = setInterval(tick, EVERY_MS);
    const flush = () => { tick(); };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', flush);
    return () => { clearInterval(t); window.removeEventListener('beforeunload', flush); document.removeEventListener('visibilitychange', flush); };
  }, [enabled, tick]);

  /** The bill was saved (its draft is already deleted server-side) or held. */
  const settled = useCallback(() => {
    gen.current += 1;
    ownedId.current = null; lastJson.current = '';
    dropLocal(storageKey);
  }, [storageKey]);

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
    const mine = (drafts || [])
      .filter((d) => d.payload?._autosave && (!userId || d.created_by == null || d.created_by === userId))
      .sort((a, b) => String(b.payload._autosaved_at || b.updated_date || '').localeCompare(String(a.payload._autosaved_at || a.updated_date || '')));
    if (mine.length) return { source: 'server', draft: mine[0] };
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
  }, [storageKey, userId]);

  return { settled, discard, adopt, isOwned, findRecovery, flush: tick };
}
