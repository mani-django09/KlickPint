/* KlickPint — contact form */
'use strict';

(function contactForm() {
  const form = document.getElementById('contactForm');
  if (!form) return;

  const $       = (id) => document.getElementById(id);
  const status  = $('cfStatus');
  const submit  = $('cfSubmit');
  const message = $('cfMessage');
  const email   = $('cfEmail');
  const topic   = $('cfTopic');
  const pinFld  = $('cfPinField');
  const started = Date.now();   // the server ignores forms sent in under 3 seconds (bots)

  // /contact.html?topic=copyright pre-selects a topic (the DMCA page links here).
  const pre = new URLSearchParams(location.search).get('topic');
  if (pre && topic.querySelector(`option[value="${CSS.escape(pre)}"]`)) topic.value = pre;

  // The pin link only matters for download and copyright questions.
  const syncPin = () => { pinFld.style.display = (topic.value === 'help' || topic.value === 'copyright') ? '' : 'none'; };
  topic.addEventListener('change', syncPin);
  syncPin();

  const count = () => { $('cfCount').textContent = `${message.value.length} / 3000`; };
  message.addEventListener('input', count);
  count();

  function showError(msg, field) {
    status.textContent = msg;
    status.classList.add('show');
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.classList.remove('show');

    const data = {
      name   : $('cfName').value.trim(),
      email  : email.value.trim(),
      topic  : topic.value,
      pin    : pinFld.style.display === 'none' ? '' : $('cfPin').value.trim(),
      message: message.value.trim(),
      website: $('cfWebsite').value,
      t      : started,
    };

    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(data.email)) return showError('Please enter a valid email address so we can reply.', email);
    if (data.message.length < 10) return showError('Please write a little more so we can help (at least 10 characters).', message);

    submit.disabled = true;
    submit.textContent = 'Sending…';
    try {
      // Wait out the anti-bot minimum if someone is very quick.
      const wait = 3200 - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));

      const res = await fetch('/api/contact', {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify(data),
      });
      let json = {};
      try { json = await res.json(); } catch (_) {}

      if (res.status === 413) return showError('Your message is too long. Please shorten it and try again.', message);
      if (!res.ok || !json.success) {
        const field = json.code === 'BAD_EMAIL' ? email : json.code === 'SHORT_MESSAGE' ? message : null;
        return showError(json.error || 'Your message could not be sent. Please email support@klickpint.online instead.', field);
      }

      $('cfDoneEmail').textContent = data.email;
      form.style.display = 'none';
      $('cfDone').classList.add('show');
      $('cfDone').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (_) {
      showError('Could not reach the server. Check your connection, or email support@klickpint.online.');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Send message';
    }
  });
})();
