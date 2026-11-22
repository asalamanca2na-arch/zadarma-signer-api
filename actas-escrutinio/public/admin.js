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
let publica = null; // municipios, secciones y letras de mesa (lo mismo que ve la app de los apoderados)
async function refrescar() {
  try {
    if (!publica) publica = await api('/api/config');
    datos = await api('/api/admin/resumen'); pintar();
  }
  catch (e) { $('p-upd').textContent = '⚠ ' + e.message; }
}
// Congreso o Senado: todo el panel (resultados, actas y exportación) muestra un solo tipo de acta.
let tipo = 'congreso';
document.querySelectorAll('[data-tipo]').forEach((b) => b.addEventListener('click', () => {
  tipo = b.dataset.tipo;
  document.querySelectorAll('[data-tipo]').forEach((x) => x.classList.toggle('on', x === b));
  if (datos) pintar();
}));
const tipoDe = (a) => (a.tipo === 'senado' ? 'senado' : 'congreso');
function filtradas() {
  const prov = $('f-prov').value, mun = norm($('f-mun').value);
  return datos.actas.filter((a) => tipoDe(a) === tipo && (!prov || a.provincia === prov) && (!mun || norm(a.municipio) === mun));
}
// Lo que se vota: candidaturas (Congreso) o candidatos de cada provincia (Senado).
function claves(config, prov) {
  if (tipo === 'senado') return (prov ? [prov] : Object.keys(config.senado || {})).flatMap((p) => (config.senado[p] || []).map((c) => ({ ...c, provincia: p, etiqueta: c.nombre, sub: c.partido })));
  return config.partidos.map((p) => ({ ...p, etiqueta: p.nombre, sub: '' }));
}
function pintar() {
  const { config } = datos;
  $('p-eleccion').textContent = config.eleccion;
  $('p-upd').textContent = 'Actualizado ' + new Date(datos.actualizado).toLocaleTimeString('es-ES');
  $('b-csv').href = `/api/admin/export.csv?tipo=${tipo}&t=` + encodeURIComponent(token);
  $('b-csv').textContent = `⬇ Exportar CSV (${tipo === 'senado' ? 'Senado' : 'Congreso'})`;

  // filtros
  const provs = ['Barcelona', 'Girona', 'Lleida', 'Tarragona'];
  if ($('f-prov').options.length === 1) provs.forEach((p) => $('f-prov').insertAdjacentHTML('beforeend', `<option>${p}</option>`));
  const K = claves(config, $('f-prov').value);
  const muns = $('f-prov').value ? publica.municipios[$('f-prov').value] || [] : [...new Set(datos.actas.map((a) => a.municipio))].sort();
  $('dl-mun').innerHTML = muns.map((m) => `<option value="${esc(m)}">`).join('');

  const L = filtradas();
  const t = { censo: 0, votantes: 0, nulos: 0, blancos: 0, validos: 0, inc: 0, votos: {} };
  K.forEach((p) => (t.votos[p.id] = 0));
  for (const a of L) {
    t.censo += a.censo; t.votantes += a.votantes; t.nulos += a.nulos; t.blancos += a.blancos; t.validos += a.validos;
    if (a.incidencia && !a.revisada) t.inc++;
    K.forEach((p) => (t.votos[p.id] += a.votos[p.id] || 0));
  }
  const filtro = $('f-prov').value || $('f-mun').value;
  const mesasTot = filtro ? datos.municipios.filter((m) => (!$('f-prov').value || m.provincia === $('f-prov').value) && (!$('f-mun').value || norm(m.municipio) === norm($('f-mun').value))).reduce((s, m) => s + m.mesasTotal, 0) : datos.totales.mesasTotal;

  $('kpis').innerHTML = [
    [fmt(L.length) + (mesasTot ? ` <span class="muted" style="font-size:1rem">/ ${fmt(mesasTot)}</span>` : ''), 'Actas recibidas' + (mesasTot ? ' · ' + pct(L.length, mesasTot) + ' escrutado' : '')],
    [pct(t.votantes, t.censo), 'Participación en esas mesas'],
    [fmt(t.votantes), 'Votantes'],
    [fmt(t.nulos) + ' / ' + fmt(t.blancos), tipo === 'senado' ? 'Papeletas nulas / en blanco' : 'Nulos / Blancos'],
    [fmt(t.inc), 'Incidencias sin revisar', t.inc > 0],
  ].map(([v, l, al]) => `<div class="kpi${al ? ' alert' : ''}"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
  $('tab-inc').textContent = datos.totales.incidencias ? `(${datos.totales.incidencias})` : '';

  const barra = (p, max, total, extra = '') => `<div class="bar"><div class="party"><span class="dot" style="background:${esc(p.color)}"></span><div><b>${esc(p.etiqueta)}</b>${p.sub ? `<br><span class="muted" style="font-size:.8rem">${esc(p.sub)}</span>` : ''}${extra}</div></div>
    <div class="track"><div class="fill" style="width:${(t.votos[p.id] / max) * 100}%;background:${esc(p.color)}"></div></div>
    <div class="num">${total ? `<b>${pct(t.votos[p.id], total)}</b> · ` : ''}${fmt(t.votos[p.id])}</div></div>`;
  if (tipo === 'senado') {
    // Cada provincia elige 4 senadores: los 4 candidatos más votados (resultado provisional con las actas recibidas).
    $('h-bars').innerHTML = 'Votos a candidatos al Senado <span class="muted" style="font-weight:400">· los 4 más votados de cada provincia salen elegidos</span>';
    const provs = $('f-prov').value ? [$('f-prov').value] : Object.keys(config.senado || {});
    $('bars').innerHTML = provs.map((pr) => {
      const lista = K.filter((c) => c.provincia === pr).sort((a, b) => t.votos[b.id] - t.votos[a.id]);
      const max = Math.max(1, ...lista.map((c) => t.votos[c.id]));
      const hay = lista.some((c) => t.votos[c.id] > 0);
      return `<h3 style="margin:14px 0 6px">${esc(pr)}</h3>` + lista.map((c, i) => barra(c, max, 0, hay && i < 4 ? ' <span class="pill ok">Escaño</span>' : '')).join('');
    }).join('');
  } else {
    $('h-bars').innerHTML = 'Votos por candidatura <span class="muted" style="font-weight:400">· % sobre votos válidos (incluye blancos)</span>';
    const orden = [...K].sort((a, b) => t.votos[b.id] - t.votos[a.id]);
    const max = Math.max(1, ...orden.map((p) => t.votos[p.id]));
    $('bars').innerHTML = orden.map((p) => barra(p, max, t.validos)).join('') || '<p class="muted">Sin datos todavía.</p>';
  }

  // por municipio
  const ms = {};
  for (const a of L) {
    const k = a.provincia + '|' + a.municipio;
    const m = ms[k] ||= { provincia: a.provincia, municipio: a.municipio, actas: 0, censo: 0, votantes: 0, validos: 0, votos: {} };
    m.actas++; m.censo += a.censo; m.votantes += a.votantes; m.validos += a.validos;
    K.forEach((p) => (m.votos[p.id] = (m.votos[p.id] || 0) + (a.votos[p.id] || 0)));
  }
  const totMesas = Object.fromEntries(datos.municipios.map((m) => [m.provincia + '|' + m.municipio, m.mesasTotal]));
  // Columnas: PP primero y después el resto por votos; las candidaturas sin votos no se muestran.
  // En el Senado la tabla solo muestra actas y participación (hay demasiados candidatos).
  const KM = tipo === 'senado' ? [] : K.filter((p) => p.id === 'pp' || t.votos[p.id] > 0)
    .sort((a, b) => (b.id === 'pp') - (a.id === 'pp') || t.votos[b.id] - t.votos[a.id]);
  $('t-mun').innerHTML = `<thead><tr><th>Municipio</th><th class="n">Actas</th><th class="n">Particip.</th>${KM.map((p) => `<th class="n">${esc(p.nombre)}</th>`).join('')}</tr></thead><tbody>` +
    Object.values(ms).sort((a, b) => b.votantes - a.votantes).map((m) => `<tr data-mun="${esc(m.municipio)}" data-prov="${esc(m.provincia)}"><td><b>${esc(m.municipio)}</b> <span class="muted">${esc(m.provincia)}</span></td>
      <td class="n">${m.actas}${totMesas[m.provincia + '|' + m.municipio] ? ' / ' + totMesas[m.provincia + '|' + m.municipio] : ''}</td><td class="n">${pct(m.votantes, m.censo)}</td>
      ${KM.map((p) => `<td class="n">${fmt(m.votos[p.id])}<br><span class="muted">${pct(m.votos[p.id], m.validos)}</span></td>`).join('')}</tr>`).join('') + '</tbody>';
  $('t-mun').querySelectorAll('tr[data-mun]').forEach((tr) => tr.addEventListener('click', () => { $('f-prov').value = tr.dataset.prov; $('f-mun').value = tr.dataset.mun; pintar(); }));

  pintarEscanos(config);
  pintarActas(L);
  pintarPendientes(L);
}

// ---------- proyección de escaños del Congreso (D'Hondt, mínimo 3 % de votos válidos por provincia) ----------
const ESCANOS = { Barcelona: 32, Girona: 6, Lleida: 4, Tarragona: 6 }; // diputados por provincia (listas del BOE 29-N-2026)
function dhondt(votos, validos, escanos) {
  const ids = Object.keys(votos).filter((id) => votos[id] > 0 && votos[id] >= 0.03 * validos);
  const res = Object.fromEntries(ids.map((id) => [id, 0]));
  for (let i = 0; i < escanos && ids.length; i++) {
    const g = ids.reduce((m, id) => (votos[id] / (res[id] + 1) > votos[m] / (res[m] + 1) || (votos[id] / (res[id] + 1) === votos[m] / (res[m] + 1) && votos[id] > votos[m]) ? id : m), ids[0]);
    res[g]++;
  }
  return res;
}
function pintarEscanos(config) {
  if (tipo === 'senado') return pintarEscanosSenado(config);
  $('h-escanos').innerHTML = `Proyección de escaños · Congreso <span class="muted" style="font-weight:400">· D'Hondt con mínimo del 3 %, solo con las actas recibidas</span>`;
  const provs = $('f-prov').value ? [$('f-prov').value] : Object.keys(ESCANOS);
  const total = {};
  const chips = (r) => config.partidos.filter((p) => r[p.id] > 0).sort((a, b) => r[b.id] - r[a.id] || (b.id === 'pp') - (a.id === 'pp'))
    .map((p) => `<span class="esc" style="--c:${esc(p.color)}"><b>${r[p.id]}</b> ${esc(p.nombre)}</span>`).join('') || '<span class="muted">Sin actas todavía</span>';
  const filas = provs.map((pr) => {
    const A = datos.actas.filter((a) => tipoDe(a) === 'congreso' && a.provincia === pr);
    const votos = {}; let validos = 0;
    for (const a of A) { validos += a.validos; for (const p of config.partidos) votos[p.id] = (votos[p.id] || 0) + (a.votos[p.id] || 0); }
    const r = A.length ? dhondt(votos, validos, ESCANOS[pr]) : {};
    for (const id in r) total[id] = (total[id] || 0) + r[id];
    return `<tr><td><b>${esc(pr)}</b><br><span class="muted">${ESCANOS[pr]} diputados · ${fmt(A.length)} actas</span></td><td>${chips(r)}</td></tr>`;
  });
  if (provs.length > 1) filas.push(`<tr><td><b>Total Catalunya</b><br><span class="muted">48 diputados</span></td><td>${chips(total)}</td></tr>`);
  $('escanos').innerHTML = `<table class="tesc">${filas.join('')}</table>`;
}

// ---------- proyección de escaños del Senado ----------
// Cada provincia elige 4 senadores: los 4 candidatos más votados (cada elector marca hasta 3).
const SENADORES = 4;
function pintarEscanosSenado(config) {
  $('h-escanos').innerHTML = `Proyección de escaños · Senado <span class="muted" style="font-weight:400">· ${SENADORES} senadores por provincia: los ${SENADORES} candidatos más votados, solo con las actas recibidas</span>`;
  const provs = $('f-prov').value ? [$('f-prov').value] : Object.keys(config.senado || {});
  const total = {}; // partido -> { n, color }
  const chips = (porPartido) => Object.entries(porPartido).sort((a, b) => b[1].n - a[1].n || (b[0] === 'PP') - (a[0] === 'PP'))
    .map(([partido, x]) => `<span class="esc" style="--c:${esc(x.color)}"><b>${x.n}</b> ${esc(partido)}</span>`).join('');
  const filas = provs.map((pr) => {
    const A = datos.actas.filter((a) => tipoDe(a) === 'senado' && a.provincia === pr);
    const votos = {};
    for (const a of A) for (const c of config.senado[pr] || []) votos[c.id] = (votos[c.id] || 0) + (a.votos[c.id] || 0);
    const electos = (config.senado[pr] || []).filter((c) => votos[c.id] > 0).sort((a, b) => votos[b.id] - votos[a.id]).slice(0, SENADORES);
    const porPartido = {};
    for (const c of electos) {
      (porPartido[c.partido] ||= { n: 0, color: c.color }).n++;
      (total[c.partido] ||= { n: 0, color: c.color }).n++;
    }
    const nombres = electos.map((c) => `${esc(c.nombre)} <span class="muted">(${esc(c.partido)}, ${fmt(votos[c.id])})</span>`).join(' · ');
    return `<tr><td><b>${esc(pr)}</b><br><span class="muted">${SENADORES} senadores · ${fmt(A.length)} actas</span></td><td>${electos.length ? chips(porPartido) + `<div class="muted" style="font-size:.85rem;margin-top:4px">${nombres}</div>` : '<span class="muted">Sin actas todavía</span>'}</td></tr>`;
  });
  if (provs.length > 1) filas.push(`<tr><td><b>Total Catalunya</b><br><span class="muted">${SENADORES * provs.length} senadores</span></td><td>${chips(total) || '<span class="muted">Sin actas todavía</span>'}</td></tr>`);
  $('escanos').innerHTML = `<table class="tesc">${filas.join('')}</table>`;
}

// ---------- mesas pendientes de un municipio (las que aún no han enviado acta) ----------
function pintarPendientes(L) {
  const mun = $('f-mun').value.trim();
  const prov = $('f-prov').value || Object.keys(publica.municipios).find((p) => publica.municipios[p].includes(mun));
  const box = $('pend');
  if (!mun || !prov || !publica.secciones?.[prov]?.[mun]) {
    box.innerHTML = '<p class="muted">Elige arriba una <b>provincia</b> y un <b>municipio</b> para ver qué mesas todavía no han enviado el acta del ' + (tipo === 'senado' ? 'Senado' : 'Congreso') + '.</p>';
    return;
  }
  const recibidas = new Set(L.filter((a) => a.municipio === mun).map((a) => `${a.distrito}|${a.seccion}|${a.mesa}`));
  let total = 0, faltan = 0;
  const grupos = Object.keys(publica.secciones[prov][mun]).sort().map((d) => {
    const items = [];
    for (const s of publica.secciones[prov][mun][d]) {
      for (const l of publica.letras?.[[prov, mun, d, s].join('|')] || ['U']) {
        total++;
        if (!recibidas.has(`${d}|${s}|${l}`)) { faltan++; items.push(`<span class="mp">${Number(s)}-${l}</span>`); }
      }
    }
    return items.length ? `<div class="gd"><b>Distrito ${Number(d)}</b> <span class="muted">(${items.length} pendientes)</span><div>${items.join('')}</div></div>` : '';
  }).join('');
  box.innerHTML = `<p><b>${esc(mun)}</b>: faltan <b style="color:var(--bad)">${fmt(faltan)}</b> de ${fmt(total)} mesas (${pct(total - faltan, total)} recibidas). Formato: <i>sección-mesa</i>.</p>` +
    (grupos || '<p class="status ok">✓ Han llegado todas las actas de este municipio.</p>');
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
function tablaVotos(a) {
  const sen = a.tipo === 'senado';
  const lista = sen ? (datos.config.senado?.[a.provincia] || []).map((c) => [`${c.nombre} (${c.partido})`, c.id]) : datos.config.partidos.filter((p) => a.votos && p.id in a.votos).map((p) => [p.nombre, p.id]);
  const filas = [['Electores (censo)', a.censo], ['Votantes', a.votantes], [sen ? 'Papeletas nulas' : 'Nulos', a.nulos], [sen ? 'Papeletas en blanco' : 'Blancos', a.blancos], ...lista.map(([k, id]) => [k, a.votos?.[id] ?? 0])];
  return `<table>${filas.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n"><b>${fmt(v)}</b></td></tr>`).join('')}</table>`;
}
async function verActa(id) {
  const a = await api('/api/admin/acta?id=' + encodeURIComponent(id));
  const box = $('modal-box');
  box.innerHTML = `<div class="topbar"><div class="title"><h2 style="margin:0"><span class="badge">${a.tipo === 'senado' ? 'Senado' : 'Congreso'}</span> ${esc(a.municipio)} · ${esc(a.colegio)} · Dist. ${esc(a.distrito)} · Secc. ${esc(a.seccion)} · Mesa ${esc(a.mesa)}</h2></div><button class="btn ghost small" id="m-close">✕</button></div>
    <div class="detail">
      <div>${a.foto ? `<a href="/api/admin/foto?f=${encodeURIComponent(a.foto)}&t=${encodeURIComponent(token)}" target="_blank"><img src="/api/admin/foto?f=${encodeURIComponent(a.foto)}&t=${encodeURIComponent(token)}" alt="Acta"></a><p class="muted">Pulsa la foto para abrirla en grande.</p>` : '<p class="warn">Enviada sin foto.</p>'}</div>
      <div>
        <div class="status ${a.cuadra ? 'ok' : 'bad'}">${a.cuadra ? (a.tipo === 'senado' ? '✓ Datos coherentes' : '✓ Los votos cuadran') : '⚠ ' + (a.tipo === 'senado' ? esc(a.avisos[0] || '') : a.diferencia > 0 ? `Faltan ${a.diferencia} votos` : `Sobran ${-a.diferencia} votos`)}</div>
        ${(a.avisos || []).length ? `<p class="warn" style="margin-top:10px">${a.avisos.map(esc).join('<br>')}</p>` : ''}
        ${a.observaciones ? `<p><b>Observaciones:</b> ${esc(a.observaciones)}</p>` : ''}
        ${tablaVotos(a)}
        <p class="muted">Enviada por ${esc(a.enviadoPor?.nombre || 'Sin nombre')} · ${new Date(a.recibido).toLocaleString('es-ES')}</p>
        ${(a.historial || []).length ? `<details><summary><b>${a.historial.length} versión(es) anterior(es)</b></summary>${a.historial.map((h) => `<div class="card" style="background:#f6f8fb"><div class="muted">${esc(h.enviadoPor?.nombre)} · ${new Date(h.recibido).toLocaleString('es-ES')}</div>${tablaVotos({ ...h, tipo: a.tipo, provincia: a.provincia })}</div>`).join('')}</details>` : ''}
        <div style="height:10px"></div>
        <button class="btn danger" id="m-del" style="margin-bottom:10px">🗑 Borrar esta acta</button>
        <button class="btn ${a.revisada ? 'secondary' : ''}" id="m-rev">${a.revisada ? 'Quitar marca de revisada' : '✓ Marcar como revisada'}</button>
      </div>
    </div>`;
  $('modal').classList.add('open');
  $('m-close').onclick = () => $('modal').classList.remove('open');
  $('m-del').onclick = async () => {
    if (!confirm('¿Borrar esta acta? Desaparecerá del recuento.')) return;
    await api('/api/admin/acta/borrar', { method: 'POST', body: { id: a.id } });
    $('modal').classList.remove('open'); refrescar();
  };
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
  $('c-senado').value = Object.entries(c.config.senado || {}).flatMap(([pr, l]) => l.map((x) => `${pr};${x.partido};${x.nombre}`)).join('\n');
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
    const senado = $('c-senado').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [provincia, partido, nombre] = l.split(';').map((x) => x.trim());
      const color = datos?.config.senado?.[provincia]?.find((x) => x.partido === partido)?.color;
      return { provincia, partido, nombre, color };
    });
    await api('/api/admin/config', { method: 'PUT', body: { eleccion: $('c-eleccion').value, partidos, senado } });
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
$('b-borrar-todas').addEventListener('click', async () => {
  const c = prompt('Esto borra TODAS las actas recibidas (por ejemplo, las de prueba). Escribe BORRAR para confirmar:');
  if (c !== 'BORRAR') return;
  try {
    const r = await api('/api/admin/borrar-todas', { method: 'POST', body: { confirmacion: 'BORRAR' } });
    $('c-borrar-msg').textContent = `✓ ${r.borradas} actas borradas`; refrescar();
  } catch (e) { $('c-borrar-msg').textContent = '⚠ ' + e.message; }
});
$('b-dist').addEventListener('click', () => subirCSV('c-dist-file', '/api/admin/distritos', 'c-dist-msg'));
$('b-dist-csv').addEventListener('click', (e) => { e.preventDefault(); location.href = '/api/admin/distritos.csv?t=' + encodeURIComponent(token); });
$('b-mesas').addEventListener('click', () => subirCSV('c-mesas-file', '/api/admin/mesas', 'c-mesas-msg'));

// ---------- arranque ----------
let timer = null;
function arrancar() {
  show('s-panel'); refrescar();
  clearInterval(timer); timer = setInterval(refrescar, 15000);
}
if (token) arrancar(); else show('s-login');
