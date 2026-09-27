import React, { useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import { CameraOutlined, UploadOutlined, DeleteOutlined, SwapOutlined } from '@ant-design/icons';
import { photoFromFile, photoFromVideo, initialsOf } from './staffProfile';

/*
 * Staff photo: take it with this computer's camera or upload one. Always
 * saved as a small centre-cropped square (320px + a 96px list thumbnail),
 * so photos never slow the app down. Cameras need a secure page, so on a
 * plain-http LAN browser the camera button hides and upload still works.
 */
export default function PhotoPicker({ name, value, onChange }) {
  const [live, setLive] = useState(false);
  const [err, setErr] = useState(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const fileRef = useRef(null);
  const canCamera = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext !== false;

  const stop = () => { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; setLive(false); };
  useEffect(() => stop, []);

  const start = async () => {
    setErr(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 960 }, height: { ideal: 960 }, facingMode: 'user' }, audio: false });
      streamRef.current = s; setLive(true);
      requestAnimationFrame(() => { if (videoRef.current) { videoRef.current.srcObject = s; videoRef.current.play().catch(() => {}); } });
    } catch (e) {
      setErr(e?.name === 'NotAllowedError' ? 'Camera permission was refused. You can upload a photo instead.' : 'No camera found. You can upload a photo instead.');
    }
  };
  const snap = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    onChange(photoFromVideo(v)); stop();
  };
  const pick = async (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    try { onChange(await photoFromFile(f)); } catch (x) { message.error(x.message); }
  };

  return (
    <div className="pp">
      <div className={`pp-frame${live ? ' is-live' : ''}`}>
        {live ? <video ref={videoRef} muted playsInline className="pp-video" />
          : value?.photo ? <img src={value.photo} alt={`${name || 'Staff'} photo`} />
            : <span className="pp-initials">{String(name || '').trim() ? initialsOf(name) : <CameraOutlined />}</span>}
        {live && <span className="pp-guide" aria-hidden="true" />}
      </div>
      <div className="pp-actions">
        {live ? (<>
          <button type="button" className="plv-btn primary" onClick={snap}><CameraOutlined /> Take photo</button>
          <button type="button" className="plv-btn" onClick={stop}>Cancel</button>
        </>) : (<>
          {canCamera && <button type="button" className="plv-btn" onClick={start}>{value?.photo ? <SwapOutlined /> : <CameraOutlined />} {value?.photo ? 'Retake' : 'Camera'}</button>}
          <button type="button" className="plv-btn" onClick={() => fileRef.current?.click()}><UploadOutlined /> Upload</button>
          {value?.photo && <button type="button" className="plv-btn pp-remove" onClick={() => onChange({ photo: null, thumb: null })} aria-label="Remove photo"><DeleteOutlined /></button>}
        </>)}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={pick} />
      </div>
      <p className="pp-hint">{err || (live ? 'Keep the face inside the circle.' : 'A face photo helps you match check-in selfies and shows across Staff screens.')}</p>
    </div>
  );
}
