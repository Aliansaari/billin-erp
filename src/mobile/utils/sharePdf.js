// Shared PDF share utility — used by report pages (SalesReport, PurchaseReport,
// MonthlySummary, DayBook). Handles Capacitor native, Web Share API, and download.

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export async function shareViaNative(blob, fileName, title, text = '') {
  const cap = window.Capacitor;
  const isNative = cap?.isNativePlatform?.();

  if (isNative && cap.nativePromise) {
    try {
      const base64 = await blobToBase64(blob);
      const saved = await cap.nativePromise('Filesystem', 'writeFile', {
        path: fileName, data: base64, directory: 'CACHE',
      });
      await cap.nativePromise('Share', 'share', { title, text, url: saved.uri, dialogTitle: title });
      return true;
    } catch (e) {
      if (e?.message?.includes('cancel')) return true;
    }
  }

  if (isNative) {
    try {
      const [{ Filesystem, Directory }, { Share }] = await Promise.all([
        import('@capacitor/filesystem'),
        import('@capacitor/share'),
      ]);
      const base64 = await blobToBase64(blob);
      const saved = await Filesystem.writeFile({ path: fileName, data: base64, directory: Directory.Cache });
      await Share.share({ title, text, url: saved.uri, dialogTitle: title });
      return true;
    } catch (e) {
      if (e?.message?.includes('cancel')) return true;
    }
  }

  try {
    const file = new File([blob], fileName, { type: 'application/pdf' });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ title, text, files: [file] });
      return true;
    }
  } catch (e) {
    if (e?.name === 'AbortError') return true;
  }

  // Fallback: trigger browser download
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return true;
}
