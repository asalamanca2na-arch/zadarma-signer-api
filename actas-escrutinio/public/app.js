// App del apoderado: foto del acta -> mesa -> votos -> enviar (con cola sin conexión).
'use strict';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

let sesion = store.get('sesion', null);
let cfg = store.get('cfg', null);
let borrador = null; // acta en curso
let mesasMunicipio = [];

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
function cerrarModal() { $('modal').classList.remove('open'); }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(sesion ? { Authorization: 'Bearer ' + sesion.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.codigo === 'auth') { salir(); throw Object.assign(new Error('Sesión caducada. Vuelve a entrar.'), { status: 401 }); }
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
  if (enviando || !sesion) return;
  enviando = true;
  try {
    for (const p of await DB.all()) {
      try {
        await api('/api/actas', { method: 'POST', body: p });
        await DB.del(p.clientId);
      } catch (e) {
        if (!e.status) break; // sin conexión: lo intentamos más tarde
        if (e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429) { await DB.del(p.clientId); alert('Un acta pendiente tenía datos no válidos y se ha descartado: ' + e.message); }
        else break;
      }
    }
  } finally { enviando = false; await pintarInicio(); }
}
window.addEventListener('online', vaciarCola);
setInterval(vaciarCola, 30000);

// ---------- login ----------
$('f-login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('l-err').classList.add('hidden');
  try {
    sesion = await api('/api/login', { method: 'POST', body: { telefono: $('l-tel').value, pin: $('l-pin').value } });
    store.set('sesion', sesion);
    await cargarConfig();
    await inicio();
  } catch (e) {
    $('l-err').textContent = e.status ? e.message : 'No hay conexión. Inténtalo cuando tengas cobertura.';
    $('l-err').classList.remove('hidden');
  }
});
function salir() { sesion = null; store.del('sesion'); show('s-login'); }
$('b-logout').addEventListener('click', async () => {
  const pend = (await DB.all()).length;
  if (pend && !confirm(`Tienes ${pend} acta(s) sin enviar. Si sales no se enviarán hasta que vuelvas a entrar. ¿Salir?`)) return;
  salir();
});

async function cargarConfig() {
  try { cfg = await api('/api/config'); store.set('cfg', cfg); } catch (e) { if (!cfg) throw e; }
}

// ---------- inicio ----------
async function pintarInicio() {
  if (!sesion) return;
  $('h-nombre').textContent = sesion.nombre || '';
  $('h-eleccion').textContent = cfg?.eleccion || 'Elecciones';
  const pend = await DB.all().catch(() => []);
  $('h-pend').classList.toggle('hidden', !pend.length);
  $('h-pend-n').textContent = pend.length;
  let enviadas = store.get('mis-actas', []);
  try { enviadas = await api('/api/mis-actas'); store.set('mis-actas', enviadas); } catch {}
  const items = [
    ...pend.map((p) => `<li><div class="grow"><b>${esc(p.ubicacion.municipio)}</b><div class="muted">Dist. ${esc(p.ubicacion.distrito)} · Secc. ${esc(p.ubicacion.seccion)} · Mesa ${esc(p.ubicacion.mesa)}</div></div><span class="pill wait">Pendiente</span></li>`),
    ...enviadas.sort((a, b) => b.recibido.localeCompare(a.recibido)).map((a) => `<li><div class="grow"><b>${esc(a.municipio)}</b><div class="muted">Dist. ${esc(a.distrito)} · Secc. ${esc(a.seccion)} · Mesa ${esc(a.mesa)} · ${new Date(a.recibido).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</div></div><span class="pill ${a.cuadra ? 'ok' : 'bad'}">${a.cuadra ? 'Enviada' : 'Enviada · revisar'}</span></li>`),
  ];
  $('h-lista').innerHTML = items.join('') || '<li class="muted">Todavía no has enviado ninguna.</li>';
}
async function inicio() { show('s-home'); await pintarInicio(); vaciarCola(); }

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
  const MAX = 1800;
  const s = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
  const c = document.createElement('canvas');
  const girada = rot % 180 !== 0;
  c.width = girada ? h : w; c.height = girada ? w : h;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2); ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  return c.toDataURL('image/jpeg', 0.72);
}
$('b-rotar').addEventListener('click', () => {
  borrador.rot = (borrador.rot + 90) % 360;
  borrador.foto = comprimir(borrador.imagen, borrador.rot);
  $('f-img').src = borrador.foto;
});
$('b-foto-ok').addEventListener('click', irUbicacion);

function nuevoBorrador(foto) {
  borrador = { clientId: (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2)), foto, rot: 0 };
}

// ---------- paso 1: ubicación ----------
function irUbicacion() {
  const ult = store.get('ultima-mesa', {});
  const sel = $('u-prov');
  sel.innerHTML = '<option value="">Elige…</option>' + (cfg?.provincias || ['Barcelona', 'Girona', 'Lleida', 'Tarragona']).map((p) => `<option>${esc(p)}</option>`).join('');
  sel.value = ult.provincia || '';
  $('u-mun').value = ult.municipio || '';
  $('u-dist').value = ult.distrito || '';
  $('u-secc').value = ult.seccion || '';
  $('u-mesa').value = ult.mesa || 'U';
  $('u-err').classList.add('hidden');
  rellenarMunicipios();
  mesasCargadas = null; mesasMunicipio = [];
  cargarMesas(ult);
  show('s-ubic');
}
$('b-ubic-back').addEventListener('click', () => show(borrador?.foto ? 's-foto' : 's-home'));
function rellenarMunicipios() {
  const lista = cfg?.municipios?.[$('u-prov').value] || [];
  $('dl-mun').innerHTML = lista.map((m) => `<option value="${esc(m)}">`).join('');
}
$('u-prov').addEventListener('change', () => { rellenarMunicipios(); $('u-mun').value = ''; cargarMesas(); });
$('u-mun').addEventListener('change', () => cargarMesas());

let mesasCargadas = null; // provincia|municipio de la lista mostrada
async function cargarMesas(preferida) {
  const prov = $('u-prov').value, mun = $('u-mun').value.trim();
  const key = prov + '|' + mun.toLowerCase();
  if (key === mesasCargadas && !preferida) return; // ya está cargada: no tocar la selección
  mesasCargadas = key;
  let lista = [];
  if (cfg?.hayListadoMesas && prov && mun) {
    try { lista = await api(`/api/mesas?provincia=${encodeURIComponent(prov)}&municipio=${encodeURIComponent(mun)}`); } catch {}
  }
  if (key !== mesasCargadas) return; // respuesta antigua: la ignoramos
  mesasMunicipio = lista;
  const hay = mesasMunicipio.length > 0;
  $('u-mesa-sel').classList.toggle('hidden', !hay);
  $('u-mesa-manual').classList.toggle('hidden', hay);
  if (hay) {
    $('u-mesa-list').innerHTML = '<option value="">Elige tu mesa…</option>' + mesasMunicipio.map((m, i) =>
      `<option value="${i}">Distrito ${esc(m.distrito)} · Sección ${esc(m.seccion)} · Mesa ${esc(m.mesa)}</option>`).join('') +
      '<option value="otra">Mi mesa no aparece…</option>';
    if (preferida) {
      const i = mesasMunicipio.findIndex((m) => m.distrito === preferida.distrito && m.seccion === preferida.seccion && m.mesa === preferida.mesa);
      if (i >= 0) $('u-mesa-list').value = String(i);
    }
  }
}
$('u-mesa-list').addEventListener('change', () => {
  if ($('u-mesa-list').value === 'otra') {
    if (confirm('Si el acta pone esa mesa, no elijas otra: escríbela a mano. ¿Continuar?')) {
      $('u-mesa-sel').classList.add('hidden'); $('u-mesa-manual').classList.remove('hidden'); mesasMunicipio = [];
    } else $('u-mesa-list').value = '';
  }
});

$('b-ubic-ok').addEventListener('click', () => {
  const err = (t) => { $('u-err').textContent = t; $('u-err').classList.remove('hidden'); };
  const prov = $('u-prov').value, mun = $('u-mun').value.trim();
  if (!prov) return err('Elige la provincia.');
  if (!mun) return err('Escribe el municipio.');
  let u;
  if (mesasMunicipio.length) {
    const m = mesasMunicipio[Number($('u-mesa-list').value)];
    if (!m || $('u-mesa-list').value === '') return err('Elige la mesa.');
    u = { provincia: prov, municipio: mun, distrito: m.distrito, seccion: m.seccion, mesa: m.mesa, electores: m.electores };
  } else {
    u = { provincia: prov, municipio: mun, distrito: $('u-dist').value.trim(), seccion: $('u-secc').value.trim(), mesa: $('u-mesa').value };
    if (!u.distrito || !u.seccion) return err('Completa distrito y sección.');
    if (cfg?.municipios?.[prov]?.length && !cfg.municipios[prov].some((x) => x.toLowerCase() === mun.toLowerCase()))
      if (!confirm(`"${mun}" no está en el listado de ${prov}. ¿Seguro que está bien escrito?`)) return;
  }
  borrador.ubicacion = u;
  store.set('ultima-mesa', u);
  irVotos();
});

// ---------- paso 2: votos ----------
const numIds = ['v-censo', 'v-votantes', 'v-nulos', 'v-blancos'];
function irVotos() {
  const u = borrador.ubicacion;
  $('v-mun').textContent = `${u.municipio} (${u.provincia})`;
  $('v-mesa').textContent = `Distrito ${u.distrito} · Sección ${u.seccion} · Mesa ${u.mesa}`;
  $('v-thumb').classList.toggle('hidden', !borrador.foto);
  if (borrador.foto) $('v-thumb').src = borrador.foto;
  const v = borrador.votos || {};
  if (!$('v-partidos').dataset.hecho || $('v-partidos').dataset.hecho !== JSON.stringify(cfg.partidos)) {
    $('v-partidos').innerHTML = cfg.partidos.map((p) => `<div><label for="p-${esc(p.id)}" class="party"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.nombre)}</label><input id="p-${esc(p.id)}" data-partido="${esc(p.id)}" inputmode="numeric" pattern="[0-9]*"></div>`).join('');
    $('v-partidos').dataset.hecho = JSON.stringify(cfg.partidos);
    $('v-partidos').querySelectorAll('input').forEach((i) => i.addEventListener('input', recalcular));
  }
  $('v-censo').value = v.censo ?? (u.electores ?? '');
  $('v-votantes').value = v.votantes ?? '';
  $('v-nulos').value = v.nulos ?? '';
  $('v-blancos').value = v.blancos ?? '';
  cfg.partidos.forEach((p) => { $('p-' + p.id).value = v.partidos?.[p.id] ?? ''; });
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
  cfg.partidos.forEach((p) => { partidos[p.id] = n('p-' + p.id); });
  return { censo: n('v-censo'), votantes: n('v-votantes'), nulos: n('v-nulos'), blancos: n('v-blancos'), partidos };
}
function recalcular() {
  if (!borrador) return;
  const v = leerVotos();
  borrador.votos = v;
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
$('v-thumb').addEventListener('click', () => modal(`<img class="zoom" src="${borrador.foto}" alt=""><div style="height:10px"></div><button class="btn" data-close>Cerrar</button>`));
$('v-obs').addEventListener('input', () => { borrador.observaciones = $('v-obs').value; });

$('b-enviar').addEventListener('click', async () => {
  const dif = recalcular();
  const v = borrador.votos;
  if (!v.votantes) return alert('Falta el total de votantes.');
  if (dif !== 0 && !confirm(`Los votos NO cuadran (${dif > 0 ? 'faltan ' + dif : 'sobran ' + -dif}).\n\nRevisa cada cifra con el acta. Si el acta está así, explícalo en Observaciones.\n\n¿Enviar igualmente?`)) return;
  if (!borrador.foto && !confirm('Vas a enviar el acta SIN foto. ¿Seguro?')) return;

  const envio = { clientId: borrador.clientId, ubicacion: borrador.ubicacion, votos: v, observaciones: $('v-obs').value, foto: borrador.foto || null, creado: new Date().toISOString() };
  modal('<div class="spinner"></div><p>Enviando acta…</p>', { cerrar: false });
  try {
    await api('/api/actas', { method: 'POST', body: envio });
    borrador.enviado = true;
    const u = envio.ubicacion;
    modal(`<div class="big">✅</div><h2 style="justify-content:center">Acta enviada</h2><p>${esc(u.municipio)} · Distrito ${esc(u.distrito)} · Sección ${esc(u.seccion)} · Mesa ${esc(u.mesa)}</p><button class="btn" data-close>OK</button>`);
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

// ---------- arranque ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
(async () => {
  if (!sesion) return show('s-login');
  try { await cargarConfig(); } catch {}
  if (!cfg) return show('s-login');
  inicio();
})();
