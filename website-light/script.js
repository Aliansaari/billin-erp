/* =====================================================================
   ZEHEN — light-mode interactions
   - Theme toggle (Classic ⇄ Modern)
   - Reveal on scroll · count-ups · tilt cards
   - Cinematic bill assembly
   - Keyboard interactive · Speed race · Nav hide
   ===================================================================== */
(() => {
'use strict';
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
const lerp = (a,b,t) => a + (b-a)*t;
const fmt = (n) => '₹ ' + Math.round(n).toLocaleString('en-IN');
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

document.addEventListener('DOMContentLoaded', () => {
  setupTheme();
  setupReveal();
  setupTiles();
  setupTilt();
  setupHeroCounters();
  setupCinematic();
  setupKeyboard();
  setupSpeed();
  setupNavHide();
  setupYear();
});

/* ---------- theme toggle ---------- */
function setupTheme() {
  const btn = $('#themeTog');
  const name = $('#themeTogName');
  if (!btn) return;
  const KEY = 'billing-erp-theme';
  const stored = localStorage.getItem(KEY);
  if (stored === 'modern' || stored === 'classic') {
    document.documentElement.setAttribute('data-theme', stored);
  }
  const sync = () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'classic';
    if (name) name.textContent = cur === 'modern' ? 'Modern' : 'Classic';
  };
  sync();
  btn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'classic';
    const next = cur === 'modern' ? 'classic' : 'modern';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(KEY, next);
    sync();
  });
}

/* ---------- reveal on scroll ---------- */
function setupReveal() {
  const els = $$('.reveal');
  if (!('IntersectionObserver' in window)) { els.forEach(e => e.classList.add('in')); return; }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e, i) => {
      if (e.isIntersecting) {
        setTimeout(() => e.target.classList.add('in'), i * 50);
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -8% 0px' });
  els.forEach(e => io.observe(e));
}

/* ---------- card hover spotlight ---------- */
function setupTiles() {
  $$('.tile').forEach(el => {
    el.addEventListener('mousemove', (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  });
}

/* ---------- tilt cards ---------- */
function setupTilt() {
  if (reduced) return;
  $$('[data-tilt]').forEach(card => {
    card.addEventListener('mousemove', (e) => {
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width  - 0.5;
      const y = (e.clientY - r.top)  / r.height - 0.5;
      card.style.transform = `perspective(900px) rotateX(${-y*5}deg) rotateY(${x*7}deg) translateY(-3px)`;
    });
    card.addEventListener('mouseleave', () => { card.style.transform = ''; });
  });
}

/* ---------- hero KPI count-ups ---------- */
function setupHeroCounters() {
  const run = () => {
    $$('[data-counter]').forEach(el => {
      if (el.dataset.done) return;
      const target = parseFloat(el.dataset.counter);
      const dur = 1800;
      const start = performance.now();
      const tick = (now) => {
        const t = Math.min((now - start) / dur, 1);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = Math.round(target * eased).toLocaleString('en-IN');
        if (t < 1) requestAnimationFrame(tick);
        else el.dataset.done = '1';
      };
      requestAnimationFrame(tick);
    });
  };
  setTimeout(run, 500);
}

/* =====================================================================
   Cinematic bill assembly
   ===================================================================== */
function setupCinematic() {
  const steps = $$('.cin__step');
  if (!steps.length) return;

  const custEl = $('#cinCustomer');
  const bcEl   = $('#cinBarcode');
  const beamEl = $('#cinBeam');
  const items  = $('#cinItems');
  const sub = $('#cinSub'), cg = $('#cinCgst'), sg = $('#cinSgst'), tot = $('#cinTot');
  const pay = $('#cinPay');
  const save = $('#cinSave');
  const done = $('#cinDone');
  const time = $('#cinDoneTime');

  const CAT = [
    { name: 'Cotton Shirt · L',    hsn: '6109', rate: 540,  qty: 2, code: 'PRD-00214' },
    { name: 'Linen Trouser · 34',  hsn: '6204', rate: 1200, qty: 1, code: 'PRD-00518' },
    { name: 'Silk Saree · Premium',hsn: '5407', rate: 4200, qty: 1, code: 'PRD-00912' },
    { name: 'Denim Jeans · 32',    hsn: '6203', rate: 1480, qty: 2, code: 'PRD-01402' },
  ];

  let current = -1;

  function reset() {
    custEl.innerHTML = '<span class="bill-card__ph">Search by name or mobile…</span>';
    bcEl.innerHTML   = '<span class="bill-card__ph">Scan…</span>';
    items.innerHTML  = '';
    sub.textContent = cg.textContent = sg.textContent = tot.textContent = '₹ 0';
    pay.classList.remove('active');
    pay.innerHTML = '';
    save.classList.remove('flash');
    done.classList.remove('active');
  }

  function recalc() {
    let s = 0;
    $$('.bill-card__tr', items).forEach(r => s += parseFloat(r.dataset.amt || 0));
    const cgst = s * 0.025, sgst = s * 0.025;
    sub.textContent = fmt(s);
    cg.textContent  = fmt(cgst);
    sg.textContent  = fmt(sgst);
    tot.textContent = fmt(s + cgst + sgst);
  }

  function addItem(idx) {
    const it = CAT[idx];
    if (!it) return;
    const amt = it.rate * it.qty;
    const row = document.createElement('div');
    row.className = 'bill-card__tr';
    row.dataset.amt = amt;
    row.innerHTML = `
      <span>${it.name}</span>
      <span>${it.hsn}</span>
      <span>${it.qty}</span>
      <span>${it.rate.toLocaleString('en-IN')}</span>
      <span><strong>${amt.toLocaleString('en-IN')}</strong></span>
    `;
    items.appendChild(row);
    recalc();
  }

  function setStep(idx) {
    if (idx === current) return;
    current = idx;
    if (idx === 0) {
      reset();
      custEl.innerHTML = `<span style="color:var(--text)">ABC Wholesale</span>`;
    }
    if (idx === 1) {
      reset();
      custEl.innerHTML = `<span style="color:var(--text)">ABC Wholesale</span>`;
      beamEl.classList.remove('active');
      requestAnimationFrame(() => beamEl.classList.add('active'));
      bcEl.innerHTML = `<span style="color:var(--text)">${CAT[0].code}</span>`;
      setTimeout(() => addItem(0), 500);
    }
    if (idx === 2) {
      reset();
      custEl.innerHTML = `<span style="color:var(--text)">ABC Wholesale</span>`;
      bcEl.innerHTML = `<span style="color:var(--text)">${CAT[3].code}</span>`;
      addItem(0);
      setTimeout(() => addItem(1), 260);
      setTimeout(() => addItem(2), 520);
      setTimeout(() => addItem(3), 780);
    }
    if (idx === 3) {
      reset();
      custEl.innerHTML = `<span style="color:var(--text)">ABC Wholesale</span>`;
      bcEl.innerHTML = `<span style="color:var(--text)">${CAT[3].code}</span>`;
      addItem(0); addItem(1); addItem(2); addItem(3);
      setTimeout(() => {
        const s = 540*2 + 1200 + 4200 + 1480*2;
        const t = s * 1.05;
        const cash = Math.round(t * 0.4);
        const upi  = Math.round(t * 0.4);
        const card = Math.round(t - cash - upi);
        pay.innerHTML = `
          <div><span>Cash</span><strong>${fmt(cash)}</strong></div>
          <div><span>UPI · Paytm</span><strong>${fmt(upi)}</strong></div>
          <div><span>Card · ****6471</span><strong>${fmt(card)}</strong></div>
        `;
        pay.classList.add('active');
        save.classList.add('flash');
        setTimeout(() => {
          done.classList.add('active');
          time.textContent = '6.2s';
        }, 700);
      }, 300);
    }
  }

  const io = new IntersectionObserver((entries) => {
    let best = null;
    entries.forEach(e => { if (!best || e.intersectionRatio > best.intersectionRatio) best = e; });
    if (best && best.isIntersecting) {
      const idx = Number(best.target.dataset.cin);
      steps.forEach((s, i) => s.classList.toggle('active', i === idx));
      setStep(idx);
    }
  }, { rootMargin: '-40% 0px -40% 0px', threshold: [0, .25, .5, .75, 1] });
  steps.forEach(s => io.observe(s));
}

/* =====================================================================
   Keyboard interactive
   ===================================================================== */
function setupKeyboard() {
  const screen = $('#kpScreen');
  const keys = $$('.kd');
  if (!screen) return;

  const previews = {
    N: { title: 'New sales bill', sub: 'Bill INV-9824 · party: blank', svg: pvBill() },
    B: { title: 'Barcode focused', sub: 'Beam ready. Scan now.',      svg: pvBC()  },
    P: { title: 'Payment entry',   sub: 'Cash · UPI · Card · Cheque', svg: pvPay() },
    F: { title: 'Find a party',    sub: 'Search by name or mobile',   svg: pvSearch() },
    R: { title: 'Reports hub',     sub: 'P&L · GSTR · Aging · Movers',svg: pvRep() },
    S: { title: 'Bill saved',      sub: 'Ledger updated · stock decremented', svg: pvSaved() },
  };

  function show(k) {
    const d = previews[k];
    if (!d) return;
    screen.innerHTML = `${d.svg}<div class="kp__title">${d.title}</div><div class="kp__sub">${d.sub}</div>`;
  }
  function pressKey(k) {
    const kd = keys.find(x => x.dataset.key === k);
    if (!kd) return;
    kd.classList.add('pressed');
    setTimeout(() => kd.classList.remove('pressed'), 220);
    show(k);
  }

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.activeElement && /input|textarea/i.test(document.activeElement.tagName)) return;
    const k = e.key.toUpperCase();
    if (previews[k]) { e.preventDefault(); pressKey(k); }
  });
  keys.forEach(kd => kd.addEventListener('click', () => pressKey(kd.dataset.key)));
}
function pvBill() {
  return `<svg viewBox="0 0 200 80" width="100%" style="margin:0 auto 14px;max-width:200px">
    <rect x="10" y="10" width="180" height="60" rx="8" fill="var(--bg-2)" stroke="var(--line)"/>
    <rect x="20" y="22" width="60" height="6" rx="2" fill="var(--primary)"/>
    <rect x="20" y="36" width="120" height="4" rx="2" fill="var(--line)"/>
    <rect x="20" y="46" width="100" height="4" rx="2" fill="var(--line)"/>
    <rect x="20" y="56" width="40" height="6" rx="2" fill="var(--success)"/>
  </svg>`;
}
function pvBC() {
  return `<svg viewBox="0 0 200 80" width="100%" style="margin:0 auto 14px;max-width:200px">
    <rect x="10" y="10" width="180" height="60" rx="8" fill="var(--text)" stroke="var(--primary)"/>
    <g fill="var(--primary-2)">
      ${[20,24,28,34,40,44,48,54,58,64,70,74,78,84,88,94,98,108,112,116,120,126,130,134,140,144,148,154,158,164,170,174,178,184,188].map((x,i)=>`<rect x="${x}" y="20" width="${i%3===0?3:1.5}" height="40"/>`).join('')}
    </g>
  </svg>`;
}
function pvPay() {
  return `<svg viewBox="0 0 200 80" width="100%" style="margin:0 auto 14px;max-width:200px">
    <rect x="10" y="10" width="180" height="60" rx="8" fill="var(--bg-2)" stroke="var(--line)"/>
    <rect x="20" y="20" width="38" height="18" rx="4" fill="var(--primary-soft)"/><text x="39" y="33" text-anchor="middle" fill="var(--primary)" font-size="9" font-family="JetBrains Mono">Cash</text>
    <rect x="62" y="20" width="38" height="18" rx="4" fill="var(--success-soft)"/><text x="81" y="33" text-anchor="middle" fill="var(--success)" font-size="9" font-family="JetBrains Mono">UPI</text>
    <rect x="104" y="20" width="38" height="18" rx="4" fill="var(--warning-soft)"/><text x="123" y="33" text-anchor="middle" fill="var(--warning)" font-size="9" font-family="JetBrains Mono">Card</text>
    <rect x="146" y="20" width="34" height="18" rx="4" fill="var(--error-soft)"/><text x="163" y="33" text-anchor="middle" fill="var(--error)" font-size="8" font-family="JetBrains Mono">Cheq</text>
    <rect x="20" y="48" width="160" height="6" rx="2" fill="var(--line)"/>
    <rect x="20" y="60" width="100" height="6" rx="2" fill="var(--primary)"/>
  </svg>`;
}
function pvSearch() {
  return `<svg viewBox="0 0 200 80" width="100%" style="margin:0 auto 14px;max-width:200px">
    <rect x="10" y="10" width="180" height="20" rx="6" fill="var(--bg-2)" stroke="var(--primary)" stroke-opacity=".4"/>
    <circle cx="22" cy="20" r="4" fill="none" stroke="var(--primary)" stroke-width="1.5"/><path d="M25 23l3 3" stroke="var(--primary)" stroke-width="1.5"/>
    <text x="34" y="23" fill="var(--primary)" font-size="9" font-family="JetBrains Mono">abc</text>
    <rect x="10" y="36" width="180" height="14" rx="4" fill="var(--primary-soft)"/>
    <text x="18" y="46" fill="var(--text)" font-size="9">ABC Wholesale · 98xxxxxx12</text>
    <rect x="10" y="54" width="180" height="14" rx="4" fill="var(--bg-2)"/>
    <text x="18" y="64" fill="var(--text-2)" font-size="9">ABC Textiles · 98xxxxxx45</text>
  </svg>`;
}
function pvRep() {
  return `<svg viewBox="0 0 200 80" width="100%" style="margin:0 auto 14px;max-width:200px">
    <g transform="translate(20,26)">
      <rect width="12" height="40" rx="2" y="2" fill="var(--primary)"/>
      <rect width="12" height="32" rx="2" x="18" y="10" fill="var(--primary)"/>
      <rect width="12" height="46" rx="2" x="36" y="-4" fill="var(--primary-2)"/>
      <rect width="12" height="24" rx="2" x="54" y="18" fill="var(--primary-2)"/>
      <rect width="12" height="38" rx="2" x="72" y="4" fill="var(--warning)"/>
    </g>
    <path d="M20 28 L42 22 L60 16 L80 24 L100 14 L130 8 L170 6" stroke="var(--success)" stroke-width="1.5" fill="none"/>
  </svg>`;
}
function pvSaved() {
  return `<svg viewBox="0 0 200 80" width="100%" style="margin:0 auto 14px;max-width:200px">
    <circle cx="100" cy="40" r="22" fill="none" stroke="var(--success)" stroke-width="3"/>
    <path d="M88 41 l9 9 l16 -19" fill="none" stroke="var(--success)" stroke-width="3" stroke-linecap="round"/>
  </svg>`;
}

/* =====================================================================
   Speed race
   ===================================================================== */
function setupSpeed() {
  const btn = $('#raceBtn');
  if (!btn) return;
  const slowT = $('#slowT'), fastT = $('#fastT');
  const slowBar = $('#slowBar'), fastBar = $('#fastBar');
  const slow = $$('#slowSteps li'), fast = $$('#fastSteps li');
  const SLOW = 62.0, FAST = 6.2;
  let running = false;

  function fmtTime(t) {
    const m = Math.floor(t / 60);
    const s = (t % 60);
    return String(m).padStart(2,'0') + ':' + s.toFixed(1).padStart(4,'0');
  }
  function run() {
    if (running) return;
    running = true;
    btn.textContent = '⏱ Running…';
    slow.forEach(s => s.classList.remove('done'));
    fast.forEach(s => s.classList.remove('done'));
    const start = performance.now();
    const tick = (now) => {
      const elapsed = (now - start) / 1000;
      const sT = Math.min(elapsed / 5 * SLOW, SLOW);
      const fT = Math.min(elapsed / 5 * FAST, FAST);
      slowT.textContent = fmtTime(sT);
      fastT.textContent = fmtTime(fT);
      slowBar.style.width = (sT / SLOW * 100) + '%';
      fastBar.style.width = (fT / FAST * 100) + '%';
      slow.forEach((li, i) => { if (sT / SLOW >= (i+1)/slow.length) li.classList.add('done'); });
      fast.forEach((li, i) => { if (fT / FAST >= (i+1)/fast.length) li.classList.add('done'); });
      if (elapsed < 5.2) requestAnimationFrame(tick);
      else { running = false; btn.textContent = '↻  Run it again'; }
    };
    requestAnimationFrame(tick);
  }
  btn.addEventListener('click', run);
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting) { run(); io.unobserve(e.target); } });
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

function setupYear() {
  const y = $('#yr');
  if (y) y.textContent = new Date().getFullYear();
}
})();
