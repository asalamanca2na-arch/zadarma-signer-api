'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString('es-ES');
const pct = (a, b) => (b ? ((a / b) * 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' %' : '—');
const norm = (s) => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

let token = null;
try { token = sessionStorage.getItem('admin-token'); } catch {}
let datos = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const d = await res.json().catch(() => ({}));
  if (res.status === 401 && d.codigo === 'auth') { salir(); throw new Error('Sesión caducada'); }
  if (!res.ok) throw Object.assign(new Error(d.error || 'Error ' + res.status), { data: d });
  return d;
}
function show(id) { document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id)); }
function salir() { token = null; try { sessionStorage.removeItem('admin-token'); } catch {} show('s-login'); }
$('b-logout').addEventListener('click', salir);

$('f-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    token = (await api('/api/admin/login', { method: 'POST', body: { password: $('l-pass').value } })).token;
    try { sessionStorage.setItem('admin-token', token); } catch {}
    arrancar();
  } catch (err) { $('l-err').textContent = err.message; $('l-err').classList.remove('hidden'); }
});

document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== b.dataset.tab));
  $('filtros').classList.toggle('hidden', b.dataset.tab === 't-conf');
  if (b.dataset.tab === 't-conf') cargarConfig();
}));

// ---------- datos ----------
async function refrescar() {
  try { datos = await api('/api/admin/resumen'); pintar(); }
  catch (e) { $('p-upd').textContent = '⚠ ' + e.message; }
}
function filtradas() {
  const prov = $('f-prov').value, mun = norm($('f-mun').value);
  return datos.actas.filter((a) => (!prov || a.provincia === prov) && (!mun || norm(a.municipio) === mun));
}
function pintar() {
  const { config } = datos;
  $('p-eleccion').textContent = config.eleccion;
  $('p-upd').textContent = 'Actualizado ' + new Date(datos.actualizado).toLocaleTimeString('es-ES');
  $('b-csv').href = '/api/admin/export.csv?t=' + encodeURIComponent(token);

  // filtros
  const provs = ['Barcelona', 'Girona', 'Lleida', 'Tarragona'];
  if ($('f-prov').options.length === 1) provs.forEach((p) => $('f-prov').insertAdjacentHTML('beforeend', `<option>${p}</option>`));
  const muns = [...new Set(datos.actas.filter((a) => !$('f-prov').value || a.provincia === $('f-prov').value).map((a) => a.municipio))].sort();
  $('dl-mun').innerHTML = muns.map((m) => `<option value="${esc(m)}">`).join('');

  const L = filtradas();
  const t = { censo: 0, votantes: 0, nulos: 0, blancos: 0, validos: 0, inc: 0, votos: {} };
  config.partidos.forEach((p) => (t.votos[p.id] = 0));
  for (const a of L) {
    t.censo += a.censo; t.votantes += a.votantes; t.nulos += a.nulos; t.blancos += a.blancos; t.validos += a.validos;
    if (a.incidencia && !a.revisada) t.inc++;
    config.partidos.forEach((p) => (t.votos[p.id] += a.votos[p.id] || 0));
  }
  const filtro = $('f-prov').value || $('f-mun').value;
  const mesasTot = filtro ? datos.municipios.filter((m) => (!$('f-prov').value || m.provincia === $('f-prov').value) && (!$('f-mun').value || norm(m.municipio) === norm($('f-mun').value))).reduce((s, m) => s + m.mesasTotal, 0) : datos.totales.mesasTotal;

  $('kpis').innerHTML = [
    [fmt(L.length) + (mesasTot ? ` <span class="muted" style="font-size:1rem">/ ${fmt(mesasTot)}</span>` : ''), 'Actas recibidas' + (mesasTot ? ' · ' + pct(L.length, mesasTot) + ' escrutado' : '')],
    [pct(t.votantes, t.censo), 'Participación en esas mesas'],
    [fmt(t.votantes), 'Votantes'],
    [fmt(t.nulos) + ' / ' + fmt(t.blancos), 'Nulos / Blancos'],
    [fmt(t.inc), 'Incidencias sin revisar', t.inc > 0],
  ].map(([v, l, al]) => `<div class="kpi${al ? ' alert' : ''}"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
  $('tab-inc').textContent = datos.totales.incidencias ? `(${datos.totales.incidencias})` : '';

  const orden = [...config.partidos].sort((a, b) => t.votos[b.id] - t.votos[a.id]);
  const max = Math.max(1, ...orden.map((p) => t.votos[p.id]));
  $('bars').innerHTML = orden.map((p) => `<div class="bar"><div class="party"><span class="dot" style="background:${esc(p.color)}"></span><b>${esc(p.nombre)}</b></div>
    <div class="track"><div class="fill" style="width:${(t.votos[p.id] / max) * 100}%;background:${esc(p.color)}"></div></div>
    <div class="num"><b>${pct(t.votos[p.id], t.validos)}</b> · ${fmt(t.votos[p.id])}</div></div>`).join('') || '<p class="muted">Sin datos todavía.</p>';

  // por municipio
  const ms = {};
  for (const a of L) {
    const k = a.provincia + '|' + a.municipio;
    const m = ms[k] ||= { provincia: a.provincia, municipio: a.municipio, actas: 0, censo: 0, votantes: 0, validos: 0, votos: {} };
    m.actas++; m.censo += a.censo; m.votantes += a.votantes; m.validos += a.validos;
    config.partidos.forEach((p) => (m.votos[p.id] = (m.votos[p.id] || 0) + (a.votos[p.id] || 0)));
  }
  const totMesas = Object.fromEntries(datos.municipios.map((m) => [m.provincia + '|' + m.municipio, m.mesasTotal]));
  $('t-mun').innerHTML = `<thead><tr><th>Municipio</th><th class="n">Actas</th><th class="n">Particip.</th>${config.partidos.map((p) => `<th class="n">${esc(p.nombre)}</th>`).join('')}</tr></thead><tbody>` +
    Object.values(ms).sort((a, b) => b.votantes - a.votantes).map((m) => `<tr data-mun="${esc(m.municipio)}" data-prov="${esc(m.provincia)}"><td><b>${esc(m.municipio)}</b> <span class="muted">${esc(m.provincia)}</span></td>
      <td class="n">${m.actas}${totMesas[m.provincia + '|' + m.municipio] ? ' / ' + totMesas[m.provincia + '|' + m.municipio] : ''}</td><td class="n">${pct(m.votantes, m.censo)}</td>
      ${config.partidos.map((p) => `<td class="n">${fmt(m.votos[p.id])}<br><span class="muted">${pct(m.votos[p.id], m.validos)}</span></td>`).join('')}</tr>`).join('') + '</tbody>';
  $('t-mun').querySelectorAll('tr[data-mun]').forEach((tr) => tr.addEventListener('click', () => { $('f-prov').value = tr.dataset.prov; $('f-mun').value = tr.dataset.mun; pintar(); }));

  pintarActas(L);
}

function pintarActas(L) {
  const q = norm($('f-q').value);
  const soloInc = $('f-inc').checked;
  const filas = L.filter((a) => (!soloInc || (a.incidencia && !a.revisada)) &&
    (!q || norm([a.municipio, a.colegio, a.distrito, a.seccion, a.mesa, a.enviadoPor?.nombre].join(' ')).includes(q)));
  $('t-act').innerHTML = `<thead><tr><th>Estado</th><th>Municipio</th><th>Colegio</th><th>Dist.</th><th>Secc.</th><th>Mesa</th><th class="n">Votantes</th><th>Avisos</th><th>Apoderado</th><th>Hora</th></tr></thead><tbody>` +
    filas.map((a) => `<tr data-id="${esc(a.id)}"><td>${a.revisada ? '<span class="pill ok">Revisada</span>' : a.incidencia ? '<span class="pill bad">Incidencia</span>' : '<span class="pill ok">OK</span>'}</td>
      <td>${esc(a.municipio)}</td><td style="white-space:normal;min-width:140px">${esc(a.colegio)}</td><td>${esc(a.distrito)}</td><td>${esc(a.seccion)}</td><td>${esc(a.mesa)}</td><td class="n">${fmt(a.votantes)}</td>
      <td style="white-space:normal;min-width:180px">${esc((a.avisos || []).join(' · '))}${a.foto ? '' : ' <span class="pill wait">Sin foto</span>'}</td>
      <td>${esc(a.enviadoPor?.nombre || 'Sin nombre')}</td>
      <td>${new Date(a.recibido).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</td></tr>`).join('') +
    (filas.length ? '' : '<tr><td colspan="10" class="muted">No hay actas.</td></tr>') + '</tbody>';
  $('t-act').querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => verActa(tr.dataset.id)));
}
['f-prov', 'f-mun'].forEach((id) => $(id).addEventListener('input', () => datos && pintar()));
['f-q', 'f-inc'].forEach((id) => $(id).addEventListener('input', () => datos && pintarActas(filtradas())));

// ---------- detalle de acta ----------
function tablaVotos(a, partidos) {
  const filas = [['Electores (censo)', a.censo], ['Votantes', a.votantes], ['Nulos', a.nulos], ['Blancos', a.blancos], ...partidos.map((p) => [p.nombre, a.votos?.[p.id] ?? 0])];
  return `<table>${filas.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n"><b>${fmt(v)}</b></td></tr>`).join('')}</table>`;
}
async function verActa(id) {
  const a = await api('/api/admin/acta?id=' + encodeURIComponent(id));
  const P = datos.config.partidos;
  const box = $('modal-box');
  box.innerHTML = `<div class="topbar"><div class="title"><h2 style="margin:0">${esc(a.municipio)} · ${esc(a.colegio)} · Dist. ${esc(a.distrito)} · Secc. ${esc(a.seccion)} · Mesa ${esc(a.mesa)}</h2></div><button class="btn ghost small" id="m-close">✕</button></div>
    <div class="detail">
      <div>${a.foto ? `<a href="/api/admin/foto?f=${encodeURIComponent(a.foto)}&t=${encodeURIComponent(token)}" target="_blank"><img src="/api/admin/foto?f=${encodeURIComponent(a.foto)}&t=${encodeURIComponent(token)}" alt="Acta"></a><p class="muted">Pulsa la foto para abrirla en grande.</p>` : '<p class="warn">Enviada sin foto.</p>'}</div>
      <div>
        <div class="status ${a.cuadra ? 'ok' : 'bad'}">${a.cuadra ? '✓ Los votos cuadran' : '⚠ ' + (a.diferencia > 0 ? `Faltan ${a.diferencia} votos` : `Sobran ${-a.diferencia} votos`)}</div>
        ${(a.avisos || []).length ? `<p class="warn" style="margin-top:10px">${a.avisos.map(esc).join('<br>')}</p>` : ''}
        ${a.observaciones ? `<p><b>Observaciones:</b> ${esc(a.observaciones)}</p>` : ''}
        ${tablaVotos(a, P)}
        <p class="muted">Enviada por ${esc(a.enviadoPor?.nombre || 'Sin nombre')} · ${new Date(a.recibido).toLocaleString('es-ES')}</p>
        ${(a.historial || []).length ? `<details><summary><b>${a.historial.length} versión(es) anterior(es)</b></summary>${a.historial.map((h) => `<div class="card" style="background:#f6f8fb"><div class="muted">${esc(h.enviadoPor?.nombre)} · ${new Date(h.recibido).toLocaleString('es-ES')}</div>${tablaVotos(h, P)}</div>`).join('')}</details>` : ''}
        <div style="height:10px"></div>
        <button class="btn ${a.revisada ? 'secondary' : ''}" id="m-rev">${a.revisada ? 'Quitar marca de revisada' : '✓ Marcar como revisada'}</button>
      </div>
    </div>`;
  $('modal').classList.add('open');
  $('m-close').onclick = () => $('modal').classList.remove('open');
  $('m-rev').onclick = async () => {
    await api('/api/admin/acta/revisada', { method: 'POST', body: { id: a.id, revisada: !a.revisada } });
    $('modal').classList.remove('open'); refrescar();
  };
}
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('modal').classList.remove('open'); });

// ---------- configuración ----------
async function cargarConfig() {
  const c = await api('/api/admin/config');
  $('c-eleccion').value = c.config.eleccion;
  $('c-partidos').value = c.config.partidos.map((p) => `${p.nombre};${p.color}` + (p.orden && Object.keys(p.orden).length ? ';' + Object.entries(p.orden).map(([k, v]) => k + ':' + v).join(',') : '')).join('\n');
  $('c-nmesas').textContent = c.mesas ? `(${fmt(c.mesas)} mesas cargadas)` : '(no cargado)';
}
$('b-conf').addEventListener('click', async () => {
  const partidos = $('c-partidos').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [nombre, color, provs] = l.split(';').map((x) => x.trim());
    const previo = datos?.config.partidos.find((p) => p.nombre === nombre);
    const orden = {};
    (provs || '').split(',').map((x) => x.trim()).filter(Boolean).forEach((x) => { const [pr, num] = x.split(':'); orden[pr.trim()] = Number(num) || 99; });
    return { id: previo?.id || nombre, nombre, color, orden };
  });
  try {
    await api('/api/admin/config', { method: 'PUT', body: { eleccion: $('c-eleccion').value, partidos } });
    $('c-msg').textContent = '✓ Guardado'; refrescar();
  } catch (e) { $('c-msg').textContent = '⚠ ' + e.message; }
});
async function subirCSV(fileId, url, msgId, extra = {}) {
  const f = $(fileId).files[0];
  if (!f) { $(msgId).textContent = 'Elige un fichero CSV.'; return; }
  try {
    const r = await api(url, { method: 'PUT', body: { csv: await f.text(), ...extra } });
    $(msgId).textContent = `✓ ${fmt(r.total)} cargados` + (r.errores?.length ? ` · ${r.errores.length} filas con errores: ${r.errores.slice(0, 3).join('; ')}` : '');
    cargarConfig(); refrescar();
  } catch (e) { $(msgId).textContent = '⚠ ' + e.message + (e.data?.errores?.length ? ' — ' + e.data.errores.slice(0, 3).join('; ') : ''); }
}
$('b-mesas').addEventListener('click', () => subirCSV('c-mesas-file', '/api/admin/mesas', 'c-mesas-msg'));

// ---------- arranque ----------
let timer = null;
function arrancar() {
  show('s-panel'); refrescar();
  clearInterval(timer); timer = setInterval(refrescar, 15000);
}
if (token) arrancar(); else show('s-login');
