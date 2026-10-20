// Run: node --test src/voice/voice.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toLatin, soundKey, numberWords, spokenDigits, tokenize } from './text.js';
import { parseCommand } from './commands.js';
import { findBest } from './match.js';

test('Devanagari becomes Latin', () => {
  assert.equal(toLatin('अली का बिल'), 'ali ka bil');
  assert.equal(toLatin('लेजर'), 'lejar');
  assert.equal(toLatin('१४५२'), '1452');
  assert.equal(soundKey('अली'), soundKey('Ali'));
});

test('spoken numbers become digits', () => {
  assert.deepEqual(numberWords(['make', 'it', 'twenty', 'five']), ['make', 'it', '25']);
  assert.deepEqual(numberWords(['one', 'hundred', 'twenty']), ['120']);
  assert.deepEqual(numberWords(['paanch', 'sau']), ['500']);
  assert.deepEqual(numberWords(tokenize('दस')), ['10']);
  assert.deepEqual(numberWords(tokenize('पच्चीस')), ['25']);
  assert.deepEqual(numberWords(['kar', 'do']), ['kar', 'do']);
});

test('barcode digits as spoken', () => {
  assert.equal(spokenDigits(['eight', 'nine', 'zero', 'one']), '8901');
  assert.equal(spokenDigits(['double', 'five', '3']), '553');
  assert.equal(spokenDigits(tokenize('आठ नौ शून्य एक')), '8901');
  assert.equal(spokenDigits(['890', '123']), '890123');
});

const cases = [
  ['zehen create sales bill for ali', { intent: 'new_sale', party: 'ali' }],
  ['Zehen, create sales bill for Ali', { intent: 'new_sale', party: 'ali' }],
  ['hey zehen new bill for sharma traders', { intent: 'new_sale', party: 'sharma traders' }],
  ['अली का बिल बनाओ', { intent: 'new_sale', party: 'ali' }],
  ['new sale', { intent: 'new_sale', party: null }],
  ['gupta ka purchase bill banao', { intent: 'new_purchase', party: 'gupta' }],
  ['zehen show me the ali ledger', { intent: 'show_ledger', party: 'ali' }],
  ['ali ka statement dikhao', { intent: 'show_ledger', party: 'ali' }],
  ['अली का लेजर दिखाओ', { intent: 'show_ledger', party: 'ali' }],
  ['zehen open that bill', { intent: 'open_bill', billNo: null }],
  ['pichhla bill kholo', { intent: 'open_bill', billNo: null }],
  ['open bill 1452', { intent: 'open_bill', billNo: '1452' }],
  ['bill number fourteen fifty two kholo', { intent: 'open_bill', billNo: '1452' }],
  ['make it 10', { intent: 'set_qty', qty: 10 }],
  ['make it ten', { intent: 'set_qty', qty: 10 }],
  ['quantity das karo', { intent: 'set_qty', qty: 10 }],
  ['quantity do', { intent: 'set_qty', qty: 2 }],
  ['10 kar do', { intent: 'set_qty', qty: 10 }],
  ['क्वांटिटी दस करो', { intent: 'set_qty', qty: 10 }],
  ['add frock 20*20', { intent: 'add_product', query: 'frock 20 x 20', qty: null }],
  ['add frock 20 into 20', { intent: 'add_product', query: 'frock 20 x 20', qty: null }],
  ['add frock 20 into 20 quantity 5', { intent: 'add_product', query: 'frock 20 x 20', qty: 5 }],
  ['add barcode 8 9 0 1 2 3 4', { intent: 'add_barcode', code: '8901234' }],
  ['add this barcode eight nine zero one two', { intent: 'add_barcode', code: '89012' }],
  ['bar code 89012345', { intent: 'add_barcode', code: '89012345' }],
  ['barcode', { intent: 'focus_scan' }],
  ['क्रिएट सेल्स बिल फॉर अली', { intent: 'new_sale', party: 'ali' }],
  ['मेक इट टेन', { intent: 'set_qty', qty: 10 }],
  ['ऐड फ्रॉक ट्वेंटी इनटू ट्वेंटी', { intent: 'add_product', query: 'phrok 20 x 20' }],
  ['ऐड बारकोड आठ नौ शून्य एक दो', { intent: 'add_barcode', code: '89012' }],
  ['ओपन बिल चौदह सौ बावन', { intent: 'open_bill', billNo: '1452' }],
  ['open stock report', { intent: 'navigate', query: 'stock report' }],
  ['zehen', { intent: 'wake' }],
  ['', { intent: 'none' }],
];

for (const [said, want] of cases) {
  test(`"${said}"`, () => {
    const got = parseCommand(said);
    for (const [k, v] of Object.entries(want)) assert.deepEqual(got[k], v, `${k} for "${said}"`);
  });
}

test('wake word required in always-listening mode', () => {
  assert.equal(parseCommand('create sales bill for ali', { requireWake: true }).intent, 'none');
  assert.equal(parseCommand('zehen create sales bill for ali', { requireWake: true }).intent, 'new_sale');
});

test('fuzzy party and product matching', () => {
  const parties = [{ n: 'ALI TRADERS' }, { n: 'Alisha Garments' }, { n: 'Sharma Store' }];
  assert.equal(findBest('ali', parties, (p) => p.n).best.n, 'ALI TRADERS');
  assert.equal(findBest('अली', parties, (p) => p.n).best.n, 'ALI TRADERS');
  assert.equal(findBest('sharma', parties, (p) => p.n).best.n, 'Sharma Store');
  assert.equal(findBest('xyz', parties, (p) => p.n).best, null);

  const products = [{ n: 'FROCK 20*20' }, { n: 'FROCK 20*30' }, { n: 'Frill top' }];
  assert.equal(findBest('frock 20 x 20', products, (p) => p.n).best.n, 'FROCK 20*20');
  assert.equal(findBest('frok 20 x 30', products, (p) => p.n).best.n, 'FROCK 20*30');
  assert.equal(findBest('phrok 20 x 20', products, (p) => p.n).best.n, 'FROCK 20*20');
});

test('Whisper-style punctuation', () => {
  assert.equal(parseCommand("Show me Ali's ledger.").party, 'ali');
  assert.equal(parseCommand('Open bill 1,452.').billNo, '1452');
  assert.equal(parseCommand('Zehen, make it 10.').qty, 10);
  assert.equal(parseCommand('अली का लेजर दिखाओ।').intent, 'show_ledger');
  assert.equal(parseCommand('Add barcode 8901234567.').code, '8901234567');
});

test('Whisper writes English commands in Devanagari under Hindi', () => {
  assert.equal(parseCommand('क्रिएट सेल्स बिल फॉर अली।').party, 'ali');
  assert.equal(parseCommand('मेक इट टेन').qty, 10);
  assert.equal(parseCommand('ऐड बारकोड 8901234567').code, '8901234567');
  assert.equal(parseCommand('कस्टमर्स दिखाओ').intent, 'navigate');
});

test('Whisper English-mode Hinglish', () => {
  assert.deepEqual(parseCommand('Ramesh Ka Bilbanio'), { intent: 'new_sale', party: 'ramesh' });
  assert.equal(parseCommand('Ramesh Ka Bill Baneo').party, 'ramesh');
  assert.equal(parseCommand('Quantity dos carros.').qty, 10);
  assert.equal(parseCommand('Open stock report.').intent, 'navigate');
});
