import React from 'react';
import { StarFilled, StarOutlined } from '@ant-design/icons';
import { message } from 'antd';
import useFavoritesStore from '../store/favoritesStore';

/*
 * FavoriteStar — toggle button for pinning a report.
 *
 *   <FavoriteStar reportId="profit_loss" />
 *
 * Reads from the favorites store; toggling fires an optimistic
 * mutation. Empty-bordered when not pinned; filled amber (#EF9F27)
 * when pinned — matches the spec's color choice and the existing
 * "warning" tone used elsewhere in the app for the default-godown
 * star + draft chips.
 *
 * Click handling stops propagation so a star sitting inside a
 * clickable row doesn't trigger the row's onClick (otherwise pinning
 * a report would also navigate to it — annoying for the operator
 * who's curating their dropdown).
 *
 * Failures show a toast; the store handles the visual revert.
 */
export default function FavoriteStar({ reportId, size = 18, style }) {
  const has    = useFavoritesStore((s) => s.has(reportId));
  const toggle = useFavoritesStore((s) => s.toggle);

  const onClick = async (e) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await toggle(reportId);
    } catch (err) {
      message.error(err?.response?.data?.error || "Couldn't save favorite");
    }
  };

  const Icon = has ? StarFilled : StarOutlined;
  return (
    <Icon
      onClick={onClick}
      style={{
        fontSize: size,
        cursor: 'pointer',
        color: has ? '#EF9F27' : 'var(--fg-tertiary, #9ca3af)',
        transition: 'color .15s, transform .1s',
        ...style,
      }}
      aria-label={has ? `Unpin ${reportId}` : `Pin ${reportId}`}
      title={has ? 'Unpin from quick access' : 'Pin to quick access'}
    />
  );
}
