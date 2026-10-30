/*
 * A counter that moves whenever ZEHEN saves, changes or deletes business
 * data (any successful POST / PUT / PATCH / DELETE to the API, apart from
 * bookkeeping calls like preferences and sign-in renewal). A list or report
 * tab that was hidden while it moved is redrawn when you return to it, so a
 * bill saved in one tab shows up in the Sales list open in another.
 */
let version = 1;
const IGNORE = /\/(auth|user\/preferences|notifications|telemetry|search|sales-drafts|purchase-drafts|print|whatsapp)(\/|$|\?)/;

export const getDataVersion = () => version;

export function noteResponse(config) {
  const m = String(config?.method || 'get').toLowerCase();
  if (m === 'get' || m === 'head' || m === 'options') return;
  if (IGNORE.test(String(config?.url || ''))) return;
  version += 1;
}
