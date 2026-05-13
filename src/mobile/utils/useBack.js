import { useNavigate, useLocation } from 'react-router-dom';

/**
 * Returns a back-navigation handler safe for Capacitor iOS.
 *
 * window.history.state?.idx is unreliable in WKWebView — it gets wiped when
 * the app is backgrounded. React Router's location.key is kept in-memory by
 * the router itself and is always accurate.  key === 'default' only on the
 * very first entry (app launch), so anything else means there is history.
 */
export function useBack(fallback = '/') {
  const navigate = useNavigate();
  const { key } = useLocation();
  return () => {
    if (key !== 'default') {
      navigate(-1);
    } else {
      navigate(fallback, { replace: true });
    }
  };
}
