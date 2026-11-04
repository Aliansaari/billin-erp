import { useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { backTarget, markBack } from '../tabs/backTrail';
import { useTabId } from '../tabs/tabContext';

/**
 * useBack — "close this screen and go up one level".
 *
 * Returns a handler that closes this screen and shows the one it was
 * opened from (src/tabs/backTrail.js); with nothing underneath it moves
 * the operator one step up the menu tree, the same tree the Esc key and
 * every ActionStrip "Back" walk (see
 * src/utils/escBack.js). `fallback` is used when the current route has
 * no parent of its own — normally Home.
 *
 * This used to be navigate(-1), a browser Back. It was changed because
 * replaying the session's history made Esc feel like a stuck rewind
 * button: the destination depended on how you had arrived, repeated
 * presses walked back through screens you had already finished with, and
 * it never reached a top. Going up a fixed tree is predictable, short,
 * and ends at Home. escBack.js carries the full reasoning.
 */
export default function useBack(fallback = '/') {
  const navigate = useNavigate();
  const location = useLocation();
  const tabId = useTabId();
  return useCallback(() => {
    const tgt = backTarget(tabId, location);
    markBack(tabId);
    // `replace` keeps history shallow — going back closes a screen rather
    // than stacking another copy of the one underneath on top of it.
    if (!tgt) { navigate(fallback, { replace: true }); return; }
    navigate({ pathname: tgt.pathname, search: tgt.search, hash: tgt.hash }, { replace: true, state: tgt.state });
  }, [navigate, location, tabId, fallback]);
}
