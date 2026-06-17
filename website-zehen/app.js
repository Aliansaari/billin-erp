/* ZEHEN marketing site — interactions */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(hover:hover) and (pointer:fine)').matches;
  const inr = n => Math.round(n).toLocaleString('en-IN');
  const icon = id => `<svg class="ic" aria-hidden="true"><use href="#${id}"/></svg>`;
  const yr = $('#yr'); if (yr) yr.textContent = new Date().getFullYear();

  /* ---------- nav + scroll progress ---------- */
  const nav = $('#nav'), prog = $('#scrollProg');
  const onScroll = () => {
    nav.classList.toggle('scrolled', scrollY > 24);
    const h = document.documentElement.scrollHeight - innerHeight;
    if (prog) prog.style.width = (h > 0 ? (scrollY / h) * 100 : 0) + '%';
  };
  addEventListener('scroll', onScroll, { passive: true }); onScroll();

  /* ---------- magnetic CTAs (subtle) ---------- */
  if (fine && !reduce) $$('.magnetic').forEach(el => {
    el.addEventListener('mousemove', e => {
      const r = el.getBoundingClientRect();
      el.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * .18}px,${(e.clientY - r.top - r.height / 2) * .28}px)`;
    });
    el.addEventListener('mouseleave', () => { el.style.transform = ''; });
  });

  /* ---------- reveal ---------- */
  const revIO = new IntersectionObserver((es) => {
    es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); revIO.unobserve(e.target); } });
  }, { threshold: .12, rootMargin: '0px 0px -7% 0px' });
  $$('.reveal').forEach(el => revIO.observe(el));

  /* ---------- count up ---------- */
  const counted = new WeakSet();
  const countUp = (el, to, dur = 1500) => {
    if (counted.has(el)) return; counted.add(el);
    if (reduce) { el.textContent = inr(to); return; }
    const t0 = performance.now();
    const step = t => {
      const p = Math.min((t - t0) / dur, 1), e = 1 - Math.pow(1 - p, 3);
      el.textContent = inr(to * e);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const numIO = new IntersectionObserver((es) => {
    es.forEach(e => { if (e.isIntersecting) { const el = e.target; countUp(el, +(el.dataset.counter || el.dataset.ticker)); numIO.unobserve(el); } });
  }, { threshold: .6 });
  $$('[data-counter],[data-ticker]').forEach(el => numIO.observe(el));

  /* ---------- hero parallax tilt ---------- */
  const stage = $('#stage'), wrap = $('#heroStage');
  if (stage && wrap && fine && !reduce) {
    let tx = -9, ty = 4, cx = -9, cy = 4;
    wrap.addEventListener('mousemove', e => {
      const r = wrap.getBoundingClientRect();
      tx = -9 + ((e.clientX - r.left) / r.width - .5) * 10;
      ty = 4 - ((e.clientY - r.top) / r.height - .5) * 8;
    });
    wrap.addEventListener('mouseleave', () => { tx = -9; ty = 4; });
    (function loop() {
      cx += (tx - cx) * .07; cy += (ty - cy) * .07;
      stage.style.transform = `perspective(2200px) rotateX(${cy}deg) rotateY(${cx}deg)`;
      requestAnimationFrame(loop);
    })();
  }

  /* ---------- cinematic billing ---------- */
  (() => {
    const bill = $('#cinBill'); if (!bill) return;
    const items = [
      { n: 'Cotton Shirt · L', h: '6109', q: 12, r: 540 },
      { n: 'Linen Trouser', h: '6203', q: 6, r: 890 },
      { n: 'Denim · 32', h: '6203', q: 8, r: 760 },
    ];
    const elC = $('#cinCustomer'), elBeam = $('#cinBeam'), elBc = $('#cinBarcode'),
      elItems = $('#cinItems'), elSub = $('#cinSub'), elCg = $('#cinCgst'), elSg = $('#cinSgst'),
      elTot = $('#cinTot'), elPay = $('#cinPay'), elDone = $('#cinDone');
    let cur = -1, timer;
    const render = (step) => {
      if (step === cur) return; cur = step;
      elC.innerHTML = step >= 0
        ? 'Anand Wholesale <span class="mono" style="color:var(--p-tx-3);font-size:11px">· bal ₹1,24,000</span>'
        : '<span class="cb__ph">Search by name or mobile…</span>';
      elBeam.classList.toggle('on', step === 1);
      elBc.innerHTML = step >= 1 ? '8901234500127' : '<span class="cb__ph">Scan…</span>';
      const show = step <= 0 ? 0 : step === 1 ? 1 : 3;
      const list = items.slice(0, show);
      elItems.innerHTML = list.map(it =>
        `<div class="cb__it"><b>${it.n}</b><i>${it.h}</i><i>${it.q}</i><i>${inr(it.r)}</i><i>${inr(it.q * it.r)}</i></div>`).join('');
      const sub = list.reduce((s, it) => s + it.q * it.r, 0), cg = sub * .025;
      elSub.textContent = '₹' + inr(sub);
      elCg.textContent = '₹' + inr(cg);
      elSg.textContent = '₹' + inr(cg);
      elTot.textContent = '₹' + inr(sub + cg * 2);
      clearTimeout(timer);
      if (step >= 3) {
        elPay.innerHTML = '<div><span>Cash</span><b>₹10,000</b></div><div><span>UPI</span><b>₹8,796</b></div><div><span>Card</span><b>₹0</b></div>';
        timer = setTimeout(() => { $('#cinDoneTime').textContent = '6.2s'; elDone.classList.add('on'); }, 700);
      } else {
        elDone.classList.remove('on');
        elPay.innerHTML = '<div><span>Cash</span><b>₹0</b></div><div><span>UPI</span><b>₹0</b></div><div><span>Card</span><b>₹0</b></div>';
      }
    };
    const steps = $$('.cine__step');
    const io = new IntersectionObserver((es) => {
      es.forEach(e => { if (!e.isIntersecting) return; const n = +e.target.dataset.cin; steps.forEach(s => s.classList.toggle('is-on', s === e.target)); render(n); });
    }, { rootMargin: '-45% 0px -45% 0px' });
    steps.forEach(s => io.observe(s));
    render(0);
  })();

  /* ---------- global search ---------- */
  (() => {
    const q = $('#gsQuery'), out = $('#gsResults'), gs = $('.gs'); if (!q || !out) return;
    const scenes = [
      { q: 'anand wholesale', g: [
        { c: 'Parties', r: [
          { i: 'i-users', t: 'Anand Wholesale', s: 'Mumbai · GSTIN 27AAB…1Z5', m: 'bal <b>₹1,24,500</b>', sel: 1 },
          { i: 'i-users', t: 'Anand Traders', s: 'Pune · supplier', m: 'bal ₹0' }] },
        { c: 'Bills', r: [{ i: 'i-receipt', t: 'INV-9823 · Anand Wholesale', s: '02 Apr · ₹1,24,500', m: '<span class="gs__tag">Paid</span>' }] },
        { c: 'Actions', r: [{ i: 'i-plus', t: 'New sales bill → Anand Wholesale', s: 'create invoice', m: '<kbd>↵</kbd>' }] }] },
      { q: 'overdue parties', g: [
        { c: 'Smart views', r: [
          { i: 'i-alert', t: 'Overdue parties', s: '3 parties · ₹2,66,200 due', m: 'open', sel: 1 },
          { i: 'i-chart', t: 'Ageing analysis', s: '0–30 / 31–60 / 61–90 / 90+', m: 'report' }] },
        { c: 'Top result', r: [{ i: 'i-users', t: 'Reliance Textiles', s: 'overdue 12 days', m: '<b>₹84,200</b>' }] }] },
      { q: 'hsn 6109', g: [
        { c: 'Items · HSN 6109', r: [
          { i: 'i-box', t: 'Cotton Shirt · L', s: '142 in stock · 3 godowns', m: '₹1,200', sel: 1 },
          { i: 'i-box', t: 'Cotton Shirt · M', s: '88 in stock', m: '₹1,200' }] },
        { c: 'GST', r: [{ i: 'i-percent', t: 'HSN 6109 — 5% (2.5 + 2.5)', s: 'tax rate', m: 'settings' }] }] },
      { q: 'gstr', g: [
        { c: 'Reports', r: [
          { i: 'i-chart', t: 'GSTR-1', s: 'outward supplies · Q4', m: 'export', sel: 1 },
          { i: 'i-chart', t: 'GSTR-3B', s: 'summary return', m: 'export' }] },
        { c: 'Settings', r: [{ i: 'i-gear', t: 'GST settings', s: 'HSN, rates, place of supply', m: 'open' }] }] },
    ];
    const draw = (g) => {
      let html = '', d = 0;
      g.forEach(gr => {
        html += `<div class="gs__cat">${gr.c}</div>`;
        gr.r.forEach(r => {
          html += `<div class="gs__row${r.sel ? ' sel' : ''}" style="animation-delay:${d * 55}ms"><span class="gs__ri">${icon(r.i)}</span><span class="gs__rm"><span class="gs__rt">${r.t}</span><span class="gs__rs">${r.s}</span></span><span class="gs__rmeta">${r.m}</span></div>`;
          d++;
        });
      });
      out.innerHTML = html;
      const t = $('#gsTime'); if (t) t.textContent = 2 + Math.floor(Math.random() * 6);
    };
    let si = 0, alive = false;
    const type = (text, cb) => { let i = 0; (function tick() { q.textContent = text.slice(0, i); if (i++ <= text.length) setTimeout(tick, 36 + Math.random() * 42); else cb(); })(); };
    const play = () => {
      if (!alive) return;
      const sc = scenes[si % scenes.length];
      type(sc.q, () => { draw(sc.g); setTimeout(() => { if (!alive) return; si++; q.textContent = ''; out.innerHTML = ''; setTimeout(play, 320); }, 2600); });
    };
    new IntersectionObserver((es) => es.forEach(e => {
      if (e.isIntersecting && !alive) { alive = true; if (reduce) { q.textContent = scenes[0].q; draw(scenes[0].g); } else play(); }
      else if (!e.isIntersecting) alive = false;
    }), { threshold: .3 }).observe(gs);
  })();

  /* ---------- whatsapp ---------- */
  (() => {
    const chat = $('#waChat'); if (!chat) return;
    const seq = [
      { k: 'out', pdf: ['INV-9823.pdf', 'Invoice · ₹1,24,500'] },
      { k: 'out', t: 'Namaste 🙏 Here is your invoice for <b>₹1,24,500</b> from Mehta Traders. Thank you!', time: '10:24' },
      { k: 'in', t: 'balance', time: '10:31' },
      { k: 'typing' },
      { k: 'out', t: 'Hello Anand Wholesale 👋\nYour current balance is <b>₹1,58,500</b>.\n\n• INV-9823 — ₹1,24,500\n• Opening — ₹34,000\n\nReply <b>statement</b> for a PDF.', time: '10:31' },
      { k: 'in', t: 'statement', time: '10:32' },
      { k: 'typing' },
      { k: 'out', pdf: ['Statement.pdf', 'Account statement · Apr'] },
      { k: 'out', t: 'Here you go — your full statement. 🙏', time: '10:32' },
    ];
    const bubble = (m) => {
      const d = document.createElement('div');
      if (m.k === 'typing') { d.className = 'wb wb--typing'; d.innerHTML = '<i></i><i></i><i></i>'; }
      else if (m.pdf) { d.className = 'wb wb--' + m.k + ' wb--pdf'; d.innerHTML = `<span class="pi">PDF</span><span class="pm"><b>${m.pdf[0]}</b><span>${m.pdf[1]}</span></span>`; }
      else { d.className = 'wb wb--' + m.k; d.innerHTML = m.t.replace(/\n/g, '<br>') + (m.time ? `<time>${m.time} ✓✓</time>` : ''); }
      return d;
    };
    let i = 0, alive = false;
    const next = () => {
      if (!alive) return;
      if (i >= seq.length) { setTimeout(() => { chat.innerHTML = ''; i = 0; next(); }, 3000); return; }
      const m = seq[i++];
      if (m.k === 'typing') { const b = bubble(m); chat.appendChild(b); setTimeout(() => { b.remove(); next(); }, 1050); }
      else { chat.appendChild(bubble(m)); chat.scrollTop = chat.scrollHeight; setTimeout(next, m.pdf ? 700 : 1350); }
    };
    new IntersectionObserver((es) => es.forEach(e => {
      if (e.isIntersecting && !alive) { alive = true; if (reduce) seq.forEach(m => m.k !== 'typing' && chat.appendChild(bubble(m))); else next(); }
      else if (!e.isIntersecting) { alive = false; chat.innerHTML = ''; i = 0; }
    }), { threshold: .4 }).observe(chat);
  })();

  /* ---------- speed race ---------- */
  (() => {
    const btn = $('#raceBtn'); if (!btn) return;
    const label = btn.querySelector('span'), slowT = $('#slowT'), fastT = $('#fastT'), slowBar = $('#slowBar'), fastBar = $('#fastBar');
    const ss = $$('.lane--slow .lane__s li'), fs = $$('.lane--fast .lane__s li');
    const fmt = ms => { const s = ms / 1000; return '00:' + String(Math.floor(s)).padStart(2, '0') + '.' + String(Math.floor((s % 1) * 10)); };
    let running = false;
    btn.addEventListener('click', () => {
      if (running) return; running = true; label.textContent = 'Running…';
      [...ss, ...fs].forEach(s => s.classList.remove('done'));
      const SLOW = 58000, FAST = 6200, t0 = performance.now();
      (function tick(t) {
        const el = t - t0, sp = Math.min(el / SLOW, 1), fp = Math.min(el / FAST, 1);
        slowBar.style.width = sp * 100 + '%'; fastBar.style.width = fp * 100 + '%';
        slowT.textContent = fmt(Math.min(el, SLOW)); fastT.textContent = fmt(Math.min(el, FAST));
        ss.forEach((s, n) => sp >= (n + 1) / ss.length && s.classList.add('done'));
        fs.forEach((s, n) => fp >= (n + 1) / fs.length && s.classList.add('done'));
        if (sp < 1) requestAnimationFrame(tick); else { running = false; label.textContent = 'Run again'; }
      })(t0);
    });
  })();

  /* ---------- keyboard ---------- */
  (() => {
    const screen = $('#kpScreen'); if (!screen) return;
    const map = {
      F1: ['i-check', 'Save &amp; print', 'One key saves the bill, prints the receipt — and offers to WhatsApp it.', 'INV-9824 saved · printed · sent'],
      F2: ['i-clock', 'Smart date picker', 'A Tally-style date popup anywhere a date is needed. Type "t" for today, "-1" for yesterday.', '17 Jun 2026'],
      N: ['i-plus', 'New sales bill', 'Jump straight into billing from any screen. The cursor lands on the party field.', 'New sales invoice · INV-9824'],
      B: ['i-scan', 'Focus barcode', 'Hands on the scanner, eyes on the customer. Beam, Enter, next item.', 'Scan…'],
      P: ['i-cart', 'Payment entry', 'Split across cash, UPI, card and cheque in one keystroke flow.', 'Cash ₹10,000 · UPI ₹8,796'],
      K: ['i-search', 'Global search', 'Cmd / Ctrl + K opens search over the whole shop — parties, items, bills, reports.', 'search anything…'],
    };
    const keys = $$('.krow');
    const fire = (k) => {
      const m = map[k]; if (!m) return;
      const row = keys.find(x => x.dataset.key === k);
      if (row) { row.classList.add('press'); setTimeout(() => row.classList.remove('press'), 150); }
      screen.innerHTML = `<div class="kp__card"><div class="kpi__top">${icon(m[0])}<span>${m[1]}</span></div><h4>${m[1]}</h4><p>${m[2]}</p><div class="kp__demo">${icon(m[0])}<span class="mono">${m[3]}</span></div></div>`;
    };
    keys.forEach(r => r.addEventListener('click', () => fire(r.dataset.key)));
    addEventListener('keydown', e => {
      const k = e.key === 'F1' ? 'F1' : e.key === 'F2' ? 'F2' : e.key.toUpperCase();
      if (map[k] && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
        if (k === 'F1' || k === 'F2') e.preventDefault();
        fire(k);
      }
    });
  })();

  /* ---------- reports drag ---------- */
  (() => {
    const rail = $('#repRail'); if (!rail) return;
    let down = false, sx = 0, sl = 0;
    rail.addEventListener('pointerdown', e => { down = true; rail.classList.add('drag'); sx = e.clientX; sl = rail.scrollLeft; });
    addEventListener('pointerup', () => { down = false; rail.classList.remove('drag'); });
    rail.addEventListener('pointermove', e => { if (down) rail.scrollLeft = sl - (e.clientX - sx); });
  })();

  /* ---------- smooth anchors ---------- */
  $$('a[href^="#"]').forEach(a => a.addEventListener('click', e => {
    const id = a.getAttribute('href'); if (id.length < 2) return;
    const t = $(id); if (!t) return; e.preventDefault();
    t.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }));
})();
