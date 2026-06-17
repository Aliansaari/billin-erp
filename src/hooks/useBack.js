import { useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

/**
 * useBack — natural, history-aware "Back".
 *
 * Returns a handler that sends the user back to the exact screen they
 * came from (the previous in-app history entry), falling back to
 * `fallback` ONLY when there's no in-app history to return to — i.e. the
 * page was reached by a deep link, a hard refresh, or it's the very
 * first screen of the session.
 *
 * Why not just hardcode `navigate('/reports')` (or any one path)? Because
 * a user almost never arrives at a page from a single fixed place. They
 * open a report from Home, the dashboard, a sidebar favourite, global
 * search, or by drilling in from another report. Hardcoding one
 * destination means "Back" dumps them somewhere they were never at —
 * which is exactly the confusing, "it doesn't bring me back where I left"
 * behaviour we're fixing. navigate(-1) returns them to the screen they
 * actually left, like every browser / OS back button does.
 *
 * History detection uses React Router's location.key rather than
 * window.history.state.idx: idx can be wiped under Electron's webview,
 * whereas location.key is kept in memory by the router and is always
 * accurate. It's the literal string 'default' only for the first entry
 * of the session; any other value means at least one in-app navigation
 * has happened, so there's a real previous entry to return to.
 */
export default function useBack(fallback = '/') {
  const navigate = useNavigate();
  const { key } = useLocation();
  return useCallback(() => {
    if (key !== 'default') navigate(-1);
    else navigate(fallback, { replace: true });
  }, [navigate, key, fallback]);
}
