import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';

/**
 * Renders children into a portal at the end of <body>.
 *
 * Why this exists, and why it is a prerequisite for slide transitions:
 *
 * A `position: fixed` element is positioned relative to the viewport ONLY
 * while no ancestor has a transform. Any non-`none` transform — including one
 * that is mid-animation — makes that ancestor the containing block instead.
 *
 * So the moment a page slides, every full-screen sheet, scrim and PDF viewer
 * nested inside it stops covering the viewport and gets clipped into the page
 * box. That is exactly why the previous slide transition was reverted, and it
 * is not fixable from the animation side: it is what `transform` means.
 *
 * Portalling the overlays out of the animated subtree removes the conflict at
 * the source. Everything that is meant to cover the screen lives beside the
 * page, not inside it, and the page is then free to move.
 *
 * In-page bars (a sticky footer inside a full-height screen) deliberately do
 * NOT belong here — being contained by their page is correct for those.
 */
export default function Overlay({ children, open = true }) {
  const [host, setHost] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    const el = document.createElement('div');
    el.setAttribute('data-zehen-overlay', '');
    document.body.appendChild(el);
    setHost(el);
    return () => {
      setHost(null);
      // Guard: React may have already detached it during a fast unmount.
      if (el.parentNode) el.parentNode.removeChild(el);
    };
  }, [open]);

  if (!open || !host) return null;
  return ReactDOM.createPortal(children, host);
}
