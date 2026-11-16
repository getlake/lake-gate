// Visit counting: GoatCounter (free, cookieless, no personal data). Loads only when the site code is set, and never on localhost.
const GOATCOUNTER_CODE = 'lakehq';
if (GOATCOUNTER_CODE && !/^(localhost|127\.)/.test(location.hostname)) {
  const s = document.createElement('script');
  s.async = true; s.src = 'https://gc.zgo.at/count.js';
  s.dataset.goatcounter = `https://${GOATCOUNTER_CODE}.goatcounter.com/count`;
  document.head.appendChild(s);
}
const track = (name) => { if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: name, title: name, event: true }); };
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-track]');
  if (t) { const once = t.dataset.track === 'cta-team-pilot'; let seen = false; try { seen = once && localStorage.getItem('lake-pilot') === '1'; if (once) localStorage.setItem('lake-pilot', '1'); } catch {} if (!seen) track(t.dataset.track); }
  const c = e.target.closest('[data-copy]');
  if (c) {
    navigator.clipboard?.writeText(c.dataset.copy).then(() => {
      const label = c.querySelector('span'); label.textContent = 'Copied'; track('copy-install');
      setTimeout(() => { label.textContent = 'Copy'; }, 1600);
    }).catch(() => {});
  }
});

// Live hero: one short product moment, played when it scrolls into view.
(() => {
  const live = document.getElementById('live'); if (!live) return;
  const win = live.querySelector('.live-win'), cursor = live.querySelector('.lw-cursor');
  const steps = [...live.querySelectorAll('.lw-steps li')], meter = document.getElementById('lv-meter');
  const $ = (id) => document.getElementById(id);
  const replay = document.createElement('button'); replay.className = 'lw-replay'; replay.type = 'button'; replay.textContent = '↻ Replay'; replay.setAttribute('data-track', 'hero-replay');
  live.querySelector('.lw-bar').appendChild(replay);
  const sums = [12, 92, 94, 100]; // share of the plan's estimate after each step lands
  let timers = [];
  const at = (ms, fn) => timers.push(setTimeout(fn, ms));
  const pointTo = (el) => { const a = win.getBoundingClientRect(), b = el.getBoundingClientRect(); cursor.style.left = `${b.left - a.left + b.width * 0.55}px`; cursor.style.top = `${b.top - a.top + b.height * 0.6}px`; cursor.style.opacity = 1; };
  function reset() {
    timers.forEach(clearTimeout); timers = [];
    live.className = 'live'; steps.forEach((s) => s.classList.remove('on'));
    steps.forEach((s) => { const m = s.querySelector('.m'); m.textContent = m.dataset.a; m.classList.remove('swap'); });
    $('lv-model').textContent = 'Opus 5.5'; meter.style.width = '0'; cursor.style.opacity = 0; cursor.style.left = '62%'; cursor.style.top = '108%';
    $('lv-chip').lastChild.textContent = 'In review'; $('lv-term').textContent = 'blocked by lake-gate';
    $('lv-check').lastChild.textContent = 'lake/plan-approval · waiting for a teammate'; $('lv-approve').textContent = 'Approve v8f2c41d0';
  }
  function finalState() {
    reset(); live.classList.add('s1', 's3', 's4', 's5', 's7', 'done'); steps.forEach((s) => s.classList.add('on')); swapModels(); approved(); meter.style.width = '88%';
  }
  function swapModels() { $('lv-model').textContent = 'Lake pick per step'; steps.forEach((s) => { const m = s.querySelector('.m'); if (m.dataset.b !== m.dataset.a) { m.textContent = m.dataset.b; m.classList.add('swap'); } }); }
  function approved() {
    $('lv-chip').lastChild.textContent = 'Approved'; $('lv-term').textContent = 'allowed · plan v5c19e7a2 approved';
    $('lv-check').lastChild.textContent = 'lake/plan-approval · approved'; $('lv-approve').textContent = '✓ Approved';
  }
  function play() {
    reset();
    at(250, () => live.classList.add('s1'));
    steps.forEach((s, i) => at(900 + i * 520, () => { s.classList.add('on'); meter.style.width = `${sums[i]}%`; }));
    at(3300, () => live.classList.add('s3'));
    at(4700, () => live.classList.add('s4'));
    at(5500, () => pointTo(live.querySelector('.lw-apply')));
    at(6400, () => { live.classList.add('s5'); swapModels(); meter.style.width = '88%'; $('lv-approve').textContent = 'Approve v5c19e7a2'; });
    at(7600, () => pointTo($('lv-approve')));
    at(8500, () => live.classList.add('s6'));
    at(8700, () => { live.classList.remove('s6'); live.classList.add('s7'); approved(); });
    at(9600, () => { cursor.style.opacity = 0; live.classList.add('done'); });
  }
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  replay.addEventListener('click', () => (still ? finalState() : play()));
  if (still || !('IntersectionObserver' in window)) { finalState(); return; }
  reset();
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); play(); } }, { threshold: 0.35 });
  io.observe(live);
})();
