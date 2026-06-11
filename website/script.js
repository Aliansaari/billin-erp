/* ===================================================================
   ZEHEN — site interactions
   Custom cursor · magnetic CTAs · 3D tilt · scroll cinematic
   keyboard interactive · speed race · reveal · nav hide
   =================================================================== */
(() => {
'use strict';

const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
const lerp = (a, b, t) => a + (b - a) * t;
const fmt = (n) => '₹ ' + Math.round(n).toLocaleString('en-IN');
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

document.addEventListener('DOMContentLoaded', () => {
  setupCursor();
  setupReveal();
  setupMagnetic();
  setupHeroTilt();
  setupTiltCards();
  setupCinematic();
  setupTiles();
  setupKeyboard();
  setupSpeedRace();
  setupNavHide();
  setupYear();
});

/* ---------- custom cursor ---------- */
function setupCursor() {
  if (reduced) return;
  const c   = $('.cursor');
  const dot = $('.cursor__dot');
  const ring = $('.cursor__ring');
  if (!c) return;
  let mx = window.innerWidth/2, my = window.innerHeight/2;
  let dx = mx, dy = my, rx = mx, ry = my;

  document.addEventListener('mousemove', (e) => {
    mx = e.clientX; my = e.clientY;
  }, { passive: true });

  const tick = () => {
    dx = lerp(dx, mx, 0.6); dy = lerp(dy, my, 0.6);
    rx = lerp(rx, mx, 0.18); ry = lerp(ry, my, 0.18);
    dot.style.transform  = `translate(${dx}px, ${dy}px)`;
    ring.style.transform = `translate(${rx}px, ${ry}px)`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const hovers = $$('a, button, [data-cursor="hover"], .kd, .prod, .dl, .tcard, .plan, .pcard, .tile, .rep__card, summary');
  hovers.forEach(el => {
    el.addEventListener('mouseenter', () => c.classList.add('is-hover'));
    el.addEventListener('mouseleave', () => c.classList.remove('is-hover'));
  });
}

/* ---------- reveal-on-scroll ---------- */
function setupReveal() {
  const els = $$('.reveal');
  if (!('IntersectionObserver' in window)) { els.forEach(e => e.classList.add('in')); return; }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e, i) => {
      if (e.isIntersecting) {
        setTimeout(() => e.target.classList.add('in'), i * 60);
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -8% 0px' });
  els.forEach(e => io.observe(e));
}

/* ---------- magnetic buttons ---------- */
function setupMagnetic() {
  if (reduced) return;
  $$('.magnetic').forEach(el => {
    el.addEventListener('mousemove', (e) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width/2;
      const cy = r.top  + r.height/2;
      const dx = (e.clientX - cx) * 0.25;
      const dy = (e.clientY - cy) * 0.25;
      el.style.transform = `translate(${dx}px, ${dy}px)`;
    });
    el.addEventListener('mouseleave', () => {
      el.style.transform = '';
    });
  });
}

/* ---------- hero 3D tilt ---------- */
function setupHeroTilt() {
  if (reduced) return;
  const wrap = $('#heroStage');
  const stage = $('#stage');
  if (!wrap || !stage) return;
  let raf = 0, tx = 0, ty = 0, cx = 0, cy = 0;

  wrap.addEventListener('mousemove', (e) => {
    const r = wrap.getBoundingClientRect();
    cx = ((e.clientX - r.left) / r.width  - 0.5) * 2;
    cy = ((e.clientY - r.top)  / r.height - 0.5) * 2;
    if (!raf) raf = requestAnimationFrame(apply);
  });
  wrap.addEventListener('mouseleave', () => { cx = 0; cy = 0; if (!raf) raf = requestAnimationFrame(apply); });

  function apply() {
    raf = 0;
    tx = lerp(tx, cx, 1);
    ty = lerp(ty, cy, 1);
    stage.style.setProperty('--ry', `${tx * 6}deg`);
    stage.style.setProperty('--rx', `${14 - ty * 6}deg`);
  }

  // scroll-based fade
  window.addEventListener('scroll', () => {
    const y = Math.min(window.scrollY, 800) / 800;
    stage.style.opacity = String(1 - y * 0.5);
    stage.style.setProperty('--rx', `${14 - y * 14}deg`);
  }, { passive: true });
}

/* ---------- tilt cards (testi, plans, pcards) ---------- */
function setupTiltCards() {
  if (reduced) return;
  $$('[data-tilt]').forEach(card => {
    card.addEventListener('mousemove', (e) => {
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width  - 0.5;
      const y = (e.clientY - r.top)  / r.height - 0.5;
      card.style.transform = `perspective(900px) rotateX(${-y*6}deg) rotateY(${x*8}deg) translateY(-4px)`;
    });
    card.addEventListener('mouseleave', () => {
      card.style.transform = '';
    });
  });
  // cursor-track glow for tiles
  $$('.tile').forEach(el => {
    el.addEventListener('mousemove', (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  });
}

/* ---------- KPI count-ups in hero ---------- */
function animateHeroCounters() {
  $$('[data-counter]').forEach(el => {
    if (el.dataset.done) return;
    const target = parseFloat(el.dataset.counter);
    const dur = 1800;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min((now - start) / dur, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const val = Math.round(target * eased);
      el.textContent = val.toLocaleString('en-IN');
      if (t < 1) requestAnimationFrame(tick);
      else el.dataset.done = '1';
    };
    requestAnimationFrame(tick);
  });
}
// run shortly after load
setTimeout(animateHeroCounters, 600);

/* ===================================================================
   Cinematic bill assembly
   - 4 scrollable steps drive the bill mockup
   =================================================================== */
function setupCinematic() {
  const steps = $$('.cin__step');
  if (!steps.length) return;

  const custEl = $('#cinCustomer');
  const bcEl   = $('#cinBarcode');
  const beamEl = $('#cinBeam');
  const itemsEl = $('#cinItems');
  const subEl = $('#cinSub'), cgstEl = $('#cinCgst'), sgstEl = $('#cinSgst'), totEl = $('#cinTot');
  const payEl = $('#cinPay');
  const saveEl = $('#cinSave');
  const doneEl = $('#cinDone');
  const timeEl = $('#cinDoneTime');

  const CATALOG = [
    { name: 'Cotton Shirt · L',    hsn: '6109', rate: 540,  qty: 2, code: 'PRD-00214' },
    { name: 'Linen Trouser · 34',  hsn: '6204', rate: 1200, qty: 1, code: 'PRD-00518' },
    { name: 'Silk Saree · Premium',hsn: '5407', rate: 4200, qty: 1, code: 'PRD-00912' },
    { name: 'Denim Jeans · 32',    hsn: '6203', rate: 1480, qty: 2, code: 'PRD-01402' },
  ];

  let current = -1;

  function reset() {
    current = -1;
    custEl.innerHTML = '<span class="cb__placeholder">Search by name or mobile…</span>';
    bcEl.innerHTML = '<span class="cb__placeholder">Scan…</span>';
    itemsEl.innerHTML = '';
    subEl.textContent = cgstEl.textContent = sgstEl.textContent = totEl.textContent = '₹ 0';
    payEl.classList.remove('active');
    saveEl.classList.remove('flash');
    doneEl.classList.remove('active');
  }

  function recalc() {
    const items = $$('.cb__tr', itemsEl);
    let sub = 0;
    items.forEach(r => sub += parseFloat(r.dataset.amt || 0));
    const cgst = sub * 0.025, sgst = sub * 0.025;
    subEl.textContent  = fmt(sub);
    cgstEl.textContent = fmt(cgst);
    sgstEl.textContent = fmt(sgst);
    totEl.textContent  = fmt(sub + cgst + sgst);
  }

  function addItem(idx) {
    const it = CATALOG[idx];
    if (!it) return;
    const amt = it.rate * it.qty;
    const row = document.createElement('div');
    row.className = 'cb__tr';
    row.dataset.amt = amt;
    row.innerHTML = `
      <span>${it.name}</span>
      <span>${it.hsn}</span>
      <span>${it.qty}</span>
      <span>${it.rate.toLocaleString('en-IN')}</span>
      <span><strong>${amt.toLocaleString('en-IN')}</strong></span>
    `;
    itemsEl.appendChild(row);
    recalc();
  }

  function setStep(idx) {
    if (idx === current) return;
    current = idx;
    if (idx === 0) {
      reset();
      custEl.innerHTML = `<span class="typed">ABC Wholesale</span><span class="caret"></span>`;
    }
    if (idx === 1) {
      reset();
      custEl.innerHTML = `<span class="typed">ABC Wholesale</span>`;
      // animate beam + barcode text + item
      beamEl.classList.remove('active');
      requestAnimationFrame(() => beamEl.classList.add('active'));
      bcEl.innerHTML = `<span>${CATALOG[0].code}</span>`;
      setTimeout(() => addItem(0), 500);
    }
    if (idx === 2) {
      reset();
      custEl.innerHTML = `<span class="typed">ABC Wholesale</span>`;
      bcEl.innerHTML = `<span>${CATALOG[3].code}</span>`;
      // load 3 items in sequence
      addItem(0);
      setTimeout(() => addItem(1), 280);
      setTimeout(() => addItem(2), 560);
      setTimeout(() => addItem(3), 840);
    }
    if (idx === 3) {
      reset();
      custEl.innerHTML = `<span class="typed">ABC Wholesale</span>`;
      bcEl.innerHTML = `<span>${CATALOG[3].code}</span>`;
      addItem(0); addItem(1); addItem(2); addItem(3);
      setTimeout(() => {
        // build payment split
        const sub = 540*2 + 1200 + 4200 + 1480*2;
        const tot = sub * 1.05;
        const cash = Math.round(tot * 0.4);
        const upi  = Math.round(tot * 0.4);
        const card = Math.round(tot - cash - upi);
        payEl.innerHTML = `
          <div class="cb__payRow"><span>Cash</span><strong>${fmt(cash)}</strong></div>
          <div class="cb__payRow"><span>UPI · Paytm</span><strong>${fmt(upi)}</strong></div>
          <div class="cb__payRow"><span>Card · ****6471</span><strong>${fmt(card)}</strong></div>
        `;
        payEl.classList.add('active');
        saveEl.classList.add('flash');
        setTimeout(() => {
          doneEl.classList.add('active');
          timeEl.textContent = '6.2s';
        }, 700);
      }, 300);
    }
  }

  // Watch which step is most visible
  const io = new IntersectionObserver((entries) => {
    let best = null;
    entries.forEach(e => {
      if (!best || e.intersectionRatio > best.intersectionRatio) best = e;
    });
    if (best && best.isIntersecting) {
      const idx = Number(best.target.dataset.cin);
      steps.forEach((s, i) => s.classList.toggle('active', i === idx));
      setStep(idx);
    }
  }, { rootMargin: '-40% 0px -40% 0px', threshold: [0, .25, .5, .75, 1] });
  steps.forEach(s => io.observe(s));
}

/* ---------- tile glow already in tilt setup ---------- */
function setupTiles() {
  // no-op for now; tile glow handled in setupTiltCards
}

/* ===================================================================
   Keyboard interactive
   =================================================================== */
function setupKeyboard() {
  const previews = {
    N: { title: 'New sales bill', sub: 'Bill INV-9824 · party: blank', svg: previewBill() },
    B: { title: 'Barcode focused', sub: 'Beam ready. Scan now.', svg: previewBarcode() },
    P: { title: 'Payment entry', sub: 'Cash · UPI · Card · Cheque', svg: previewPayment() },
    F: { title: 'Find a party', sub: 'Search by name or mobile', svg: previewSearch() },
    R: { title: 'Reports hub', sub: 'P&L · GSTR · Aging · Movers', svg: previewReports() },
    S: { title: 'Bill saved', sub: 'Ledger updated · stock decremented', svg: previewSaved() },
  };

  const screen = $('#kpScreen');
  const keys = $$('.kd');

  function show(letter) {
    const d = previews[letter];
    if (!d) return;
    screen.innerHTML = `
      <div class="kp__anim">
        ${d.svg}
        <div class="kp__title">${d.title}</div>
        <div class="kp__sub">${d.sub}</div>
      </div>
    `;
  }

  function pressKey(letter) {
    const kd = keys.find(k => k.dataset.key === letter);
    if (!kd) return;
    kd.classList.add('pressed');
    setTimeout(() => kd.classList.remove('pressed'), 220);
    show(letter);
  }

  // physical keyboard
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.activeElement && /input|textarea/i.test(document.activeElement.tagName)) return;
    const k = e.key.toUpperCase();
    if (previews[k]) {
      e.preventDefault();
      pressKey(k);
    }
  });
  // click
  keys.forEach(kd => {
    kd.addEventListener('click', () => pressKey(kd.dataset.key));
  });
}

function previewBill() {
  return `<svg viewBox="0 0 200 90" width="100%" style="margin:0 auto 12px;max-width:200px">
    <rect x="10" y="10" width="180" height="70" rx="8" fill="#1a1a26" stroke="#7c8cff44"/>
    <rect x="20" y="22" width="60" height="6" rx="2" fill="#7c8cff"/>
    <rect x="20" y="36" width="120" height="4" rx="2" fill="#ffffff22"/>
    <rect x="20" y="46" width="100" height="4" rx="2" fill="#ffffff22"/>
    <rect x="20" y="56" width="80" height="4" rx="2" fill="#ffffff22"/>
    <rect x="20" y="68" width="40" height="6" rx="2" fill="#22d3ee"/>
  </svg>`;
}
function previewBarcode() {
  return `<svg viewBox="0 0 200 90" width="100%" style="margin:0 auto 12px;max-width:200px">
    <rect x="10" y="10" width="180" height="70" rx="8" fill="#000" stroke="#22d3ee"/>
    <g fill="#22d3ee">
      ${[20,24,28,34,40,44,48,54,58,64,70,74,78,84,88,94,98,108,112,116,120,126,130,134,140,144,148,154,158,164,170,174,178,184,188].map((x,i)=>`<rect x="${x}" y="22" width="${i%3===0?3:1.5}" height="46"/>`).join('')}
    </g>
  </svg>`;
}
function previewPayment() {
  return `<svg viewBox="0 0 200 90" width="100%" style="margin:0 auto 12px;max-width:200px">
    <rect x="10" y="10" width="180" height="70" rx="8" fill="#1a1a26" stroke="#7c8cff44"/>
    <rect x="20" y="20" width="40" height="18" rx="4" fill="#7c8cff44"/><text x="40" y="33" text-anchor="middle" fill="#ffffff" font-size="9" font-family="JetBrains Mono">Cash</text>
    <rect x="65" y="20" width="40" height="18" rx="4" fill="#22d3ee44"/><text x="85" y="33" text-anchor="middle" fill="#ffffff" font-size="9" font-family="JetBrains Mono">UPI</text>
    <rect x="110" y="20" width="40" height="18" rx="4" fill="#fbbf2444"/><text x="130" y="33" text-anchor="middle" fill="#ffffff" font-size="9" font-family="JetBrains Mono">Card</text>
    <rect x="155" y="20" width="30" height="18" rx="4" fill="#34d39944"/><text x="170" y="33" text-anchor="middle" fill="#ffffff" font-size="8" font-family="JetBrains Mono">Cheq</text>
    <rect x="20" y="50" width="160" height="6" rx="2" fill="#ffffff22"/>
    <rect x="20" y="62" width="100" height="6" rx="2" fill="#22d3ee"/>
  </svg>`;
}
function previewSearch() {
  return `<svg viewBox="0 0 200 90" width="100%" style="margin:0 auto 12px;max-width:200px">
    <rect x="10" y="10" width="180" height="20" rx="6" fill="#1a1a26" stroke="#7c8cff66"/>
    <circle cx="22" cy="20" r="4" fill="none" stroke="#7c8cff" stroke-width="1.5"/><path d="M25 23l3 3" stroke="#7c8cff" stroke-width="1.5"/>
    <text x="34" y="23" fill="#a5b4ff" font-size="9" font-family="JetBrains Mono">abc</text>
    <rect x="10" y="38" width="180" height="14" rx="4" fill="#7c8cff22"/>
    <text x="18" y="48" fill="#fff" font-size="9">ABC Wholesale · 98xxxxxx12</text>
    <rect x="10" y="56" width="180" height="14" rx="4" fill="#ffffff08"/>
    <text x="18" y="66" fill="#a5b4ff" font-size="9">ABC Textiles · 98xxxxxx45</text>
  </svg>`;
}
function previewReports() {
  return `<svg viewBox="0 0 200 90" width="100%" style="margin:0 auto 12px;max-width:200px">
    <g transform="translate(20,30)">
      <rect width="12" height="46" rx="2" y="0" fill="#7c8cff"/>
      <rect width="12" height="36" rx="2" x="18" y="10" fill="#7c8cff"/>
      <rect width="12" height="50" rx="2" x="36" y="-4" fill="#22d3ee"/>
      <rect width="12" height="28" rx="2" x="54" y="18" fill="#22d3ee"/>
      <rect width="12" height="42" rx="2" x="72" y="4" fill="#fbbf24"/>
    </g>
    <path d="M20 30 L42 22 L60 16 L80 24 L100 14 L130 8 L170 4" stroke="#a5b4ff" stroke-width="1.5" fill="none"/>
  </svg>`;
}
function previewSaved() {
  return `<svg viewBox="0 0 200 90" width="100%" style="margin:0 auto 12px;max-width:200px">
    <circle cx="100" cy="44" r="22" fill="none" stroke="#34d399" stroke-width="3"/>
    <path d="M88 45 l9 9 l16 -19" fill="none" stroke="#34d399" stroke-width="3" stroke-linecap="round"/>
  </svg>`;
}

/* ===================================================================
   Speed race
   =================================================================== */
function setupSpeedRace() {
  const btn = $('#raceBtn');
  if (!btn) return;
  const slowT = $('#slowT'), fastT = $('#fastT');
  const slowBar = $('#slowBar'), fastBar = $('#fastBar');
  const slowSteps = $$('#slowSteps li'), fastSteps = $$('#fastSteps li');
  const SLOW_TOTAL = 62.0, FAST_TOTAL = 6.2;
  let running = false;

  function format(t) {
    const sec = Math.floor(t);
    const dec = Math.floor((t - sec) * 10);
    return String(sec).padStart(2,'0') + ':' + String(sec*0 + Math.floor(t*100)%100).padStart(2,'0') + '.' + dec;
  }
  // simpler human format mm:ss.s
  function fmtTime(t) {
    const m = Math.floor(t / 60);
    const s = (t % 60);
    return String(m).padStart(2,'0') + ':' + s.toFixed(1).padStart(4,'0');
  }

  function run() {
    if (running) return;
    running = true;
    btn.textContent = '⏱ Running…';
    slowSteps.forEach(s => s.classList.remove('done'));
    fastSteps.forEach(s => s.classList.remove('done'));
    const start = performance.now();
    const slowEnd = SLOW_TOTAL, fastEnd = FAST_TOTAL;
    const tick = (now) => {
      const elapsed = (now - start) / 1000;
      // slow: 62s simulated in 5s real
      const sT = Math.min(elapsed / 5 * slowEnd, slowEnd);
      const fT = Math.min(elapsed / 5 * fastEnd, fastEnd);
      slowT.textContent = fmtTime(sT);
      fastT.textContent = fmtTime(fT);
      slowBar.style.width = (sT / slowEnd * 100) + '%';
      fastBar.style.width = (fT / fastEnd * 100) + '%';
      // mark steps done as time progresses
      const sPer = slowSteps.length;
      const fPer = fastSteps.length;
      slowSteps.forEach((li, i) => { if (sT / slowEnd >= (i+1)/sPer) li.classList.add('done'); });
      fastSteps.forEach((li, i) => { if (fT / fastEnd >= (i+1)/fPer) li.classList.add('done'); });
      if (elapsed < 5.2) requestAnimationFrame(tick);
      else {
        running = false;
        btn.textContent = '↻  Run it again';
      }
    };
    requestAnimationFrame(tick);
  }

  btn.addEventListener('click', run);
  // auto-run when section is visible the first time
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) { run(); io.unobserve(e.target); }
    });
  }, { threshold: 0.4 });
  io.observe(btn);
}

/* ---------- nav hide ---------- */
function setupNavHide() {
  const nav = $('#nav');
  if (!nav) return;
  let lastY = 0;
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    nav.classList.toggle('hidden', y > lastY && y > 120);
    lastY = y;
  }, { passive: true });
}

/* ---------- year ---------- */
function setupYear() {
  const y = $('#yr');
  if (y) y.textContent = new Date().getFullYear();
}

})();
