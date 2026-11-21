// Servidor de recuento de actas de escrutinio (Catalunya).
// Sin dependencias: solo Node.js >= 18. Los datos se guardan en ./data como JSON.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const ACTAS_DIR = path.join(DATA_DIR, 'actas');
const FOTOS_DIR = path.join(DATA_DIR, 'fotos');
const MAX_BODY = 12 * 1024 * 1024; // 12 MB (foto incluida)

for (const d of [DATA_DIR, ACTAS_DIR, FOTOS_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------- utilidades de ficheros ----------
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // escritura atómica
}

// ---------- secretos ----------
const secretFile = path.join(DATA_DIR, 'secret.key');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'));
const SECRET = process.env.APP_SECRET || fs.readFileSync(secretFile, 'utf8').trim();

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const adminPassFile = path.join(DATA_DIR, 'admin-password.txt');
if (!ADMIN_PASSWORD) {
  if (!fs.existsSync(adminPassFile)) fs.writeFileSync(adminPassFile, crypto.randomBytes(6).toString('base64url'));
  ADMIN_PASSWORD = fs.readFileSync(adminPassFile, 'utf8').trim();
}

// ---------- configuración ----------
const PROVINCIAS = ['Barcelona', 'Girona', 'Lleida', 'Tarragona'];
// Elecciones generales 29-N-2026, Congreso. Candidaturas según la prensa (verificar con el BOE de proclamación).
// "provincias" vacío = se presenta en las 4 circunscripciones catalanas.
const DEFAULT_CONFIG = {
  eleccion: 'Generales 29-N 2026 · Congreso',
  partidos: [
    { id: 'pp', nombre: 'PP', color: '#1d84ce', provincias: [] },
    { id: 'psc', nombre: 'PSC', color: '#e30613', provincias: [] },
    { id: 'junts', nombre: 'Junts', color: '#20c0b2', provincias: [] },
    { id: 'erc', nombre: 'ERC', color: '#f4b400', provincias: [] },
    { id: 'comuns', nombre: 'Comuns-Front Ampli', color: '#8a3f8f', provincias: [] },
    { id: 'vox', nombre: 'VOX', color: '#63be21', provincias: [] },
    { id: 'alhora', nombre: 'Alhora', color: '#f26522', provincias: [] },
    { id: 'salf', nombre: 'SALF', color: '#6b4f2a', provincias: ['Barcelona'] },
    { id: 'fo', nombre: 'FO', color: '#9e1b1b', provincias: ['Barcelona'] },
    { id: 'pctc', nombre: 'PCTC', color: '#c00000', provincias: ['Barcelona'] },
    { id: 'pacma', nombre: 'PACMA', color: '#2e9e57', provincias: ['Barcelona'] },
    { id: 'd21', nombre: 'D21', color: '#5a6b7b', provincias: ['Barcelona'] },
    { id: 'mundo-justo', nombre: 'Mundo+Justo', color: '#7a8a99', provincias: ['Barcelona'] },
    { id: 'otros', nombre: 'Otras candidaturas', color: '#9aa5b1', provincias: [] },
  ],
};
const configFile = path.join(DATA_DIR, 'config.json');
const apoderadosFile = path.join(DATA_DIR, 'apoderados.json');
const mesasFile = path.join(DATA_DIR, 'mesas.json');

let config = readJSON(configFile, null);
if (!config) { config = DEFAULT_CONFIG; writeJSON(configFile, config); }
let apoderados = readJSON(apoderadosFile, []);
let mesas = readJSON(mesasFile, []);
let mesasIndex = new Map();
function indexarMesas() { mesasIndex = new Map(mesas.map((x) => [mesaKey(x), x])); }

indexarMesas();

// ---------- actas en memoria ----------
const actas = new Map(); // mesaId -> acta
for (const f of fs.readdirSync(ACTAS_DIR)) {
  if (!f.endsWith('.json')) continue;
  const a = readJSON(path.join(ACTAS_DIR, f), null);
  if (a && a.id) actas.set(a.id, a);
}

// ---------- normalización ----------
function norm(s) {
  return String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
}
function padNum(v, n) {
  const s = String(v ?? '').trim();
  return /^\d+$/.test(s) ? s.padStart(n, '0') : s.toUpperCase();
}
function normTelefono(t) {
  let d = String(t ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('34')) d = d.slice(2);
  if (d.length === 13 && d.startsWith('0034')) d = d.slice(4);
  return d;
}
function mesaKey(u) {
  return [norm(u.provincia), norm(u.municipio), padNum(u.distrito, 2), padNum(u.seccion, 3), String(u.mesa ?? '').trim().toUpperCase()].join('|');
}
function fileIdFor(id) { return crypto.createHash('sha1').update(id).digest('hex').slice(0, 20); }
function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

// ---------- CSV ----------
function parseCSV(text) {
  text = String(text || '').replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const sep = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => norm(h));
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}
function csvCell(v) {
  const s = String(v ?? '');
  return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ---------- tokens ----------
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch { return null; }
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- límite de intentos de login ----------
const intentos = new Map();
function rateLimited(key) {
  const now = Date.now();
  const e = intentos.get(key) || { n: 0, t: now };
  if (now - e.t > 10 * 60 * 1000) { e.n = 0; e.t = now; }
  e.n++;
  intentos.set(key, e);
  return e.n > 15;
}

// ---------- HTTP helpers ----------
function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': typeof data === 'object' && !Buffer.isBuffer(data) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Demasiado grande'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function getToken(req, url) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return url.searchParams.get('t');
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin') pathname = '/admin.html';
  const file = path.join(PUBLIC_DIR, path.normalize(pathname).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Prohibido');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'No encontrado');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ---------- lógica de actas ----------
function calcula(a) {
  const sumaPartidos = Object.values(a.votos).reduce((s, n) => s + (n || 0), 0);
  const total = sumaPartidos + a.blancos + a.nulos;
  a.validos = sumaPartidos + a.blancos;
  a.diferencia = a.votantes - total; // >0 faltan votos, <0 sobran
  a.cuadra = a.diferencia === 0;
  const avisos = [];
  if (!a.cuadra) avisos.push(a.diferencia > 0 ? `Faltan ${a.diferencia} votos` : `Sobran ${-a.diferencia} votos`);
  if (a.censo && a.votantes > a.censo) avisos.push('Más votantes que electores');
  const m = mesasIndex.get(a.id);
  if (m && toInt(m.electores) && a.censo && toInt(m.electores) !== a.censo) avisos.push(`Censo distinto al oficial (${m.electores})`);
  if (mesas.length && !m) avisos.push('Mesa no está en el listado');
  if (a.conflicto) avisos.push('Hay otra versión distinta del acta');
  if (a.observaciones) avisos.push('Tiene observaciones');
  a.avisos = avisos;
  a.incidencia = avisos.length > 0;
  return a;
}
function resumenActa(a) {
  const { historial, ...rest } = a;
  return { ...rest, versiones: (historial || []).length + 1 };
}

function guardarActa(body, user) {
  const u = body.ubicacion || {};
  const provincia = PROVINCIAS.find((p) => norm(p) === norm(u.provincia));
  if (!provincia) throw Object.assign(new Error('Provincia no válida'), { status: 400 });
  if (!String(u.municipio || '').trim() || !String(u.seccion || '').trim() || !String(u.mesa || '').trim() || !String(u.distrito || '').trim())
    throw Object.assign(new Error('Faltan datos de la mesa'), { status: 400 });

  const ubic = {
    provincia,
    municipio: String(u.municipio).trim(),
    distrito: padNum(u.distrito, 2),
    seccion: padNum(u.seccion, 3),
    mesa: String(u.mesa).trim().toUpperCase(),
  };
  const oficial = mesas.find((x) => norm(x.provincia) === norm(provincia) && norm(x.municipio) === norm(ubic.municipio));
  if (oficial) ubic.municipio = oficial.municipio; // nombre tal cual está en el listado oficial
  const id = mesaKey(ubic);
  const v = body.votos || {};
  const votos = {};
  for (const p of config.partidos) votos[p.id] = (p.provincias?.length && !p.provincias.includes(provincia)) ? 0 : (toInt(v.partidos?.[p.id]) ?? 0);
  const datos = {
    censo: toInt(v.censo) ?? 0,
    votantes: toInt(v.votantes) ?? 0,
    nulos: toInt(v.nulos) ?? 0,
    blancos: toInt(v.blancos) ?? 0,
    votos,
  };

  const previa = actas.get(id);
  if (previa && body.clientId && previa.clientId === body.clientId) return previa; // reenvío idempotente

  let foto = null;
  if (typeof body.foto === 'string' && body.foto.startsWith('data:image/')) {
    const m = body.foto.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
    if (m) {
      foto = `${fileIdFor(id)}-${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
      fs.writeFileSync(path.join(FOTOS_DIR, foto), Buffer.from(m[2], 'base64'));
    }
  }

  const acta = {
    id, ...ubic, ...datos,
    observaciones: String(body.observaciones || '').slice(0, 2000).trim(),
    foto: foto || previa?.foto || null,
    enviadoPor: { telefono: user.tel, nombre: user.nombre },
    recibido: new Date().toISOString(),
    clientId: body.clientId || null,
    revisada: false,
    historial: [],
    conflicto: false,
  };
  if (previa) {
    const { historial, ...anterior } = previa;
    acta.historial = [...(historial || []), anterior];
    const mismos = ['censo', 'votantes', 'nulos', 'blancos'].every((k) => anterior[k] === acta[k]) &&
      config.partidos.every((p) => (anterior.votos?.[p.id] ?? 0) === acta.votos[p.id]);
    acta.conflicto = previa.conflicto || !mismos;
  }
  calcula(acta);
  writeJSON(path.join(ACTAS_DIR, fileIdFor(id) + '.json'), acta);
  actas.set(id, acta);
  return acta;
}

function resumen() {
  const lista = [...actas.values()];
  const tot = { actas: lista.length, mesasTotal: mesas.length, censo: 0, votantes: 0, nulos: 0, blancos: 0, validos: 0, incidencias: 0, votos: {} };
  const porMunicipio = {};
  for (const p of config.partidos) tot.votos[p.id] = 0;
  for (const a of lista) {
    tot.censo += a.censo; tot.votantes += a.votantes; tot.nulos += a.nulos; tot.blancos += a.blancos; tot.validos += a.validos;
    if (a.incidencia && !a.revisada) tot.incidencias++;
    const k = norm(a.provincia) + '|' + norm(a.municipio);
    const m = porMunicipio[k] ||= { provincia: a.provincia, municipio: a.municipio, actas: 0, mesasTotal: 0, censo: 0, votantes: 0, validos: 0, votos: {} };
    m.actas++; m.censo += a.censo; m.votantes += a.votantes; m.validos += a.validos;
    for (const p of config.partidos) {
      tot.votos[p.id] += a.votos[p.id] || 0;
      m.votos[p.id] = (m.votos[p.id] || 0) + (a.votos[p.id] || 0);
    }
  }
  for (const me of mesas) {
    const m = porMunicipio[norm(me.provincia) + '|' + norm(me.municipio)];
    if (m) m.mesasTotal++;
  }
  return {
    config, totales: tot,
    municipios: Object.values(porMunicipio).sort((a, b) => b.censo - a.censo),
    actas: lista.map(resumenActa).sort((a, b) => b.recibido.localeCompare(a.recibido)),
    actualizado: new Date().toISOString(),
  };
}

function municipiosConfig() {
  const out = {};
  for (const p of PROVINCIAS) out[p] = [];
  for (const m of mesas) {
    const p = PROVINCIAS.find((x) => norm(x) === norm(m.provincia));
    if (p && !out[p].includes(m.municipio)) out[p].push(m.municipio);
  }
  for (const p of PROVINCIAS) out[p].sort((a, b) => a.localeCompare(b, 'ca'));
  return out;
}

// ---------- router ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;

  if (!p.startsWith('/api/')) return serveStatic(req, res, p);

  const auth = verify(getToken(req, url));
  const isAdmin = auth?.rol === 'admin';
  const isApoderado = auth?.rol === 'apoderado' && apoderados.some((a) => a.telefono === auth.tel);

  // --- públicas ---
  if (m === 'POST' && p === '/api/login') {
    if (rateLimited('l:' + clientIp(req))) return send(res, 429, { error: 'Demasiados intentos. Espera unos minutos.' });
    const b = await readBody(req);
    const tel = normTelefono(b.telefono);
    const ap = apoderados.find((a) => a.telefono === tel);
    if (!ap) return send(res, 403, { error: 'Acceso denegado: este teléfono no está dado de alta.', codigo: 'no_alta' });
    if (!safeEqual(ap.pin, String(b.pin || '').trim())) return send(res, 401, { error: 'PIN incorrecto.' });
    const token = sign({ rol: 'apoderado', tel, nombre: ap.nombre, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 });
    return send(res, 200, { token, nombre: ap.nombre, telefono: tel });
  }
  if (m === 'POST' && p === '/api/admin/login') {
    if (rateLimited('a:' + clientIp(req))) return send(res, 429, { error: 'Demasiados intentos. Espera unos minutos.' });
    const b = await readBody(req);
    if (!safeEqual(ADMIN_PASSWORD, b.password || '')) return send(res, 401, { error: 'Contraseña incorrecta.' });
    return send(res, 200, { token: sign({ rol: 'admin', exp: Date.now() + 1000 * 60 * 60 * 24 * 3 }) });
  }

  // --- apoderados ---
  if (p === '/api/config' && m === 'GET') {
    if (!isApoderado && !isAdmin) return send(res, 401, { error: 'Sesión caducada', codigo: 'auth' });
    return send(res, 200, { eleccion: config.eleccion, partidos: config.partidos, provincias: PROVINCIAS, municipios: municipiosConfig(), hayListadoMesas: mesas.length > 0 });
  }
  if (p === '/api/mesas' && m === 'GET') {
    if (!isApoderado && !isAdmin) return send(res, 401, { error: 'Sesión caducada', codigo: 'auth' });
    const prov = norm(url.searchParams.get('provincia')), mun = norm(url.searchParams.get('municipio'));
    return send(res, 200, mesas.filter((x) => norm(x.provincia) === prov && norm(x.municipio) === mun)
      .map((x) => ({ distrito: padNum(x.distrito, 2), seccion: padNum(x.seccion, 3), mesa: String(x.mesa).toUpperCase(), electores: toInt(x.electores) })));
  }
  if (p === '/api/actas' && m === 'POST') {
    if (!isApoderado) return send(res, 401, { error: 'Sesión caducada', codigo: 'auth' });
    const b = await readBody(req);
    const a = guardarActa(b, auth);
    return send(res, 200, { ok: true, acta: resumenActa(a) });
  }
  if (p === '/api/mis-actas' && m === 'GET') {
    if (!isApoderado) return send(res, 401, { error: 'Sesión caducada', codigo: 'auth' });
    return send(res, 200, [...actas.values()].filter((a) => a.enviadoPor?.telefono === auth.tel ||
      (a.historial || []).some((h) => h.enviadoPor?.telefono === auth.tel)).map(resumenActa));
  }

  // --- administración ---
  if (p.startsWith('/api/admin/')) {
    if (!isAdmin) return send(res, 401, { error: 'Sesión caducada', codigo: 'auth' });

    if (p === '/api/admin/resumen' && m === 'GET') return send(res, 200, resumen());

    if (p === '/api/admin/acta' && m === 'GET') {
      const a = actas.get(url.searchParams.get('id'));
      return a ? send(res, 200, a) : send(res, 404, { error: 'No existe' });
    }
    if (p === '/api/admin/acta/revisada' && m === 'POST') {
      const b = await readBody(req);
      const a = actas.get(b.id);
      if (!a) return send(res, 404, { error: 'No existe' });
      a.revisada = !!b.revisada;
      if (a.revisada) a.conflicto = false;
      calcula(a);
      writeJSON(path.join(ACTAS_DIR, fileIdFor(a.id) + '.json'), a);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/foto' && m === 'GET') {
      const f = path.basename(url.searchParams.get('f') || '');
      const file = path.join(FOTOS_DIR, f);
      if (!f || !fs.existsSync(file)) return send(res, 404, 'No encontrada');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
      return fs.createReadStream(file).pipe(res);
    }
    if (p === '/api/admin/export.csv' && m === 'GET') {
      const cols = ['provincia', 'municipio', 'distrito', 'seccion', 'mesa', 'censo', 'votantes', 'nulos', 'blancos', ...config.partidos.map((x) => x.nombre), 'cuadra', 'avisos', 'observaciones', 'enviado_por', 'telefono', 'recibido'];
      const lines = [cols.map(csvCell).join(';')];
      for (const a of [...actas.values()].sort((x, y) => x.id.localeCompare(y.id))) {
        lines.push([a.provincia, a.municipio, a.distrito, a.seccion, a.mesa, a.censo, a.votantes, a.nulos, a.blancos,
          ...config.partidos.map((x) => a.votos[x.id] ?? 0), a.cuadra ? 'SI' : 'NO', a.avisos.join(' | '), a.observaciones,
          a.enviadoPor?.nombre, a.enviadoPor?.telefono, a.recibido].map(csvCell).join(';'));
      }
      return send(res, 200, '﻿' + lines.join('\r\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="actas.csv"' });
    }
    if (p === '/api/admin/config' && m === 'GET') {
      return send(res, 200, { config, apoderados: apoderados.map(({ pin, ...r }) => ({ ...r, pin: '••••' })), mesas: mesas.length });
    }
    if (p === '/api/admin/config' && m === 'PUT') {
      const b = await readBody(req);
      const partidos = (b.partidos || []).map((x) => ({
        id: String(x.id || x.nombre).trim().toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        nombre: String(x.nombre || '').trim(), color: /^#[0-9a-f]{6}$/i.test(x.color) ? x.color : '#888888',
        provincias: (Array.isArray(x.provincias) ? x.provincias : []).map((p) => PROVINCIAS.find((q) => norm(q) === norm(p))).filter(Boolean),
      })).filter((x) => x.id && x.nombre);
      if (!partidos.length) return send(res, 400, { error: 'Hace falta al menos un partido' });
      if (new Set(partidos.map((x) => x.id)).size !== partidos.length) return send(res, 400, { error: 'Hay partidos repetidos' });
      config = { eleccion: String(b.eleccion || config.eleccion).trim(), partidos };
      writeJSON(configFile, config);
      return send(res, 200, { ok: true, config });
    }
    if (p === '/api/admin/apoderados' && m === 'PUT') {
      const b = await readBody(req);
      const filas = parseCSV(b.csv);
      const nuevos = []; const errores = [];
      filas.forEach((r, i) => {
        const tel = normTelefono(r.telefono || r.telefon || r.movil || r.mobil);
        const pin = String(r.pin || r.codigo || r.codi || '').trim();
        if (tel.length < 9 || !pin) { errores.push(`Fila ${i + 2}: falta teléfono o PIN`); return; }
        nuevos.push({ telefono: tel, nombre: r.nombre || r.nom || '', pin });
      });
      if (!nuevos.length) return send(res, 400, { error: 'No se ha leído ningún apoderado. Columnas: telefono;nombre;pin', errores });
      apoderados = b.anadir ? [...apoderados.filter((a) => !nuevos.some((n) => n.telefono === a.telefono)), ...nuevos] : nuevos;
      writeJSON(apoderadosFile, apoderados);
      return send(res, 200, { ok: true, total: apoderados.length, errores });
    }
    if (p === '/api/admin/mesas' && m === 'PUT') {
      const b = await readBody(req);
      const filas = parseCSV(b.csv);
      const nuevas = []; const errores = [];
      filas.forEach((r, i) => {
        const prov = PROVINCIAS.find((x) => norm(x) === norm(r.provincia || r.provincia_nom || r.prov));
        const mun = r.municipio || r.municipi;
        const dist = r.distrito || r.districte, secc = r.seccion || r.seccio, mesa = r.mesa;
        if (!prov || !mun || !dist || !secc || !mesa) { errores.push(`Fila ${i + 2}: datos incompletos`); return; }
        nuevas.push({ provincia: prov, municipio: mun.trim(), distrito: padNum(dist, 2), seccion: padNum(secc, 3), mesa: mesa.trim().toUpperCase(), electores: toInt(r.electores || r.censo) });
      });
      mesas = nuevas;
      writeJSON(mesasFile, mesas);
      indexarMesas();
      for (const a of actas.values()) calcula(a);
      return send(res, 200, { ok: true, total: mesas.length, errores: errores.slice(0, 50) });
    }
  }

  return send(res, 404, { error: 'No encontrado' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (e.status !== 400 && e.status !== 413) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Error del servidor' });
  });
});

server.listen(PORT, () => {
  console.log(`\n  Recuento de actas en marcha: http://localhost:${PORT}`);
  console.log(`  Panel de control:            http://localhost:${PORT}/admin`);
  console.log(`  Contraseña de administración: ${process.env.ADMIN_PASSWORD ? '(la de ADMIN_PASSWORD)' : ADMIN_PASSWORD}`);
  console.log(`  Datos en: ${DATA_DIR}\n`);
});
