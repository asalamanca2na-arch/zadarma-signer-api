// App del apoderado: foto del acta -> mesa -> votos -> enviar (con cola sin conexión).
'use strict';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// Identificador anónimo de este móvil, solo para mostrar «Mis actas enviadas».
let dispositivo = store.get('dispositivo', null);
if (!dispositivo) { dispositivo = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(16) + Math.random().toString(16).slice(2)); store.set('dispositivo', dispositivo); }
let cfg = store.get('cfg', null);
let borrador = null; // acta en curso

// ---------- navegación ----------
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  window.scrollTo(0, 0);
}
document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => show(b.dataset.back)));

function modal(html, { cerrar = true } = {}) {
  $('modal-box').innerHTML = html;
  $('modal').classList.add('open');
  if (cerrar) $('modal-box').querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', cerrarModal));
}
function cerrarModal() { $('modal').classList.remove('open'); $('modal-box').classList.remove('larga'); }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Dispositivo': dispositivo },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Error ' + res.status), { status: res.status, data });
  return data;
}

// ---------- cola sin conexión (IndexedDB) ----------
const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((ok, ko) => {
      const r = indexedDB.open('actas-cola', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('pend', { keyPath: 'clientId' });
      r.onsuccess = () => { this.db = r.result; ok(this.db); };
      r.onerror = () => ko(r.error);
    });
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((ok, ko) => {
      const t = db.transaction('pend', mode); const s = t.objectStore('pend');
      const r = fn(s); t.oncomplete = () => ok(r && r.result); t.onerror = () => ko(t.error);
    });
  },
  put(v) { return this.tx('readwrite', (s) => s.put(v)); },
  del(k) { return this.tx('readwrite', (s) => s.delete(k)); },
  all() { return this.tx('readonly', (s) => s.getAll()); },
};

let enviando = false;
async function vaciarCola() {
  if (enviando) return;
  enviando = true;
  try {
    for (const p of await DB.all()) {
      try {
        await api(p.clase === 'reclamacion' ? '/api/reclamaciones' : '/api/actas', { method: 'POST', body: p });
        await DB.del(p.clientId);
      } catch (e) {
        if (!e.status) break; // sin conexión: lo intentamos más tarde
        if (e.status >= 400 && e.status < 500 && e.status !== 429) { await DB.del(p.clientId); alert('Un acta pendiente tenía datos no válidos y se ha descartado: ' + e.message); }
        else break;
      }
    }
  } finally { enviando = false; await pintarInicio(); }
}
window.addEventListener('online', vaciarCola);
setInterval(vaciarCola, 30000);

async function cargarConfig() {
  try { cfg = await api('/api/config'); store.set('cfg', cfg); } catch (e) { if (!cfg) throw e; }
}

// ---------- inicio ----------
async function pintarInicio() {
  $('h-eleccion').textContent = cfg?.eleccion || 'Elecciones';
  const pend = await DB.all().catch(() => []);
  $('h-pend').classList.toggle('hidden', !pend.length);
  $('h-pend-n').textContent = pend.length;
  let enviadas = store.get('mis-actas', []);
  try { enviadas = await api('/api/mis-actas'); store.set('mis-actas', enviadas); } catch {}
  const items = [
    ...pend.map((p) => `<li><div class="grow"><b>${p.clase === 'reclamacion' ? '📝 Reclamación' : nombreTipo(p.tipo)} · ${esc(p.ubicacion.municipio)}</b><div class="muted">Dist. ${esc(p.ubicacion.distrito)} · Secc. ${esc(p.ubicacion.seccion)} · Mesa ${esc(p.ubicacion.mesa)}</div></div><span class="pill wait">Pendiente</span></li>`),
    ...enviadas.sort((a, b) => b.recibido.localeCompare(a.recibido)).map((a) => `<li class="clic" data-acta="${esc(a.id)}"><div class="grow"><b>${a.clase === 'reclamacion' ? '📝 Reclamación' : nombreTipo(a.tipo)} · ${esc(a.municipio)}</b><div class="muted">Dist. ${esc(a.distrito)} · Secc. ${esc(a.seccion)} · Mesa ${esc(a.mesa)} · ${new Date(a.recibido).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</div></div>${a.clase === 'reclamacion' ? `<span class="pill ${a.revisada ? 'ok' : 'wait'}">${a.revisada ? 'Revisada' : 'Enviada'}</span>` : `<span class="pill ${a.cuadra ? 'ok' : 'bad'}">${a.cuadra ? 'Enviada' : 'Enviada · revisar'}</span>`}<span class="flecha">›</span></li>`),
  ];
  $('h-lista').innerHTML = items.join('') || '<li class="muted">Todavía no has enviado ninguna.</li>';
  misActas = Object.fromEntries(enviadas.map((a) => [a.id, a]));
  $('h-lista').querySelectorAll('[data-acta]').forEach((li) => li.addEventListener('click', () => verMiActa(misActas[li.dataset.acta])));
}
// ---------- ver un acta enviada (solo lectura) y comentar ----------
let misActas = {};
function verMiActa(a) {
  if (!a) return;
  if (a.clase === 'reclamacion') return verMiReclamacion(a);
  const sen = a.tipo === 'senado';
  const lista = sen ? (cfg.senado?.[a.provincia] || []).map((c) => [c.nombre, c.partido, c.id]) : partidosDe(a.provincia).map((p) => [p.nombre, '', p.id]);
  const fila = (k, v, sub = '') => `<tr><td>${esc(k)}${sub ? `<br><span class="muted" style="font-size:.8rem">${esc(sub)}</span>` : ''}</td><td class="n">${v ?? '—'}</td></tr>`;
  const estado = a.cuadra ? (sen ? '✓ Datos coherentes' : '✓ Los votos cuadran') : sen ? '⚠ Hay datos que revisar' : `⚠ ${a.diferencia > 0 ? 'Faltan ' + a.diferencia : 'Sobran ' + -a.diferencia} votos`;
  const quien = a.mia ? 'Enviada por ti' : `Enviada por ${esc(a.enviadoPor || 'otro apoderado')}`;
  modal(`<div class="ficha">
    <div class="row" style="justify-content:space-between"><span class="badge">${nombreTipo(a.tipo)}</span><button class="btn ghost small" data-close>✕</button></div>
    <h2 style="margin:8px 0 2px">${esc(a.municipio)}</h2>
    <div class="muted">${esc(a.colegio || '')} · Distrito ${Number(a.distrito)} · Sección ${Number(a.seccion)} · Mesa ${esc(a.mesa)}</div>
    <div class="muted" style="margin-top:2px">${quien} · ${new Date(a.recibido).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${a.confirmadaPor?.length ? ` · confirmada por ${esc(a.confirmadaPor.join(', '))}` : ''}</div>
    <p class="aviso-lectura">👁 Solo para consultar. No se puede modificar.</p>
    ${a.hayFoto ? `<img class="foto-ficha" src="/api/mis-actas/foto?id=${encodeURIComponent(a.id)}&d=${encodeURIComponent(dispositivo)}" alt="Foto del acta">` : '<p class="muted">Enviada sin foto.</p>'}
    <div class="status ${a.cuadra ? 'ok' : 'bad'}" style="margin:10px 0">${estado}</div>
    <table class="tabla-ficha">${fila('Electores (censo)', a.censo)}${fila('Votantes', a.votantes)}${fila(sen ? 'Papeletas nulas' : 'Votos nulos', a.nulos)}${fila(sen ? 'Papeletas en blanco' : 'Votos en blanco', a.blancos)}
      ${lista.map(([n, sub, id]) => fila(n, a.votos?.[id] ?? 0, sub)).join('')}</table>
    ${a.observaciones ? `<p><b>Observaciones:</b> ${esc(a.observaciones)}</p>` : ''}
    <div class="comentario">
      <h3>💬 ¿Ves algo mal?</h3>
      ${(a.comentarios || []).map((c) => `<div class="com-enviado">«${esc(c.texto)}»<br><span class="muted">Enviado ${new Date(c.fecha).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })} · el equipo lo revisará</span></div>`).join('')}
      <textarea id="mc-texto" placeholder="Ej.: el PP tiene 210 votos, no 201"></textarea>
      <button class="btn" id="mc-enviar">Enviar comentario</button>
      <div id="mc-msg" class="muted"></div>
    </div>
    <button class="btn secondary" data-close style="margin-top:10px">Cerrar</button></div>`);
  $('modal-box').classList.add('larga');
  $('mc-enviar').onclick = async () => {
    const texto = $('mc-texto').value.trim();
    if (texto.length < 3) { $('mc-msg').textContent = 'Escribe qué has visto mal.'; return; }
    $('mc-enviar').disabled = true;
    try {
      await api('/api/mis-actas/comentario', { method: 'POST', body: { id: a.id, texto, nombre: store.get('nombre', '') } });
      (a.comentarios ||= []).push({ texto, fecha: new Date().toISOString() });
      $('mc-texto').value = ''; $('mc-msg').innerHTML = '✅ <b>Comentario enviado.</b> El equipo lo revisará.';
    } catch (e) { $('mc-msg').textContent = e.status ? e.message : 'Sin conexión: inténtalo cuando tengas cobertura.'; }
    $('mc-enviar').disabled = false;
  };
}

function verMiReclamacion(r) {
  modal(`<div class="ficha">
    <div class="row" style="justify-content:space-between"><span class="badge">📝 Reclamación</span><button class="btn ghost small" data-close>✕</button></div>
    <h2 style="margin:8px 0 2px">${esc(r.municipio)}</h2>
    <div class="muted">${esc(r.colegio || '')} · Distrito ${Number(r.distrito)} · Sección ${Number(r.seccion)} · Mesa ${esc(r.mesa)} · ${r.tipo === 'senado' ? 'Senado' : r.tipo === 'congreso' ? 'Congreso' : 'Congreso y Senado'}</div>
    <div class="muted" style="margin-top:2px">Enviada ${new Date(r.recibido).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${r.revisada ? '✓ revisada por el equipo' : 'pendiente de revisar'}</div>
    <p class="aviso-lectura">👁 Solo para consultar. No se puede modificar.</p>
    ${r.hayFoto ? `<img class="foto-ficha" src="/api/mis-actas/foto?id=${encodeURIComponent(r.id)}&d=${encodeURIComponent(dispositivo)}" alt="Foto de la reclamación">` : '<p class="muted">Enviada sin foto.</p>'}
    <p style="margin-top:12px"><b>Reclamación:</b> ${esc(r.texto || '—')}</p>
    <button class="btn secondary" data-close style="margin-top:10px">Cerrar</button></div>`);
  $('modal-box').classList.add('larga');
}

// ---------- reclamaciones: foto → mesa → texto → enviar ----------
function nuevaReclamacion(conFoto) {
  nuevoBorrador(null); borrador.clase = 'reclamacion';
  if (conFoto) $('i-camara').click(); else irUbicacion();
}
$('b-recl-foto').addEventListener('click', () => nuevaReclamacion(true));
$('b-recl-sinfoto').addEventListener('click', () => nuevaReclamacion(false));
function irReclamacion() {
  const u = borrador.ubicacion, L = borrador.lectura;
  $('r-mun').textContent = `${u.municipio} (${u.provincia})`;
  $('r-mesa').textContent = `${u.colegio} · Distrito ${u.distrito} · Sección ${u.seccion} · Mesa ${u.mesa}`;
  $('r-thumb').classList.toggle('hidden', !borrador.foto);
  if (borrador.foto) $('r-thumb').src = borrador.foto;
  if (borrador.rTexto == null) { borrador.rTexto = L?.reclamacionTexto || ''; borrador.rReclamante = L?.reclamante || ''; }
  $('r-texto').value = borrador.rTexto; $('r-reclamante').value = borrador.rReclamante;
  avisoLectura('r-ia', L && L.reclamacionTexto ? L : null, '');
  show('s-recl');
}
$('r-texto').addEventListener('input', () => { borrador.rTexto = $('r-texto').value; });
$('r-reclamante').addEventListener('input', () => { borrador.rReclamante = $('r-reclamante').value; });
$('r-thumb').addEventListener('click', () => modal(`<img class="zoom" src="${borrador.foto}" alt=""><div style="height:10px"></div><button class="btn" data-close>Cerrar</button>`));
$('b-recl-enviar').addEventListener('click', async () => {
  const texto = $('r-texto').value.trim();
  if (texto.length < 3 && !borrador.foto) return alert('Describe la reclamación o adjunta la foto del escrito.');
  if (!borrador.foto && !confirm('Vas a enviar la reclamación SIN foto del escrito. ¿Seguro?')) return;
  const envio = { clase: 'reclamacion', tipo: borrador.tipo, nombre: borrador.nombre, clientId: borrador.clientId, ubicacion: borrador.ubicacion, texto, reclamante: $('r-reclamante').value.trim(), foto: borrador.foto || null };
  modal('<div class="spinner"></div><p>Enviando reclamación…</p>', { cerrar: false });
  try {
    await api('/api/reclamaciones', { method: 'POST', body: envio });
    modal(`<div class="big">✅</div><h2 style="justify-content:center">Reclamación enviada</h2><p>El equipo la revisará. La tienes en «Mis actas enviadas».</p><button class="btn" data-close>OK</button>`);
  } catch (e) {
    if (e.status && e.status < 500) { modal(`<div class="big">⚠️</div><h2 style="justify-content:center">No se ha enviado</h2><p>${esc(e.message)}</p><button class="btn" data-close>Volver</button>`); return; }
    await DB.put(envio);
    modal(`<div class="big">📶</div><h2 style="justify-content:center">Sin conexión</h2><p>La reclamación se ha guardado en el móvil y <b>se enviará sola</b> cuando haya cobertura.</p><button class="btn" data-close>Entendido</button>`);
  }
  borrador = null; inicio();
});

async function inicio() { show('s-home'); await pintarInicio(); vaciarCola(); }
// La lista se actualiza sola (por ejemplo, si el equipo borra un acta desde el panel).
const enInicio = () => $('s-home').classList.contains('active') && !$('modal').classList.contains('open');
setInterval(() => { if (enInicio() && document.visibilityState === 'visible') pintarInicio(); }, 30000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && enInicio()) pintarInicio(); });

// ---------- foto ----------
$('b-camara').addEventListener('click', () => $('i-camara').click());
$('b-galeria').addEventListener('click', () => $('i-galeria').click());
$('b-repetir').addEventListener('click', () => $('i-camara').click());
$('b-sinfoto').addEventListener('click', () => { nuevoBorrador(null); irUbicacion(); });
for (const inp of [$('i-camara'), $('i-galeria')]) {
  inp.addEventListener('change', async () => {
    const f = inp.files[0]; inp.value = '';
    if (!f) return;
    modal('<div class="spinner"></div><p>Procesando imagen…</p>', { cerrar: false });
    try {
      const img = await cargarImagen(f);
      if (!borrador || borrador.enviado) nuevoBorrador(null);
      borrador.imagen = img; borrador.rot = 0;
      borrador.foto = comprimir(img, 0);
      $('f-img').src = borrador.foto;
      cerrarModal(); show('s-foto');
    } catch {
      modal('<div class="big">⚠️</div><h2 style="justify-content:center">No se ha podido leer la foto</h2><p>Prueba a sacarla otra vez.</p><button class="btn" data-close>Vale</button>');
    }
  });
}
function cargarImagen(file) {
  return new Promise((ok, ko) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); ok(img); };
    img.onerror = () => { URL.revokeObjectURL(url); ko(new Error('imagen')); };
    img.src = url;
  });
}
// Reduce la foto a ~1800px y JPEG para que suba rápido incluso con poca cobertura.
function comprimir(img, rot) {
  const MAX = 2000;
  const s = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
  const c = document.createElement('canvas');
  const girada = rot % 180 !== 0;
  c.width = girada ? h : w; c.height = girada ? w : h;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2); ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  return c.toDataURL('image/jpeg', 0.8);
}
$('b-rotar').addEventListener('click', () => {
  borrador.rot = (borrador.rot + 90) % 360;
  borrador.foto = comprimir(borrador.imagen, borrador.rot);
  $('f-img').src = borrador.foto;
});
$('b-foto-ok').addEventListener('click', leerYContinuar);

// ---------- lectura automática del acta (IA) ----------
// Envía la foto al servidor, que la lee y devuelve los datos. El apoderado solo tiene que revisarlos.
async function leerYContinuar() {
  borrador.lectura = null;
  if (cfg?.lecturaAutomatica && borrador.foto && navigator.onLine !== false) {
    modal('<div class="spinner"></div><h2 style="justify-content:center">Leyendo la foto…</h2><p>Puede tardar unos segundos.</p><button class="btn secondary" id="b-leer-cancelar">Rellenar a mano</button>', { cerrar: false });
    let cancelado = false;
    $('b-leer-cancelar').onclick = () => { cancelado = true; cerrarModal(); irUbicacion(); };
    try {
      const r = await api('/api/leer-acta', { method: 'POST', body: { foto: borrador.foto } });
      if (cancelado) return;
      cerrarModal();
      const L = r.lectura;
      if (borrador.clase === 'reclamacion' || L.documento === 'reclamacion') {
        if (borrador.clase !== 'reclamacion') {
          // Se ha fotografiado una reclamación desde «Sacar foto del acta»: se propone subirla como reclamación.
          modal('<div class="big">📝</div><h2 style="justify-content:center">Parece un escrito de reclamación</h2><p>¿Quieres subirlo como <b>reclamación</b> de esta mesa?</p><button class="btn" id="b-es-recl">Sí, es una reclamación</button><button class="btn secondary" id="b-no-recl">No, es un acta</button>', { cerrar: false });
          $('b-es-recl').onclick = () => { cerrarModal(); borrador.clase = 'reclamacion'; aplicarLecturaRecl(L); irUbicacion(); };
          $('b-no-recl').onclick = () => { cerrarModal(); irUbicacion(); };
          return;
        }
        aplicarLecturaRecl(L); irUbicacion(); return;
      }
      if (!r.lectura.esActa) {
        modal('<div class="big">🤔</div><h2 style="justify-content:center">La foto no parece un acta</h2><p>Revisa que se vea el acta entera, o rellena los datos a mano.</p><button class="btn" id="b-repetir-foto">Repetir la foto</button><button class="btn secondary" data-close id="b-a-mano">Rellenar a mano</button>');
        $('b-repetir-foto').onclick = () => { cerrarModal(); $('i-camara').click(); };
        $('b-a-mano').onclick = () => { cerrarModal(); irUbicacion(); };
        return;
      }
      aplicarLectura(r.lectura);
    } catch (e) {
      if (cancelado) return;
      cerrarModal();
      modal(`<div class="big">✍️</div><h2 style="justify-content:center">No se ha podido leer la foto</h2><p>${esc(e.status ? e.message : 'Sin conexión.')} Rellena los datos a mano; la foto se enviará igualmente.</p><button class="btn" data-close>Vale</button>`);
    }
  }
  irUbicacion();
}
function aplicarLecturaRecl(l) {
  borrador.lectura = { ...l, votos: {} };
  borrador.tipo = l.tipo || 'ambas';
}
function aplicarLectura(l) {
  borrador.lectura = l;
  if (l.tipo) borrador.tipo = l.tipo;
  if (l.tipo) {
    borrador.votos = { tipo: l.tipo, censo: l.censo, votantes: l.votantes, nulos: l.nulos, blancos: l.blancos, partidos: l.votos, deLectura: true };
  }
}

function avisoLectura(id, L, extra) {
  const el = $(id);
  if (!L) { el.classList.add('hidden'); return; }
  el.innerHTML = `🤖 <b>Datos leídos de la foto.</b> Comprueba que coinciden con el acta antes de seguir.` +
    (L.dudas ? `<br><small>⚠ ${esc(L.dudas)}</small>` : '') + (extra ? `<br><small>⚠ ${esc(extra)}</small>` : '');
  el.classList.remove('hidden');
}
document.addEventListener('input', (e) => { if (e.target.classList?.contains('revisar') && e.target.value) e.target.classList.remove('revisar'); });
function nuevoBorrador(foto) {
  borrador = { clientId: (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2)), foto, rot: 0 };
}

// ---------- paso 1: ubicación ----------
// Si la app aún no tiene la lista de candidaturas (primera vez y con poca cobertura), la esperamos.
async function asegurarConfig() {
  if (cfg) return true;
  modal('<div class="spinner"></div><p>Cargando…</p>', { cerrar: false });
  try { await cargarConfig(); } catch {}
  cerrarModal();
  if (!cfg) modal('<div class="big">📶</div><h2 style="justify-content:center">Sin conexión</h2><p>La primera vez hace falta cobertura para abrir la app. Inténtalo de nuevo en un momento.</p><button class="btn" data-close>Vale</button>');
  return !!cfg;
}
async function irUbicacion() {
  if (!(await asegurarConfig())) return;
  const L = borrador.lectura;
  const guardada = store.get('ultima-mesa', {});
  // Prioridad: lo leído de la foto; si falta algo, la última mesa usada en este móvil.
  const ult = L && L.provincia ? { provincia: L.provincia, municipio: L.municipio || '', distrito: L.distrito, seccion: L.seccion, mesa: L.mesa } : guardada;
  $('u-prov').innerHTML = '<option value="">Elige…</option>' + cfg.provincias.map((p) => `<option>${esc(p)}</option>`).join('');
  modoManual(false);
  // Rellenamos en cascada con la última mesa usada en este móvil.
  $('u-prov').value = ult.provincia || '';
  alCambiarProv();
  if (ult.municipio) { $('u-mun').value = ult.municipio; alCambiarMun(); }
  if (ult.distrito && [...$('u-dist').options].some((o) => o.value === ult.distrito)) { $('u-dist').value = ult.distrito; alCambiarDist(); }
  if (ult.seccion && [...$('u-secc').options].some((o) => o.value === ult.seccion)) { $('u-secc').value = ult.seccion; alCambiarSecc(); }
  // Si lo leído no está en la lista (sección nueva), se pasa a escribir a mano con los datos ya puestos.
  if (L && ult.municipio && ult.distrito && ult.seccion && $('u-secc').value !== ult.seccion) {
    modoManual(true); $('u-dist-m').value = ult.distrito; $('u-secc-m').value = ult.seccion; $('u-mesa-m').value = ult.mesa || ''; $('u-dist-m').blur();
  } else if (ult.mesa && [...$('u-mesa').options].some((o) => o.value === ult.mesa)) $('u-mesa').value = ult.mesa;
  else if (ult.mesa && $('u-secc').value === ult.seccion) { mesaEscrita(true); $('u-mesa-m').value = ult.mesa; $('u-mesa-m').blur(); }
  avisoLectura('u-ia', L, L && !L.municipio && L.municipioLeido ? `No hemos reconocido el municipio «${L.municipioLeido}»: elígelo de la lista.` : '');
  $('u-err').classList.add('hidden');
  marcarTipo();
  $('u-nombre').value = store.get('nombre', '');
  $('u-colegio').value = store.get('colegio', '');
  const recl = borrador.clase === 'reclamacion';
  $('u-titulo').textContent = recl ? 'Reclamación · Paso 1 de 2' : 'Paso 1 de 2 · Tus datos y mesa';
  $('u-tipo-tit').textContent = recl ? '🗳️ ¿De qué elección es la reclamación?' : '📄 ¿Qué acta es?';
  document.querySelectorAll('.solo-recl').forEach((b) => b.classList.toggle('hidden', !recl));
  show('s-ubic');
}
// Congreso o Senado: se elige cada vez (el apoderado suele enviar las dos actas de la mesa).
function marcarTipo() { document.querySelectorAll('.tipo-btn').forEach((b) => b.classList.toggle('on', b.dataset.tipo === borrador?.tipo)); }
document.querySelectorAll('.tipo-btn').forEach((b) => b.addEventListener('click', () => { borrador.tipo = b.dataset.tipo; marcarTipo(); $('u-err').classList.add('hidden'); }));
const nombreTipo = (t) => (t === 'senado' ? 'Senado' : 'Congreso');
$('b-ubic-back').addEventListener('click', () => show(borrador?.foto ? 's-foto' : 's-home'));

// ---- desplegables en cascada: provincia → municipio → distrito → sección → mesa ----
function opciones(sel, valores, vacio, etiqueta = (v) => v) {
  sel.innerHTML = `<option value="">${esc(vacio)}</option>` + valores.map((v) => `<option value="${esc(v)}">${esc(etiqueta(v))}</option>`).join('');
  sel.disabled = valores.length === 0;
  if (valores.length === 1) sel.value = valores[0];
}
const seccionesDe = () => cfg.secciones?.[$('u-prov').value]?.[$('u-mun').value] || {};
function alCambiarProv() {
  const lista = cfg.municipios?.[$('u-prov').value] || [];
  opciones($('u-mun'), lista, $('u-prov').value ? `Elige municipio (${lista.length})` : 'Elige primero la provincia');
  alCambiarMun();
}
// Nombres de los distritos (los distritos censales de Barcelona coinciden con sus 10 distritos municipales).
// Nombres de los distritos (los de Barcelona ciudad vienen de serie; el resto se cargan desde el panel).
const nombreDe = (mun, d) => cfg.distritos?.[$('u-prov').value]?.[mun]?.[d] || '';
const nombreDistrito = (mun, d) => String(Number(d)) + (nombreDe(mun, d) ? ' · ' + nombreDe(mun, d) : '');
function pintarNombreDistrito() {
  const n = nombreDe($('u-mun').value, $('u-dist').value);
  $('u-dist-nom').textContent = n ? 'Distrito ' + Number($('u-dist').value) + ': ' + n : '';
  $('u-dist-nom').classList.toggle('hidden', !n);
}
$('u-dist').addEventListener('change', pintarNombreDistrito);
function alCambiarMun() {
  const d = Object.keys(seccionesDe()).sort();
  opciones($('u-dist'), d, $('u-mun').value ? 'Distrito' : '—', (v) => nombreDistrito($('u-mun').value, v));
  pintarNombreDistrito();
  alCambiarDist();
}
function alCambiarDist() {
  pintarNombreDistrito();
  const s = seccionesDe()[$('u-dist').value] || [];
  opciones($('u-secc'), s, $('u-dist').value ? 'Sección' : '—', (v) => String(Number(v)));
  alCambiarSecc();
}
function letrasMesa(prov, mun, dist, secc) {
  return cfg.letras?.[[prov, mun, dist, secc].join('|')] || TODAS_LETRAS;
}
const TODAS_LETRAS = ['U', 'A', 'B', 'C', 'D', 'E'];
function alCambiarSecc() {
  const listo = modo === 'manual' ? !!$('u-mun').value : !!$('u-secc').value;
  const letras = !listo ? [] : modo === 'manual' ? TODAS_LETRAS : letrasMesa($('u-prov').value, $('u-mun').value, $('u-dist').value, $('u-secc').value);
  opciones($('u-mesa'), letras, listo ? 'Mesa' : '—');
  // Las mesas oficiales son de 2023: si la del acta no aparece, se puede elegir otra letra.
  // Las mesas oficiales son de 2023: si la del acta no aparece, se puede escribir a mano.
  if (listo && modo !== 'manual') $('u-mesa').insertAdjacentHTML('beforeend', '<option value="__escribir">✏️ Escribir…</option>');
  mesaEscrita(false);
}
// Solo la mesa escrita a mano (distrito y sección siguen siendo de la lista).
let mesaAMano = false;
function mesaEscrita(on) {
  mesaAMano = on;
  const manual = on || modo === 'manual';
  $('u-mesa').classList.toggle('hidden', manual);
  $('u-mesa-m').classList.toggle('hidden', !manual);
  if (on) { $('u-mesa-m').value = ''; $('u-mesa-m').focus(); }
}
$('u-mesa').addEventListener('change', () => { if ($('u-mesa').value === '__escribir') mesaEscrita(true); });
$('u-mesa-m').addEventListener('input', () => { $('u-mesa-m').value = $('u-mesa-m').value.toUpperCase().replace(/[^A-Z]/g, ''); });
$('u-prov').addEventListener('change', alCambiarProv);
$('u-mun').addEventListener('change', alCambiarMun);
$('u-dist').addEventListener('change', alCambiarDist);
$('u-secc').addEventListener('change', alCambiarSecc);

// Por si el acta pone un distrito/sección que no está en el listado (secciones nuevas): escribirlo a mano.
let modo = 'lista';
function modoManual(on) {
  modo = on ? 'manual' : 'lista';
  for (const id of ['u-dist', 'u-secc']) { $(id).classList.toggle('hidden', on); $(id + '-m').classList.toggle('hidden', !on); }
  $('b-manual').textContent = on ? '← Volver a elegir de la lista' : '✏️ ¿No aparece tu distrito, sección o mesa? Escríbelos a mano';
  if (on) {
    $('u-dist-m').value = $('u-dist').value; $('u-secc-m').value = $('u-secc').value;
    const m = $('u-mesa').value; $('u-mesa-m').value = m && !m.startsWith('__') ? m : '';
  }
  alCambiarSecc();
  if (on) $('u-dist-m').focus();
}
$('b-manual').addEventListener('click', () => modoManual(modo !== 'manual'));

$('b-ubic-ok').addEventListener('click', async () => {
  const err = (t) => { $('u-err').textContent = t; $('u-err').classList.remove('hidden'); };
  if (!borrador.tipo) return err(borrador.clase === 'reclamacion' ? 'Elige arriba de qué elección es la reclamación.' : 'Elige arriba si el acta es del Congreso o del Senado.');
  const nombre = $('u-nombre').value.trim(), colegio = $('u-colegio').value.trim();
  if (nombre.length < 3) return err('Escribe tu nombre y apellido.');
  if (colegio.length < 3) return err('Escribe el nombre del colegio electoral.');
  store.set('nombre', nombre); store.set('colegio', colegio);
  const prov = $('u-prov').value, mun = $('u-mun').value;
  if (!prov) return err('Elige la provincia.');
  if (!mun) return err('Elige el municipio.');
  const distrito = modo === 'manual' ? $('u-dist-m').value.trim() : $('u-dist').value;
  const seccion = modo === 'manual' ? $('u-secc-m').value.trim() : $('u-secc').value;
  if (!distrito) return err('Elige el distrito.');
  if (!seccion) return err('Elige la sección.');
  const escrita = modo === 'manual' || mesaAMano;
  const mesa = escrita ? $('u-mesa-m').value.trim().toUpperCase() : $('u-mesa').value;
  if (!mesa || mesa.startsWith('__')) return err(escrita ? 'Escribe la letra de la mesa (U, A, B…).' : 'Elige la mesa.');
  if (!/^[A-Z]{1,2}$/.test(mesa)) return err('La mesa es una letra: U, A, B, C…');
  const u = { provincia: prov, municipio: mun, distrito: distrito.padStart(2, '0'), seccion: seccion.padStart(3, '0'), mesa };
  u.colegio = colegio;
  borrador.ubicacion = u; borrador.nombre = nombre;
  store.set('ultima-mesa', u);
  if (borrador.clase === 'reclamacion') return irReclamacion();
  // ¿Otra persona ya ha enviado el acta de esta mesa? Se avisa para no duplicarla.
  if (navigator.onLine !== false) {
    let ex = null;
    try { ex = await api(`/api/existe?${new URLSearchParams({ tipo: borrador.tipo, provincia: u.provincia, municipio: u.municipio, distrito: u.distrito, seccion: u.seccion, mesa: u.mesa })}`); } catch {}
    if (ex?.existe) { avisoYaEnviada(ex, u); return; }
  }
  irVotos();
});
function avisoYaEnviada(ex, u) {
  const hora = new Date(ex.recibido).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const quien = ex.mia ? 'desde este móvil' : `por <b>${esc(ex.nombre || 'otro apoderado')}</b>`;
  modal(`<div class="big">ℹ️</div><h2 style="justify-content:center">Esta mesa ya tiene acta</h2>
    <p>El acta del <b>${nombreTipo(borrador.tipo)}</b> de <b>${esc(u.municipio)} · Dist. ${Number(u.distrito)} · Secc. ${Number(u.seccion)} · Mesa ${esc(u.mesa)}</b> ya se envió ${quien} a las ${hora}.</p>
    <p class="muted">Puedes enviarla igualmente: <b>en los resultados cuenta una sola vez</b>. Si tus números coinciden, sirve de confirmación; si alguno es distinto, el equipo la revisará.</p>
    <button class="btn" id="b-ya-enviar">Enviar igualmente</button><button class="btn secondary" id="b-ya-no">No enviar</button>`, { cerrar: false });
  $('b-ya-enviar').onclick = () => { cerrarModal(); irVotos(); };
  $('b-ya-no').onclick = () => { cerrarModal(); borrador = null; inicio(); };
}

// ---------- paso 2: votos ----------
// Candidaturas que se presentan en esa provincia (sin "orden" = en todas)
// ...y en el mismo orden que el acta de esa provincia.
const partidosDe = (prov) => cfg.partidos
  .filter((p) => !p.orden || !Object.keys(p.orden).length || p.orden[prov] != null)
  .map((p, i) => ({ p, k: p.orden?.[prov] ?? 1000 + i })).sort((a, b) => a.k - b.k).map((x) => x.p);
// Lo que se vota en el acta: candidaturas (Congreso) o candidatos de la provincia (Senado).
const listaVotos = (tipo, prov) => (tipo === 'senado' ? cfg.senado?.[prov] || [] : partidosDe(prov));
const numIds = ['v-censo', 'v-votantes', 'v-nulos', 'v-blancos'];
function irVotos() {
  const u = borrador.ubicacion;
  $('v-mun').textContent = `${u.municipio} (${u.provincia})`;
  $('v-mesa').textContent = `${u.colegio} · Distrito ${u.distrito} · Sección ${u.seccion} · Mesa ${u.mesa}`;
  $('v-thumb').classList.toggle('hidden', !borrador.foto);
  if (borrador.foto) $('v-thumb').src = borrador.foto;
  const v = (borrador.votos?.tipo === borrador.tipo ? borrador.votos : null) || {};
  const senado = borrador.tipo === 'senado';
  $('v-tipo').textContent = nombreTipo(borrador.tipo);
  $('l-nulos').textContent = senado ? 'Papeletas nulas' : 'Votos nulos';
  $('l-blancos').textContent = senado ? 'Papeletas en blanco' : 'Votos en blanco';
  $('v-titulo').textContent = senado ? '🗳️ Votos a cada candidato' : '🗳️ Votos por partido';
  $('v-ayuda').classList.toggle('hidden', !senado);
  const hecho = borrador.tipo + u.provincia + JSON.stringify(senado ? cfg.senado : cfg.partidos);
  if ($('v-partidos').dataset.hecho !== hecho) {
    const caja = $('v-partidos');
    if (senado) {
      caja.className = '';
      let partido = null;
      caja.innerHTML = listaVotos('senado', u.provincia).map((c) => {
        const cab = c.partido !== partido ? `<div class="grupo-partido"><span class="dot" style="background:${esc(c.color)}"></span>${esc(c.partido)}</div>` : '';
        partido = c.partido;
        return cab + `<div class="cand"><label for="p-${esc(c.id)}">${esc(c.nombre)}</label><input id="p-${esc(c.id)}" inputmode="numeric" pattern="[0-9]*"></div>`;
      }).join('');
    } else {
      caja.className = 'grid2';
      caja.innerHTML = listaVotos('congreso', u.provincia).map((p) => `<div><label for="p-${esc(p.id)}" class="party"><span class="dot" style="background:${esc(p.color)}"></span>${p.orden?.[u.provincia] ? p.orden[u.provincia] + '. ' : ''}${esc(p.nombre)}</label><input id="p-${esc(p.id)}" inputmode="numeric" pattern="[0-9]*"></div>`).join('');
    }
    caja.dataset.hecho = hecho;
    caja.querySelectorAll('input').forEach((i) => i.addEventListener('input', recalcular));
  }
  $('v-censo').value = v.censo ?? (u.electores ?? '');
  $('v-votantes').value = v.votantes ?? '';
  $('v-nulos').value = v.nulos ?? '';
  $('v-blancos').value = v.blancos ?? '';
  listaVotos(borrador.tipo, u.provincia).forEach((p) => { $('p-' + p.id).value = v.partidos?.[p.id] ?? ''; });
  // Campos que la IA no ha podido leer: vacíos y marcados en amarillo.
  const dudosos = v.deLectura ? [...numIds.map((id) => $(id)), ...listaVotos(borrador.tipo, u.provincia).map((p) => $('p-' + p.id))].filter((i) => i.value === '') : [];
  document.querySelectorAll('#s-votos input').forEach((i) => i.classList.toggle('revisar', dudosos.includes(i)));
  avisoLectura('v-ia', v.deLectura ? borrador.lectura : null, dudosos.length ? `${dudosos.length} casilla(s) en amarillo no se han podido leer: complétalas.` : '');
  $('v-obs').value = borrador.observaciones || '';
  recalcular();
  show('s-votos');
}
numIds.forEach((id) => $(id).addEventListener('input', recalcular));
document.addEventListener('input', (e) => {
  if (e.target.matches('input[inputmode="numeric"]')) e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
}, true);
const n = (id) => Number($(id).value || 0);

function leerVotos() {
  const partidos = {};
  listaVotos(borrador.tipo, borrador.ubicacion.provincia).forEach((p) => { partidos[p.id] = n('p-' + p.id); });
  return { tipo: borrador.tipo, censo: n('v-censo'), votantes: n('v-votantes'), nulos: n('v-nulos'), blancos: n('v-blancos'), partidos };
}
function recalcular() {
  if (!borrador) return;
  const v = leerVotos();
  borrador.votos = v;
  if (borrador.tipo === 'senado') return recalcularSenado(v);
  const suma = Object.values(v.partidos).reduce((a, b) => a + b, 0) + v.nulos + v.blancos;
  const dif = v.votantes - suma;
  const st = $('v-status');
  const detalle = `<small>Partidos ${suma - v.nulos - v.blancos} + nulos ${v.nulos} + blancos ${v.blancos}</small>`;
  if (dif === 0 && v.votantes > 0) {
    st.className = 'status ok';
    st.innerHTML = `<div>✓ Los votos cuadran${detalle}</div><div class="num">${suma} de ${v.votantes}</div>`;
  } else {
    st.className = 'status bad';
    const txt = v.votantes === 0 ? 'Escribe el total de votantes' : dif > 0 ? `Faltan ${dif} votos` : `Sobran ${-dif} votos`;
    st.innerHTML = `<div>⚠ ${txt}${detalle}</div><div class="num">${suma} de ${v.votantes}</div>`;
  }
  if (v.censo && v.votantes > v.censo) { st.className = 'status bad'; st.firstElementChild.insertAdjacentHTML('beforeend', '<small><b>Hay más votantes que electores.</b></small>'); }
  return dif;
}
// Senado: cada papeleta puede llevar hasta 3 candidatos marcados, así que no se compara con los votantes,
// sino que se comprueba que los votos sean posibles.
function recalcularSenado(v) {
  const papeletas = v.votantes - v.nulos - v.blancos;
  const vals = Object.values(v.partidos);
  const suma = vals.reduce((a, b) => a + b, 0), max = Math.max(0, ...vals);
  const problemas = [];
  if (!v.votantes) problemas.push('Escribe el total de votantes');
  else if (papeletas < 0) problemas.push('Nulas + en blanco superan a los votantes');
  else {
    if (max > papeletas) problemas.push(`Un candidato tiene más votos (${max}) que papeletas válidas (${papeletas})`);
    if (suma > 3 * papeletas) problemas.push(`Hay más votos (${suma}) de los posibles (máx. 3 por papeleta: ${3 * papeletas})`);
    if (papeletas > 0 && suma < papeletas) problemas.push(`Hay menos votos (${suma}) que papeletas con voto (${papeletas})`);
  }
  if (v.censo && v.votantes > v.censo) problemas.push('Hay más votantes que electores');
  const st = $('v-status');
  const detalle = `<small>Papeletas con voto: ${Math.max(0, papeletas)} · Votos a candidatos: ${suma} (máx. ${Math.max(0, 3 * papeletas)})</small>`;
  st.className = 'status ' + (problemas.length ? 'bad' : 'ok');
  st.innerHTML = problemas.length ? `<div>⚠ ${esc(problemas[0])}${detalle}</div>` : `<div>✓ Los datos son coherentes${detalle}</div>`;
  return problemas.length ? problemas[0] : 0;
}
$('v-thumb').addEventListener('click', () => modal(`<img class="zoom" src="${borrador.foto}" alt=""><div style="height:10px"></div><button class="btn" data-close>Cerrar</button>`));
$('v-obs').addEventListener('input', () => { borrador.observaciones = $('v-obs').value; });

$('b-enviar').addEventListener('click', async () => {
  const dif = recalcular();
  const v = borrador.votos;
  if (!v.votantes) return alert('Falta el total de votantes.');
  if (dif !== 0) {
    const txt = typeof dif === 'string' ? dif : `Los votos NO cuadran (${dif > 0 ? 'faltan ' + dif : 'sobran ' + -dif})`;
    if (!confirm(`${txt}.\n\nRevisa cada cifra con el acta. Si el acta está así, explícalo en Observaciones.\n\n¿Enviar igualmente?`)) return;
  }
  if (!borrador.foto && !confirm('Vas a enviar el acta SIN foto. ¿Seguro?')) return;

  const envio = { tipo: borrador.tipo, nombre: borrador.nombre, clientId: borrador.clientId, ubicacion: borrador.ubicacion, votos: v, observaciones: $('v-obs').value, foto: borrador.foto || null, creado: new Date().toISOString() };
  modal('<div class="spinner"></div><p>Enviando acta…</p>', { cerrar: false });
  try {
    const r = await api('/api/actas', { method: 'POST', body: envio });
    borrador.enviado = true;
    const u = envio.ubicacion;
    if (r.duplicada) modal(`<div class="big">✅</div><h2 style="justify-content:center">Acta enviada</h2><p>Coincide con la que ya había enviado otra persona: <b>queda confirmada</b> y en los resultados cuenta una sola vez.</p><button class="btn" data-close>OK</button>`);
    else modal(`<div class="big">✅</div><h2 style="justify-content:center">Acta del ${nombreTipo(envio.tipo)} enviada</h2><p>${esc(u.municipio)} · Distrito ${esc(u.distrito)} · Sección ${esc(u.seccion)} · Mesa ${esc(u.mesa)}</p><button class="btn" data-close>OK</button>`);
    borrador = null;
    inicio();
  } catch (e) {
    if (e.status && e.status < 500) {
      modal(`<div class="big">⚠️</div><h2 style="justify-content:center">No se ha enviado</h2><p>${esc(e.message)}</p><button class="btn" data-close>Volver</button>`);
      return;
    }
    // Sin conexión o error del servidor: a la cola, se reintenta solo.
    await DB.put(envio);
    borrador = null;
    modal(`<div class="big">📶</div><h2 style="justify-content:center">Sin conexión</h2><p>El acta se ha guardado en el móvil y <b>se enviará sola</b> cuando haya cobertura.</p><p class="muted">No está enviada hasta que en la lista ponga «Enviada».</p><button class="btn" data-close>Entendido</button>`);
    inicio();
  }
});

// ---------- instalar la app en el móvil ----------
// Android/Chrome: el navegador ofrece la instalación (beforeinstallprompt). iPhone: hay que hacerlo desde Safari a mano.
const instalada = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const esIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const esSafariIOS = esIOS && !/crios|fxios|edgios|opios/i.test(navigator.userAgent);
const esMovil = esIOS || /android/i.test(navigator.userAgent);
let avisoInstalar = null;
function mostrarInstalar() { $('instalar').classList.toggle('hidden', instalada() || !(avisoInstalar || esMovil)); }
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); avisoInstalar = e; mostrarInstalar(); });
window.addEventListener('appinstalled', () => { avisoInstalar = null; $('instalar').classList.add('hidden'); });
$('b-instalar').addEventListener('click', async () => {
  if (avisoInstalar) { avisoInstalar.prompt(); await avisoInstalar.userChoice.catch(() => {}); avisoInstalar = null; mostrarInstalar(); return; }
  if (esIOS && !esSafariIOS) {
    modal('<div class="big">🧭</div><h2 style="justify-content:center">Ábrela en Safari</h2><p>En iPhone solo se puede instalar desde <b>Safari</b>. Copia el enlace, ábrelo en Safari y pulsa otra vez «Instalar».</p><button class="btn" data-close>Entendido</button>');
  } else if (esIOS) {
    modal('<h2 style="justify-content:center">Instalar en el iPhone</h2><ol style="text-align:left;line-height:1.6;padding-left:22px"><li>Pulsa el botón <b>Compartir</b> <span style="font-size:1.3em">⬆️</span> (abajo en el centro, o arriba en iPad).</li><li>Baja y elige <b>«Añadir a pantalla de inicio»</b> ➕.</li><li>Pulsa <b>«Añadir»</b>. Ya tendrás el icono de la urna en tu pantalla.</li></ol><button class="btn" data-close>Entendido</button>');
  } else {
    modal('<h2 style="justify-content:center">Instalar en el móvil</h2><ol style="text-align:left;line-height:1.6;padding-left:22px"><li>Abre el menú del navegador <b>⋮</b> (arriba a la derecha).</li><li>Elige <b>«Instalar aplicación»</b> o <b>«Añadir a pantalla de inicio»</b>.</li><li>Confirma. Ya tendrás el icono de la urna en tu pantalla.</li></ol><button class="btn" data-close>Entendido</button>');
  }
});
mostrarInstalar();

// ---------- arranque ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
(async () => {
  show('s-home');
  try { await cargarConfig(); } catch {}
  if (!cfg) {
    modal('<div class="big">📶</div><h2 style="justify-content:center">Sin conexión</h2><p>La primera vez hace falta cobertura para abrir la app.</p><button class="btn" onclick="location.reload()">Reintentar</button>', { cerrar: false });
    return;
  }
  // No cambiamos de pantalla: el apoderado puede haber empezado ya mientras cargaba.
  pintarInicio(); vaciarCola();
})();

// Ocultar el aviso del paso 1 en cuanto se corrige algún dato.
$('s-ubic').addEventListener('input', () => $('u-err').classList.add('hidden'));
$('s-ubic').addEventListener('change', () => $('u-err').classList.add('hidden'));
