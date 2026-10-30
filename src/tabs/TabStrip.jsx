import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Dropdown, Tooltip } from 'antd';
import { CloseOutlined, PlusOutlined } from '@ant-design/icons';
import useTabStore, { MAX_TABS } from './tabStore';
import { tabMeta } from './tabMeta';
import { useNavGuard } from '../hooks/useUnsavedChangesWarning';
import {
  switchTo, requestClose, closeMany, newTab, reopenClosed, duplicateTab,
} from './tabActions';
import './tabs.css';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl';

/*
 * The tab strip. Shown only while two or more tabs are open, so with one
 * screen ZEHEN looks exactly as it always has.
 *
 * Each tab wears its sidebar section's colour and icon, names what is in
 * it ("Sale · ASHIYA DRESSES"), shows a dot while it holds unsaved work and
 * never takes keyboard focus from the screen (mouse-down is swallowed), so
 * clicking a tab puts the cursor back where you left it.
 */
export default function TabStrip() {
  const tabs = useTabStore((s) => s.tabs);
  const activeId = useTabStore((s) => s.activeId);
  const flash = useTabStore((s) => s.flash);
  const closedCount = useTabStore((s) => s.closed.length);
  const guards = useNavGuard((s) => s.guards);
  const listRef = useRef(null);
  const [drag, setDrag] = useState(null);     // { id, over }
  const [edges, setEdges] = useState({ l: false, r: false });
  const [menuId, setMenuId] = useState(null);  // tab whose right-click menu is open

  // Esc closes the tab menu (antd's context-menu dropdown ignores it).
  useEffect(() => {
    if (!menuId) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopImmediatePropagation();
      setMenuId(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [menuId]);

  // Keep the active tab in view, and show fades where the row is cut off.
  const measure = () => {
    const el = listRef.current;
    if (!el) return;
    const l = el.scrollLeft > 2;
    const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdges((p) => (p.l === l && p.r === r ? p : { l, r }));
  };
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.querySelector('.ztab.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    measure();
  }, [activeId, tabs.length]);
  const many = tabs.length >= 2;
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [many]);

  useEffect(() => {
    if (!flash) return undefined;
    const t = setTimeout(() => useTabStore.getState().clearFlash(), 1400);
    return () => clearTimeout(t);
  }, [flash]);

  if (tabs.length < 2) return null;

  const menuFor = (t, i) => ({
    items: [
      { key: 'new', label: <MenuLabel text="New tab" keys={`${MOD}+T`} /> },
      { key: 'dup', label: 'Duplicate tab' },
      { key: 'reload', label: 'Reload screen', disabled: !!guards[t.id]?.dirty },
      { type: 'divider' },
      { key: 'close', label: <MenuLabel text="Close tab" keys={`${MOD}+W`} /> },
      { key: 'others', label: 'Close other tabs', disabled: tabs.length < 2 },
      { key: 'right', label: 'Close tabs to the right', disabled: i === tabs.length - 1 },
      { type: 'divider' },
      { key: 'reopen', label: <MenuLabel text="Reopen closed tab" keys={`${MOD}+Shift+T`} />, disabled: !closedCount },
    ],
    onClick: ({ key }) => {
      setMenuId(null);
      if (key === 'new') newTab();
      else if (key === 'dup') duplicateTab(t.id);
      else if (key === 'reload') useTabStore.getState().remount(t.id);
      else if (key === 'close') requestClose(t.id);
      else if (key === 'others') closeMany(tabs.filter((x) => x.id !== t.id).map((x) => x.id));
      else if (key === 'right') closeMany(tabs.slice(i + 1).map((x) => x.id));
      else if (key === 'reopen') reopenClosed();
    },
  });

  const onDrop = (e) => {
    e.preventDefault();
    if (drag?.over != null) useTabStore.getState().move(drag.id, drag.over);
    setDrag(null);
  };

  return (
    <>
      <div className="ztabbar" role="tablist" aria-label="Open screens"
           onDoubleClick={(e) => { if (e.target === e.currentTarget || e.target === listRef.current) newTab(); }}>
        <div
          ref={listRef}
          className={`ztab-list${edges.l ? ' fade-l' : ''}${edges.r ? ' fade-r' : ''}`}
          onScroll={measure}
          onWheel={(e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) listRef.current.scrollLeft += e.deltaY; }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
        >
          {tabs.map((t, i) => {
            const m = tabMeta(t);
            const active = t.id === activeId;
            const dirty = !!guards[t.id]?.dirty;
            const num = i < 8 ? i + 1 : (i === tabs.length - 1 ? 9 : null);
            const name = m.detail ? `${m.title} · ${m.detail}` : m.title;
            return (
              <Dropdown
                key={t.id} trigger={['contextMenu']} menu={menuFor(t, i)} classNames={{ root: 'ztab-menu' }}
                open={menuId === t.id} onOpenChange={(o) => setMenuId(o ? t.id : null)}
              >
                <Tooltip
                  title={<TipBody name={name} num={num} dirty={dirty} sleeping={t.sleeping} />}
                  mouseEnterDelay={0.7} placement="bottom" classNames={{ root: 'ztab-tip' }} destroyOnHidden
                  open={menuId || drag ? false : undefined}
                >
                  <div
                    role="tab"
                    aria-selected={active}
                    className={[
                      'ztab', `tint-${m.tint}`,
                      active && 'is-active', dirty && 'is-dirty', t.sleeping && 'is-sleeping',
                      flash === t.id && 'is-flash',
                      drag?.id === t.id && 'is-dragging',
                      drag && drag.over === i && drag.id !== t.id && 'is-drop',
                    ].filter(Boolean).join(' ')}
                    draggable
                    onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id); setDrag({ id: t.id, over: i }); }}
                    onDragEnter={() => drag && setDrag({ ...drag, over: i })}
                    onDragEnd={() => setDrag(null)}
                    onMouseDown={(e) => {
                      // Never take focus from the screen; middle button closes.
                      e.preventDefault();
                      if (e.button === 1) requestClose(t.id);
                    }}
                    onClick={() => switchTo(t.id)}
                  >
                    <span className="ztab-ic">{m.icon}</span>
                    <span className="ztab-text">
                      <span className="ztab-title">{m.title}</span>
                      {m.detail && <span className="ztab-detail">{m.detail}</span>}
                    </span>
                    <span className="ztab-end">
                      {dirty && <span className="ztab-dot" aria-label="Unsaved changes" />}
                      <button
                        type="button" tabIndex={-1} className="ztab-x" aria-label={`Close ${name}`}
                        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                        onClick={(e) => { e.stopPropagation(); requestClose(t.id); }}
                      >
                        <CloseOutlined />
                      </button>
                    </span>
                  </div>
                </Tooltip>
              </Dropdown>
            );
          })}
        </div>
        <Tooltip title={<MenuLabel text="New tab" keys={`${MOD}+T`} />} placement="bottom" mouseEnterDelay={0.4} classNames={{ root: 'ztab-tip' }}>
          <button
            type="button" tabIndex={-1} className="ztab-new" aria-label="New tab"
            disabled={tabs.length >= MAX_TABS}
            onMouseDown={(e) => e.preventDefault()}
            onClick={newTab}
          >
            <PlusOutlined />
          </button>
        </Tooltip>
      </div>
    </>
  );
}

function MenuLabel({ text, keys }) {
  return <span className="ztab-menu-row"><span>{text}</span><kbd>{keys}</kbd></span>;
}

function TipBody({ name, num, dirty, sleeping }) {
  return (
    <div className="ztab-tipbody">
      <div className="ztab-tipname">{name}</div>
      {dirty && <div className="ztab-tipnote is-dirty">Unsaved changes</div>}
      {sleeping && !dirty && <div className="ztab-tipnote">Resting. Opens fresh when you click it.</div>}
      {num && (
        <div className="ztab-tipfoot">
          <span>Switch to this tab</span>
          <kbd>{MOD}+{num}</kbd>
        </div>
      )}
    </div>
  );
}
