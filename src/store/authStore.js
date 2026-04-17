import { create } from 'zustand';

// `must_change_password` is set by the server when the user is logging in with
// a well-known default password (e.g. the seeded admin/admin123). The UI uses
// this flag to force a change-password redirect before any other route is
// reachable — we treat shipping with a default password as a hard failure
// for production readiness.
const readFlag = () => localStorage.getItem('must_change_password') === '1';

const useAuthStore = create((set) => ({
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  token: localStorage.getItem('token') || null,
  isAuthenticated: !!localStorage.getItem('token'),
  mustChangePassword: readFlag(),

  login: (user, token, mustChangePassword = false) => {
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('token', token);
    if (mustChangePassword) localStorage.setItem('must_change_password', '1');
    else localStorage.removeItem('must_change_password');
    set({ user, token, isAuthenticated: true, mustChangePassword: !!mustChangePassword });
  },

  // Cleared once the user successfully rotates their password.
  clearMustChangePassword: () => {
    localStorage.removeItem('must_change_password');
    set({ mustChangePassword: false });
  },

  logout: () => {
    localStorage.removeItem('user');
    localStorage.removeItem('token');
    localStorage.removeItem('must_change_password');
    set({ user: null, token: null, isAuthenticated: false, mustChangePassword: false });
  },

  updateUser: (user) => {
    localStorage.setItem('user', JSON.stringify(user));
    set({ user });
  },
}));

export default useAuthStore;
