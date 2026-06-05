/**
 * WhatsApp OFFICIAL provider — generic Cloud-API.
 * ──────────────────────────────────────────────
 * One code path for BOTH Meta WhatsApp Cloud API direct AND any BSP that
 * exposes a Cloud-API-compatible endpoint. Everything is config-driven:
 *
 *   official_api_base         e.g. https://graph.facebook.com/v21.0 (Meta) or the BSP's base
 *   official_phone_number_id  the sender phone-number id
 *   official_access_token     bearer token
 *   official_template_name    (optional) approved template for business-initiated sends
 *   official_template_lang    template language code (default 'en')
 *
 * Document delivery is a 2-step Cloud-API flow: upload the PDF as media → send
 * a message that references the returned media id. Business-initiated messages
 * (the invoice case — the customer hasn't messaged us in the last 24h) require
 * an approved TEMPLATE with a DOCUMENT header; if a template name is configured
 * we use it, otherwise we fall back to a free-form document message (valid only
 * inside an open 24-hour customer-service window).
 *
 * Uses Node 18+ global fetch / FormData / Blob — no extra dependency.
 */

function base(cfg) {
  return String(cfg.apiBase || 'https://graph.facebook.com/v21.0').replace(/\/+$/, '');
}

async function readError(res) {
  try {
    const j = await res.json();
    return (j && j.error && (j.error.message || j.error.error_data?.details)) || JSON.stringify(j);
  } catch {
    try { return await res.text(); } catch { return `HTTP ${res.status}`; }
  }
}

// Upload the PDF bytes → returns Cloud-API media id.
async function uploadMedia(cfg, buffer, fileName) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'application/pdf');
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), fileName || 'document.pdf');
  const res = await fetch(`${base(cfg)}/${cfg.phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.accessToken}` },
    body: form,
  });
  if (!res.ok) throw new Error(`media upload failed: ${await readError(res)}`);
  const j = await res.json();
  if (!j || !j.id) throw new Error('media upload returned no id');
  return j.id;
}

// Send the document, referencing an uploaded media id. Returns the message id.
async function sendDocument(cfg, toNumber, buffer, fileName, caption) {
  if (!cfg.phoneNumberId || !cfg.accessToken) {
    throw new Error('official provider not configured (phone number id / token missing)');
  }
  const mediaId = await uploadMedia(cfg, buffer, fileName);

  let payload;
  if (cfg.templateName) {
    // Business-initiated: approved template with a DOCUMENT header. The
    // template's body text is fixed at approval time (no variables assumed);
    // the operator designs a simple "your document is attached" utility
    // template with a document header. Caption rides as the document filename.
    payload = {
      messaging_product: 'whatsapp',
      to: toNumber,
      type: 'template',
      template: {
        name: cfg.templateName,
        language: { code: cfg.templateLang || 'en' },
        components: [
          {
            type: 'header',
            parameters: [
              { type: 'document', document: { id: mediaId, filename: fileName || 'document.pdf' } },
            ],
          },
        ],
      },
    };
  } else {
    // Free-form document (valid only inside an open 24h session window).
    payload = {
      messaging_product: 'whatsapp',
      to: toNumber,
      type: 'document',
      document: { id: mediaId, filename: fileName || 'document.pdf', caption: caption || undefined },
    };
  }

  const res = await fetch(`${base(cfg)}/${cfg.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`send failed: ${await readError(res)}`);
  const j = await res.json();
  const id = j && j.messages && j.messages[0] && j.messages[0].id;
  return id || null;
}

// Plain text message — used by the Settings "Test send". Note: business-
// initiated free-form text only delivers inside an open 24h session window;
// outside it Meta returns a clear "template required" error, which is useful
// feedback for the operator testing their setup.
async function sendText(cfg, to, body) {
  if (!isConfigured(cfg)) throw new Error('official provider not configured');
  const res = await fetch(`${base(cfg)}/${cfg.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
  });
  if (!res.ok) throw new Error(`send failed: ${await readError(res)}`);
  const j = await res.json();
  return (j && j.messages && j.messages[0] && j.messages[0].id) || null;
}

// Cheap config validity check for the Settings "Test connection" affordance.
function isConfigured(cfg) {
  return !!(cfg && cfg.phoneNumberId && cfg.accessToken);
}

module.exports = { sendDocument, sendText, uploadMedia, isConfigured };
