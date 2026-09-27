/*
 * Staff profile helpers shared by the staff form, lists and payroll:
 * Aadhaar / PAN checks (the server repeats them), masking, and turning a
 * camera frame or an uploaded picture into a small square JPEG.
 */

// Verhoeff checksum — every genuine Aadhaar number passes; typos almost never do.
const VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];

export const aadhaarDigits = (v) => String(v || '').replace(/\D/g, '').slice(0, 12);
export function aadhaarValid(v) {
  const n = aadhaarDigits(v);
  if (!/^[2-9]\d{11}$/.test(n)) return false;
  let c = 0;
  const d = n.split('').reverse().map(Number);
  for (let i = 0; i < d.length; i++) c = VD[c][VP[i % 8][d[i]]];
  return c === 0;
}
/** "2345 6789 0124" while typing. */
export const formatAadhaar = (v) => aadhaarDigits(v).replace(/(\d{4})(?=\d)/g, '$1 ');
/** "XXXX XXXX 0124" for lists. */
export const maskAadhaar = (last4) => (last4 ? `XXXX XXXX ${last4}` : '');

export const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
export const cleanPan = (v) => String(v || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 10);
/** Shape feedback while typing: 5 letters, 4 digits, 1 letter. */
export function panHint(v) {
  const p = cleanPan(v);
  if (!p) return null;
  if (PAN_RE.test(p)) return { ok: true, text: 'Valid PAN format' };
  if (!/^[A-Z]{0,5}$/.test(p.slice(0, 5))) return { ok: false, text: 'The first 5 characters are letters' };
  if (p.length > 5 && !/^\d{0,4}$/.test(p.slice(5, 9))) return { ok: false, text: 'Characters 6 to 9 are digits' };
  if (p.length === 10 && !/[A-Z]$/.test(p)) return { ok: false, text: 'The last character is a letter' };
  return { ok: null, text: `${10 - p.length} more to go` };
}

/**
 * Draw any image source centre-cropped into a square JPEG data URL.
 * `mirror` flips webcam frames so the saved photo reads like a mirror, as people expect.
 */
export function squareJpeg(source, srcW, srcH, size, { mirror = false, quality = 0.85 } = {}) {
  const side = Math.min(srcW, srcH);
  const sx = (srcW - side) / 2; const sy = (srcH - side) / 2;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  if (mirror) { g.translate(size, 0); g.scale(-1, 1); }
  g.drawImage(source, sx, sy, side, side, 0, 0, size, size);
  return c.toDataURL('image/jpeg', quality);
}

/** A File from an <input type=file> → { photo (320px), thumb (96px) }. */
export function photoFromFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) { reject(new Error('Choose a photo (JPG or PNG).')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        resolve({ photo: squareJpeg(img, img.naturalWidth, img.naturalHeight, 320), thumb: squareJpeg(img, img.naturalWidth, img.naturalHeight, 96, { quality: 0.8 }) });
      } catch (e) { reject(e); } finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file could not be opened as a photo.')); };
    img.src = url;
  });
}

/** A playing <video> element (webcam) → { photo, thumb }. */
export function photoFromVideo(video) {
  const w = video.videoWidth; const h = video.videoHeight;
  return { photo: squareJpeg(video, w, h, 320, { mirror: true }), thumb: squareJpeg(video, w, h, 96, { mirror: true, quality: 0.8 }) };
}

export const initialsOf = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
