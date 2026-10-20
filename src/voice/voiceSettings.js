import { create } from 'zustand';

/*
 * Voice settings are per computer (the speech model and microphone are
 * on this PC), so they live in localStorage, not the shared settings row.
 *
 *   enabled    voice commands on at all
 *   lang       'hi' (Hindi + Hinglish) or 'en-in' (Indian English)
 *   wakeWord   also listen for "Zehen" all the time (hotkey always works)
 *   speakBack  say short confirmations ("Ali selected") out loud
 */
const KEY = 'zehen.voice';
const DEFAULTS = { enabled: false, lang: 'hi', wakeWord: false, speakBack: true };

function read() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}

const useVoiceSettings = create((set, get) => ({
  ...read(),
  // Bumped when a speech model finishes downloading so the voice layer
  // loads it without a restart. Not saved.
  modelRev: 0,
  modelInstalled: () => set({ modelRev: get().modelRev + 1 }),
  update: (patch) => {
    set(patch);
    const { enabled, lang, wakeWord, speakBack } = get();
    try { localStorage.setItem(KEY, JSON.stringify({ enabled, lang, wakeWord, speakBack })); } catch { /* storage off */ }
  },
}));

export default useVoiceSettings;
