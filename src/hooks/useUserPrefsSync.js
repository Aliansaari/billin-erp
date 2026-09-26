import { useEffect } from 'react';
import useAuthStore from '../store/authStore';
import useCompanyStore from '../store/companyStore';
import { applyUserPrefs } from '../store/prefSync';

/**
 * Keeps the running app's preferences pointed at whoever is signed in.
 *
 * Mounted once, at the app root. It fires on three things:
 *
 *   - the signed-in user changing (sign-in, sign-out, switching account
 *     on a shared counter PC);
 *   - the company changing, because users live in the company database
 *     and the same user_id means a different person in another company;
 *   - the `zehen:session-changed` event the auth store broadcasts, which
 *     lands before the first authenticated screen paints.
 *
 * applyUserPrefs() does the local swap synchronously and then reconciles
 * against the server, so there is no window where one person's screen is
 * showing another person's layout.
 */
export default function useUserPrefsSync() {
  const userId    = useAuthStore((s) => s.user?.user_id);
  const token     = useAuthStore((s) => s.token);
  const companyId = useCompanyStore((s) => s.currentId);

  useEffect(() => {
    applyUserPrefs();
  }, [userId, token, companyId]);

  useEffect(() => {
    const onSession = () => { applyUserPrefs(); };
    window.addEventListener('zehen:session-changed', onSession);
    return () => window.removeEventListener('zehen:session-changed', onSession);
  }, []);
}
