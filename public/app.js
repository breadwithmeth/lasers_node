const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const devicesEl = document.getElementById('devices');
const deviceInput = document.getElementById('device');

// Optional: set your Bearer token here for admin endpoints
const AUTH_TOKEN = '';

function log(line) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent += `[${ts}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

async function api(path, opts={}){
  const headers = opts.headers || {};
  if (AUTH_TOKEN) headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  const res = await fetch(path, { ...opts, headers });
  return res;
}

async function refreshDevices(){
  try{
    const r = await api('/api/v1/devices');
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    const rows = j.devices
      .sort((a,b)=>b.lastSeenAt - a.lastSeenAt)
      .map(d=>`<code>${d.id}</code> — lastSeen: ${d.lastSeenAt?new Date(d.lastSeenAt).toLocaleString():'—'} · queue: ${d.queueLen}`)
      .join('<br>');
    devicesEl.innerHTML = rows || '<em>Пока пусто. Устройство появится после первого poll.</em>';
    statusEl.textContent = 'OK';
  } catch(e){
    statusEl.textContent = 'Ошибка устройств';
  }
}

document.getElementById('refresh').addEventListener('click', refreshDevices);

async function sendCmd(event){
  const action = event.target.getAttribute('data-action');
  if (!action) return;
  const dev = deviceInput.value.trim();
  if (!dev) { alert('Укажите Device ID'); return; }

  /** build payload by action **/
  let payload = null;
  if (action === 'off') payload = { cmd: 'OFF' };
  if (action === 'scene') {
    const n = document.getElementById('sceneN').value.trim();
    const a = document.getElementById('sceneArgs').value.trim();
    payload = { cmd: 'SCENE', args: `${n}${a?(' '+a):''}` };
  }
  if (action === 'w')    payload = { cmd: 'W',    val: +document.getElementById('wVal').value };
  if (action === 'wmin') payload = { cmd: 'WMIN', val: +document.getElementById('wMin').value };
  if (action === 'wmax') payload = { cmd: 'WMAX', val: +document.getElementById('wMax').value };
  if (action === 'uno')  payload = { cmd: 'UNO',  raw: document.getElementById('unoRaw').value };
  if (action === 'call') payload = { cmd: 'CALL', num: document.getElementById('phone').value };
  if (action === 'hang') payload = { cmd: 'HANG' };
  if (action === 'sim_on') payload = { cmd: 'SIM_ON' };
  if (action === 'sim_toggle') payload = { cmd: 'SIM_TOGGLE', pulse_ms: +document.getElementById('pulse').value };

  try{
    const r = await api(`/api/v1/cmd?device=${encodeURIComponent(dev)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || r.statusText);
    log(`→ ${dev}: ${JSON.stringify(payload)}`);
  }catch(e){
    log(`× Ошибка: ${e.message}`);
  }
}

document.body.addEventListener('click', sendCmd);
refreshDevices();