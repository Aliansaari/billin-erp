// Printer routing belongs to this device, never to the shared company DB.
export const DEVICE_PRINT_KEY = 'zehen_device_print_profiles';

export function createDevicePrintAPI(api, storage, scope) {
  const read = () => {
    try {
      const value = JSON.parse(storage.getItem(DEVICE_PRINT_KEY) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  };
  const key = (context, id) => JSON.stringify([context, String(id)]);
  const localize = (profile, context) => {
    if (!profile) return profile;
    const local = read()[key(context, profile.profile_id)];
    return {
      ...profile,
      // Never migrate the old shared name: it may belong to another PC.
      printer_name: typeof local?.printer_name === 'string' ? local.printer_name : '',
      silent_print: typeof local?.silent_print === 'boolean' ? local.silent_print : true,
    };
  };
  const save = (id, data, context) => {
    const values = read();
    const entry = { ...values[key(context, id)] };
    if ('printer_name' in data) entry.printer_name = data.printer_name || '';
    if ('silent_print' in data) entry.silent_print = !!data.silent_print;
    values[key(context, id)] = entry;
    // Propagate storage failures so the UI cannot falsely report a saved choice.
    storage.setItem(DEVICE_PRINT_KEY, JSON.stringify(values));
  };
  const response = (result, context) => ({
    ...result,
    data: { ...result.data, data: Array.isArray(result.data.data)
      ? result.data.data.map(p => localize(p, context))
      : localize(result.data.data, context) },
  });
  const get = async (path, options) => {
    const context = scope();
    return response(await api.get(path, options), context);
  };
  const write = async (id, data) => {
    const context = scope();
    const { printer_name, silent_print, ...shared } = data;
    const result = id == null
      ? await api.post('/print/profiles', shared)
      : await api.put(`/print/profiles/${id}`, shared);
    save(result.data.data.profile_id, data, context);
    return response(result, context);
  };
  return {
    list: (params = {}) => get('/print/profiles', { params }),
    getById: id => get(`/print/profiles/${id}`),
    getDefault: docType => get(`/print/profiles/default/${docType}`),
    create: data => write(null, data),
    update: (id, data) => write(id, data),
    remove: async id => {
      const context = scope();
      const result = await api.delete(`/print/profiles/${id}`);
      const values = read();
      delete values[key(context, id)];
      storage.setItem(DEVICE_PRINT_KEY, JSON.stringify(values));
      return result;
    },
    duplicate: async id => {
      const context = scope();
      const original = localize({ profile_id: id }, context);
      const result = await api.post(`/print/profiles/${id}/duplicate`);
      save(result.data.data.profile_id, original, context);
      return response(result, context);
    },
  };
}
