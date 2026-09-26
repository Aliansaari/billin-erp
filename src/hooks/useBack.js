import { useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { resolveBack } from '../utils/escBack';

/**
 * useBack — "close this screen and go up one level".
 *
 * Returns a handler that moves the operator one step up the menu tree,
 * the same tree the Esc key and every ActionStrip "Back" walk (see
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
  const { pathname } = useLocation();
  return useCallback(() => {
    const up = resolveBack(pathname);
    // `replace` keeps history shallow — going up closes a screen rather
    // than stacking another copy of the parent on top of it.
    navigate(up === pathname ? fallback : up, { replace: true });
  }, [navigate, pathname, fallback]);
}
