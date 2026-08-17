/* KlickPint — shared UI behaviour (theme, nav, toast) */
'use strict';

/* ── Theme ─────────────────────────────────────────────────────────────
   The initial theme is applied by a tiny inline script in <head> so there
   is no flash. Here we only wire up the toggle. */
(function theme() {
  const root = document.documentElement;
  const btn  = document.querySelector('.theme-btn');
  if (!btn) return;

  const sync = () => {
    const dark = root.getAttribute('data-theme') === 'dark';
    btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.setAttribute('aria-pressed', String(dark));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#07070A' : '#FFFFFF');
  };

  btn.addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('kp-theme', next); } catch (_) {}
    sync();
  });

  sync();
})();

/* ── Mobile nav ────────────────────────────────────────────────────────── */
(function nav() {
  const toggle = document.querySelector('.nav-toggle');
  const drawer = document.getElementById('navDrawer');
  if (!toggle || !drawer) return;

  const setOpen = (open) => {
    drawer.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };

  toggle.addEventListener('click', () => setOpen(!drawer.classList.contains('open')));
  drawer.addEventListener('click', (e) => { if (e.target.tagName === 'A') setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  window.addEventListener('resize', () => { if (window.innerWidth > 768) setOpen(false); });
})();

/* ── Sticky nav shadow ─────────────────────────────────────────────────── */
(function stickyNav() {
  const el = document.querySelector('.nav');
  if (!el) return;
  const onScroll = () => el.classList.toggle('is-stuck', window.scrollY > 4);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
})();

/* ── Toast ─────────────────────────────────────────────────────────────── */
window.toast = function toast(msg, type) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 3200);
};

/* ── Footer year ───────────────────────────────────────────────────────── */
document.querySelectorAll('[data-year]').forEach((el) => {
  el.textContent = String(new Date().getFullYear());
});
