// Lightweight transient notifications + actionable prompts (e.g. the
// "source file changed — update?" banner).
function host() {
  let h = document.getElementById('toast-host');
  if (!h) { h = document.createElement('div'); h.id = 'toast-host'; document.body.appendChild(h); }
  return h;
}

export function toast(message, { timeout = 2600 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${message}</span>`;
  host().appendChild(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}

// A toast with buttons. actions: [{label, primary?, onClick}]. Resolves and
// removes itself when an action is chosen.
export function prompt(message, actions) {
  const el = document.createElement('div');
  el.className = 'toast';
  const span = document.createElement('span'); span.textContent = message;
  const box = document.createElement('div'); box.className = 'toast-actions';
  el.appendChild(span); el.appendChild(box);
  for (const a of actions) {
    const b = document.createElement('button');
    b.textContent = a.label; if (a.primary) b.classList.add('primary');
    b.onclick = () => { el.remove(); a.onClick && a.onClick(); };
    box.appendChild(b);
  }
  host().appendChild(el);
  return el;
}
