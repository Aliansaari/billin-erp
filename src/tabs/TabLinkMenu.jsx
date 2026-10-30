import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { ExportOutlined, VerticalLeftOutlined } from '@ant-design/icons';
import { TAB_LINK_SELECTOR, setNewTabIntent } from './tabActions';
import useTabStore, { MAX_TABS } from './tabStore';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl';

/*
 * Right-click on a menu entry (sidebar, top menu, Alt-menu, Home tiles):
 * "Open in new tab". The entry is then clicked with a new-tab intent, so
 * it goes through the same code path as a normal click.
 */
export default function TabLinkMenu() {
  const [menu, setMenu] = useState(null);   // { x, y, el }
  const boxRef = useRef(null);

  useEffect(() => {
    const onCtx = (e) => {
      const el = e.target.closest?.(TAB_LINK_SELECTOR);
      if (!el) return;
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, el });
    };
    window.addEventListener('contextmenu', onCtx, true);
    return () => window.removeEventListener('contextmenu', onCtx, true);
  }, []);

  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const onDown = (e) => { if (!boxRef.current?.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); } };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  // Keep the menu inside the window.
  useEffect(() => {
    const box = boxRef.current;
    if (!menu || !box) return;
    const r = box.getBoundingClientRect();
    const zoom = parseFloat(document.documentElement.style.zoom) || 1;
    const maxX = window.innerWidth / zoom - r.width - 8;
    const maxY = window.innerHeight / zoom - r.height - 8;
    box.style.left = `${Math.min(menu.x, maxX)}px`;
    box.style.top = `${Math.min(menu.y, maxY)}px`;
  }, [menu]);

  if (!menu) return null;
  const full = useTabStore.getState().tabs.length >= MAX_TABS;
  const go = (foreground) => {
    const { el } = menu;
    setMenu(null);
    setNewTabIntent(foreground);
    el.click();
  };
  return ReactDOM.createPortal(
    <div ref={boxRef} className="ztab-ctx" style={{ left: menu.x, top: menu.y }} role="menu">
      <button type="button" role="menuitem" disabled={full} onClick={() => go(true)}>
        <ExportOutlined /><span>Open in new tab</span><kbd>{MOD}+Shift+Click</kbd>
      </button>
      <button type="button" role="menuitem" disabled={full} onClick={() => go(false)}>
        <VerticalLeftOutlined /><span>Open in background tab</span><kbd>{MOD}+Click</kbd>
      </button>
      {full && <div className="ztab-ctx-note">{MAX_TABS} tabs are open. Close one first.</div>}
    </div>,
    document.body,
  );
}
