// Shared client code: API calls, the live run viewer (reads the NDJSON stream), and small renderers.
export const $ = id => document.getElementById(id);
export const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export const api = async (path, body) => {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  return r.json();
};
export const ICON = { pay: '💸', hold: '✋', walk: '🚪', join: '🤝', rule: '📜' };

export function nav(on) {
  const el = document.createElement('header'); el.className = 'top';
  const me = localStorage.getItem('pp-agent');
  el.innerHTML = `<a class="brand" href="/">Playable<span>Promise</span></a><nav>
    <a href="/" class="${on === 'back' ? 'on' : ''}">Back the game</a>
    ${me ? `<a href="/agent.html?id=${me}" class="${on === 'agent' ? 'on' : ''}">My agent</a>` : ''}
    <a href="/creator.html" class="${on === 'creator' ? 'on' : ''}">Creator</a>
    <a href="/try.html" class="${on === 'try' ? 'on' : ''}">Test any game</a></nav>`;
  document.body.prepend(el);
}

export function milestoneCards(ms, today) {
  return ms.map(m => `<div class="card ms"><span class="pill ${m.status}">${m.status}</span>
    <h3>M${m.n}: ${esc(m.title)}</h3><div class="sub">Promise: ${esc(m.test)}</div>
    <div style="margin-top:6px">$${m.amount} per backer · due ${m.due}${m.status !== 'verified' && m.due < today ? ' <b class="tamper">overdue</b>' : ''}</div></div>`).join('');
}

export function checksHtml(run) {
  if (!run?.ai) return run?.aiError ? `<div class="sub">AI judge offline: ${esc(run.aiError)}</div>` : '';
  return `<div class="checks">${run.ai.checks.map(c => `<div class="${c.met ? 'ok' : 'no'}">${c.met ? '✔' : '✘'} ${esc(c.look_for)} <span class="sub">— ${esc(c.why)}</span></div>`).join('')}</div>`
    + (run.tamper ? `<div class="tamper" style="margin-top:6px">Tamper alarm: the build said it passed. The screen said no.</div>` : '');
}

export function verdictHtml(run) {
  const cls = run.passed ? 'ok' : /On hold/.test(run.verdict) ? 'wait' : 'no';
  return `<div class="verdict ${cls}">${esc(run.verdict)}</div>`;
}

// Live viewer: screen + the pilot's thinking, fed by a streamed POST.
export async function liveRun(path, body, { screen, think, strip, onDone }) {
  screen.innerHTML = `<div class="tag"><span class="rec">●</span> agent is playing</div><img alt="Live view of the agent playing">`;
  const img = screen.querySelector('img');
  think.innerHTML = ''; if (strip) strip.innerHTML = '';
  const line = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; think.appendChild(d); think.scrollTop = think.scrollHeight; };
  const res = await fetch(path + '?stream=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) { const j = await res.json().catch(() => ({})); line('no', j.error || `Error ${res.status}`); screen.querySelector('.tag').textContent = 'stopped'; return onDone?.({ error: j.error }); }
  const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '', final = null;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 1); if (!raw.trim()) continue;
      const e = JSON.parse(raw);
      if (e.type === 'frame') {
        img.src = 'data:image/png;base64,' + e.png;
        if (strip) strip.insertAdjacentHTML('beforeend', `<figure><img src="data:image/png;base64,${e.png}" alt=""><figcaption>${esc(e.label)}</figcaption></figure>`);
      }
      else if (e.type === 'think') line('t', `turn ${e.turn} · sees: ${e.see}${e.me ? `\n  me: ${e.me}` : ''}${e.goal ? `\n  next: ${e.goal}` : ''}\n  ${e.done ? 'stops playing' : 'does: ' + e.plan.map(s => (s.keys.join('+') || 'wait') + ' ×' + s.frames).join(', ')}`);
      else if (e.type === 'log') line('', e.text);
      else if (e.type === 'verdict') line(e.passed ? 'ok' : 'no', e.verdict);
      else if (e.type === 'error') line('no', e.error);
      else if (e.type === 'done') final = e;
    }
  }
  screen.querySelector('.tag').innerHTML = final?.run?.passed ? '✔ promise kept' : '✘ not paid';
  onDone?.(final || { error: 'stream ended' });
}
