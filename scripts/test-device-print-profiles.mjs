import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/services/devicePrintProfiles.js', import.meta.url), 'utf8');
const { createDevicePrintAPI } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const storage = () => {
  const values = new Map();
  return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
};
let profile = { profile_id: 1, name: 'Invoice', printer_name: 'MAIN OLD PRINTER', silent_print: false };
const result = data => ({ data: { data } });
const api = {
  get: async path => result(path === '/print/profiles' ? [profile] : profile),
  put: async (path, data) => {
    assert.ok(!('printer_name' in data));
    assert.ok(!('silent_print' in data));
    profile = { ...profile, ...data };
    return result(profile);
  },
  post: async (path, data) => {
    if (data) {
      assert.ok(!('printer_name' in data));
      assert.ok(!('silent_print' in data));
    }
    return result({ ...profile, ...data, profile_id: 2 });
  },
  delete: async () => result(null),
};
const mainStorage = storage();
let company = 'company-1';
const main = createDevicePrintAPI(api, mainStorage, () => company);
const client = createDevicePrintAPI(api, storage(), () => company);
const printer = async app => (await app.getDefault('sales')).data.data.printer_name;
assert.equal(await printer(main), '');
assert.equal(await printer(client), '');
await main.update(1, { printer_name: 'Main USB', silent_print: false, name: 'Shared layout' });
await client.update(1, { printer_name: 'Client USB', silent_print: true });
assert.equal(await printer(main), 'Main USB');
assert.equal(await printer(client), 'Client USB');
assert.equal((await client.list()).data.data[0].name, 'Shared layout');
assert.equal((await main.getById(1)).data.data.silent_print, false);
assert.equal((await client.getById(1)).data.data.silent_print, true);
assert.equal(await printer(createDevicePrintAPI(api, mainStorage, () => company)), 'Main USB');
await main.update(1, { printer_name: '' });
assert.equal(await printer(main), '');
assert.equal(await printer(client), 'Client USB');
assert.equal((await client.duplicate(1)).data.data.printer_name, 'Client USB');
assert.equal((await main.create({ name: 'New', printer_name: 'New USB', silent_print: false })).data.data.printer_name, 'New USB');
company = 'company-2';
assert.equal(await printer(client), '');
company = 'company-1';
await client.remove(1);
assert.equal(await printer(client), '');
profile = null;
assert.equal((await main.getDefault('sales')).data.data, null);
console.log('Device printer isolation, shared layouts, reload, reset, company scope, create, duplicate, delete and empty defaults passed.');
