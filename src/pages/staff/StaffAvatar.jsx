import React from 'react';
import { initialsOf } from './staffProfile';

/**
 * Staff photo if there is one, initials otherwise. Same circle and ring as
 * the Customers list avatar (plv-avatar), so the Staff screens match.
 */
export default function StaffAvatar({ name, photo, size = 30, className = '' }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  if (photo) return <img src={photo} alt="" className={`plv-avatar ar-av st-av-photo ${className}`} style={style} draggable={false} />;
  return <span className={`plv-avatar ar-av ${className}`} style={style}>{initialsOf(name)}</span>;
}
