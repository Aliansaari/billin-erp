const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'file://' + path.resolve(__dirname, '..', 'index.html');
const OUT = __dirname;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('requestfailed', r => { const u = r.url(); if (!u.startsWith('data:')) errors.push('REQFAIL: ' + u.split('?')[0] + ' — ' + (r.failure()?.errorText || '')); });

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---- desktop ----
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.4 });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await sleep(900);

  const shotViewport = async (name) => { await page.screenshot({ path: path.join(OUT, name + '.png') }); };
  const toSection = async (sel) => {
    await page.evaluate(s => { const el = document.querySelector(s); if (el) el.scrollIntoView({ block: 'center' }); else scrollTo(0, 0); }, sel);
    await sleep(1300);
  };

  await page.evaluate(() => scrollTo(0, 0)); await sleep(700);
  await shotViewport('01-hero');

  await toSection('#billing'); await sleep(900); await shotViewport('02-billing');
  await toSection('#search'); await sleep(1600); await shotViewport('03-search');
  await toSection('#whatsapp'); await sleep(1800); await shotViewport('04-whatsapp');
  await toSection('#mobile'); await shotViewport('05-mobile');
  await toSection('#features'); await shotViewport('06-features');
  await page.evaluate(() => document.querySelector('.comp').scrollIntoView({ block: 'center' })); await sleep(1200); await shotViewport('07-compare');
  await toSection('#pricing'); await shotViewport('08-pricing');
  await page.evaluate(() => document.querySelector('#download').scrollIntoView({ block: 'center' })); await sleep(1000); await shotViewport('09-mega');

  // full-page (capped)
  const h = await page.evaluate(() => document.body.scrollHeight);
  console.log('PAGE HEIGHT: ' + h + 'px');

  // ---- mobile ----
  const mob = await browser.newPage();
  mob.on('pageerror', e => errors.push('M-PAGEERROR: ' + e.message));
  await mob.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
  await mob.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await mob.evaluate(() => document.fonts && document.fonts.ready);
  await sleep(700);
  await mob.screenshot({ path: path.join(OUT, '10-hero-mobile.png') });
  await mob.evaluate(() => document.querySelector('#whatsapp').scrollIntoView({ block: 'start' })); await sleep(1600);
  await mob.screenshot({ path: path.join(OUT, '11-whatsapp-mobile.png') });
  await mob.evaluate(() => document.querySelector('#pricing').scrollIntoView({ block: 'start' })); await sleep(900);
  await mob.screenshot({ path: path.join(OUT, '12-pricing-mobile.png') });

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'errors.txt'), errors.length ? errors.join('\n') : 'NONE');
  console.log('ERRORS: ' + (errors.length ? '\n' + errors.join('\n') : 'NONE'));
  console.log('DONE');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
