// Visit counting: GoatCounter (free, cookieless, no personal data). Set your site code below; until then nothing loads.
const GOATCOUNTER_CODE = 'GOATCOUNTER_CODE';
if (!/^GOATCOUNTER_/.test(GOATCOUNTER_CODE) && !/^(localhost|127\.)/.test(location.hostname)) {
  const s = document.createElement('script');
  s.async = true; s.src = 'https://gc.zgo.at/count.js';
  s.dataset.goatcounter = `https://${GOATCOUNTER_CODE}.goatcounter.com/count`;
  document.head.appendChild(s);
}
const track = (name) => { if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: name, title: name, event: true }); };
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-track]'); if (t) track(t.dataset.track);
  const c = e.target.closest('[data-copy]');
  if (c) {
    navigator.clipboard?.writeText(c.dataset.copy).then(() => {
      const label = c.querySelector('span'); label.textContent = 'Copied'; track('copy-install');
      setTimeout(() => { label.textContent = 'Copy'; }, 1600);
    }).catch(() => {});
  }
});
