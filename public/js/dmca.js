/* KlickPint — DMCA takedown form. Sends the notice through the contact
   endpoint (topic "copyright"), so it is emailed to support and kept in the
   admin inbox like any other message. */
'use strict';

(function dmcaForm() {
  const form = document.getElementById('dmcaForm');
  if (!form) return;

  const $ = (id) => document.getElementById(id);
  const started = Date.now();          // the server ignores forms sent in under 3 seconds
  const submit = form.querySelector('.btn-submit');

  const status = document.createElement('div');
  status.className = 'cf-status';
  status.setAttribute('role', 'alert');
  form.prepend(status);

  // Hidden honeypot field, same as the contact form.
  const hp = document.createElement('div');
  hp.className = 'cf-hp';
  hp.setAttribute('aria-hidden', 'true');
  hp.innerHTML = '<label for="dmcaWebsite">Website</label><input id="dmcaWebsite" type="text" tabindex="-1" autocomplete="off">';
  form.appendChild(hp);

  function fail(msg, field) {
    status.textContent = msg;
    status.classList.add('show');
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.classList.remove('show');

    const v = (id) => $(id).value.trim();
    const name = v('fname'), email = v('femail'), work = v('fwork'), urls = v('furls');
    if (!name) return fail('Please enter your full legal name.', $('fname'));
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return fail('Please enter a valid email address.', $('femail'));
    if (!work) return fail('Please describe the copyrighted work.', $('fwork'));
    if (!/(pinterest\.[a-z.]+|pin\.it)\//i.test(urls)) return fail('Please list at least one Pinterest link (pinterest.com/pin/… or pin.it/…).', $('furls'));
    if (!$('chk1').checked || !$('chk2').checked) return fail('Both statements must be confirmed for a valid notice.', $('chk1').checked ? $('chk2') : $('chk1'));

    const message = [
      'DMCA TAKEDOWN NOTICE',
      `Name (signature): ${name}`,
      `Email: ${email}`,
      v('forg') ? `Organization: ${v('forg')}` : null,
      v('fphone') ? `Phone: ${v('fphone')}` : null,
      '',
      `Copyrighted work: ${work}`,
      '',
      'Infringing Pinterest URL(s):',
      urls,
      v('fdetails') ? `\nAdditional details:\n${v('fdetails')}` : null,
      '',
      '[x] Good-faith belief that the use is not authorized by the copyright owner, its agent, or the law.',
      '[x] Under penalty of perjury, the information is accurate and the sender is the owner or authorized to act for the owner.',
    ].filter((l) => l !== null).join('\n');

    if (message.length > 3000) return fail('The notice is too long. Please shorten the URL list or details, or email support@klickpint.online.', $('fdetails'));

    submit.disabled = true;
    const label = submit.textContent;
    submit.textContent = 'Sending…';
    try {
      const wait = 3200 - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const firstUrl = (urls.match(/https?:\/\/\S+/) || [''])[0];
      const res = await fetch('/api/contact', {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({ name, email, topic: 'copyright', pin: firstUrl, message, website: $('dmcaWebsite').value, t: started }),
      });
      let json = {};
      try { json = await res.json(); } catch (_) {}
      if (!res.ok || !json.success) return fail(json.error || 'The notice could not be sent. Please email support@klickpint.online instead.');

      form.innerHTML = '<div class="cf-done show" role="status"><h2>Notice received</h2>'
        + '<p>Thank you. Your notice has been sent to our support inbox. We review notices within 2–5 business days and will reply to <strong></strong>.</p></div>';
      form.querySelector('strong').textContent = email;
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (_) {
      fail('Could not reach the server. Check your connection, or email support@klickpint.online.');
    } finally {
      if (submit.isConnected) { submit.disabled = false; submit.textContent = label; }
    }
  });
})();
