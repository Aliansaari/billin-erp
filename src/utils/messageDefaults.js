import { message } from 'antd';

/*
 * Error toasts stay long enough to read and close on a click.
 *
 * AntD's default is 3 s for every toast, which is too short for an error
 * the operator has to act on ("Failed to save: …"). Errors now stay 8 s
 * unless the call site passes its own duration, and a click on the toast
 * dismisses it straight away. Success / info / warning toasts are untouched.
 *
 * Patched once at startup on the shared `message` object, so every
 * `message.error(...)` in the app picks it up without changing call sites.
 */
const ERROR_SECONDS = 8;
let seq = 0;

export function installMessageDefaults() {
  if (message.__zehenPatched) return;
  const original = message.error.bind(message);
  message.error = (content, duration, onClose) => {
    const isConfig = content && typeof content === 'object' && !Array.isArray(content) && 'content' in content;
    const cfg = isConfig ? { ...content } : { content, onClose };
    if (!isConfig && typeof duration === 'function') cfg.onClose = duration;
    else if (!isConfig && typeof duration === 'number') cfg.duration = duration;
    if (cfg.duration === undefined) cfg.duration = ERROR_SECONDS;
    if (cfg.key === undefined) cfg.key = `zehen-err-${++seq}`;
    const key = cfg.key;
    const click = cfg.onClick;
    cfg.onClick = (e) => { click?.(e); message.destroy(key); };
    return original(cfg);
  };
  message.__zehenPatched = true;
}
