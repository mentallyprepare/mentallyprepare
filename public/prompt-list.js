// One prompt a week — the blog's capture form.
//
// Posts to /api/prompt-subscribe and never sends the address anywhere else:
// no analytics, no query string, no local storage. The server answers the same
// way for a new address and one it already knows, so the form cannot be used
// to find out who is on the list.
(function () {
  'use strict';

  var FORMS = '.prompt-list-form';

  function statusFor(form) {
    var section = form.closest ? form.closest('.prompt-list-signup') : null;
    return section ? section.querySelector('[data-mp-prompt-list-status]') : null;
  }

  function say(form, message, isError) {
    var el = statusFor(form);
    if (!el) return;
    el.textContent = message;
    el.style.color = isError ? '#F0A9A9' : '#B9E3C6';
  }

  function handle(form) {
    if (form.dataset.bound === '1') return;
    form.dataset.bound = '1';
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var input = form.querySelector('input[type="email"]');
      var button = form.querySelector('button[type="submit"]');
      var email = input ? input.value.trim() : '';
      if (!email || email.indexOf('@') < 1) {
        say(form, 'Check the email address and try again.', true);
        if (input) input.focus();
        return;
      }
      if (button) { button.disabled = true; button.textContent = 'Adding you…'; }
      say(form, '', false);

      fetch('/api/prompt-subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email: email, source: form.dataset.source || 'blog' })
      }).then(function (res) {
        if (!res.ok) throw new Error('rejected');
        return res.json();
      }).then(function () {
        form.reset();
        if (button) button.textContent = 'You are on the list';
        say(form, 'Done. One prompt, every Sunday night. Unsubscribe in one click.', false);
      }).catch(function () {
        if (button) { button.disabled = false; button.textContent = 'Send me the prompts'; }
        say(form, 'That did not save. Try again in a moment.', true);
      });
    });
  }

  function start() {
    var forms = document.querySelectorAll(FORMS);
    for (var i = 0; i < forms.length; i += 1) handle(forms[i]);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
