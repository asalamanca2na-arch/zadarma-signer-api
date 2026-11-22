// Servidor de recuento de actas de escrutinio (Catalunya).
// Sin dependencias: solo Node.js >= 18. Los datos se guardan en ./data como JSON.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lector = require('./lector');
const { ZipWriter } = require('./zip');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const ACTAS_DIR = path.join(DATA_DIR, 'actas');
const FOTOS_DIR = path.join(DATA_DIR, 'fotos');
const RECL_DIR = path.join(DATA_DIR, 'reclamaciones');
const MAX_BODY = 12 * 1024 * 1024; // 12 MB (foto incluida)

for (const d of [DATA_DIR, ACTAS_DIR, FOTOS_DIR, RECL_DIR]) fs.mkdirSync(d, { recursive: true });

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
// Elecciones generales 29-N-2026, Congreso. Candidaturas proclamadas según el BOE-A-2026-23103.
// "orden" = posición de la candidatura en el acta/papeleta de cada provincia (si no aparece, no se presenta allí).
const DEFAULT_CONFIG = {
  boeRev: 2,
  eleccion: 'Generales 29-N 2026 · Congreso',
  partidos: [
    { id: 'psc', nombre: 'PSC', color: '#e30613', orden: { Barcelona: 1, Girona: 1, Lleida: 1, Tarragona: 1 } },
    { id: 'junts', nombre: 'Junts', color: '#20c0b2', orden: { Barcelona: 2, Girona: 3, Lleida: 2, Tarragona: 4 } },
    { id: 'erc', nombre: 'ERC', color: '#f4b400', orden: { Barcelona: 3, Girona: 4, Lleida: 4, Tarragona: 2 } },
    { id: 'pp', nombre: 'PP', color: '#1d84ce', orden: { Barcelona: 9, Girona: 10, Lleida: 9, Tarragona: 12 } },
    { id: 'vox', nombre: 'VOX', color: '#63be21', orden: { Barcelona: 7, Girona: 8, Lleida: 7, Tarragona: 8 } },
    { id: 'comuns', nombre: 'Comuns-Front Ampli', color: '#8a3f8f', orden: { Barcelona: 8, Girona: 5, Lleida: 5, Tarragona: 7 } },
    { id: 'alhora', nombre: 'Alhora', color: '#f26522', orden: { Barcelona: 13, Girona: 9, Lleida: 10, Tarragona: 13 } },
    { id: 'fo', nombre: 'Frente Obrero (FO)', color: '#9e1b1b', orden: { Barcelona: 4, Girona: 2, Lleida: 3, Tarragona: 3 } },
    { id: 'salf', nombre: 'Se Acabó La Fiesta (SALF)', color: '#6b4f2a', orden: { Barcelona: 5, Tarragona: 6 } },
    { id: 'pctc', nombre: 'PCTC', color: '#c00000', orden: { Barcelona: 6, Girona: 6, Lleida: 6, Tarragona: 5 } },
    // PACMA y Por un Mundo más Justo: «No proclamada» en Barcelona según el BOE, por eso no figuran allí.
    { id: 'pacma', nombre: 'PACMA', color: '#2e9e57', orden: { Girona: 7, Lleida: 8, Tarragona: 9 } },
    { id: 'mundo-justo', nombre: 'Por un Mundo más Justo', color: '#7a8a99', orden: { Tarragona: 11 } },
    { id: 'd21', nombre: 'Democracia S.21 (D21)', color: '#5a6b7b', orden: { Barcelona: 11 } },
    { id: 'cnv', nombre: 'Convergents (CNV)', color: '#003f7f', orden: { Tarragona: 10 } },
  ],
};
// Senado: candidatos proclamados por provincia, en el orden de la papeleta (BOE-A-2026-23103).
const DEFAULT_SENADO = {
  "Barcelona": [
   {
    "id": "psc-raquel-sanchez-jimenez",
    "nombre": "Raquel Sánchez Jimenez",
    "partido": "PSC",
    "color": "#e30613"
   },
   {
    "id": "psc-gabriel-colome-garcia",
    "nombre": "Gabriel Colomé Garcia",
    "partido": "PSC",
    "color": "#e30613"
   },
   {
    "id": "psc-cristobalina-albendiz-perez",
    "nombre": "Cristobalina Albéndiz Pérez",
    "partido": "PSC",
    "color": "#e30613"
   },
   {
    "id": "jxcat-josep-maria-vida-de-abadal-i-serra",
    "nombre": "Josep Maria Vida de Abadal i Serra",
    "partido": "Junts",
    "color": "#20c0b2"
   },
   {
    "id": "jxcat-anna-cols-i-aguilar",
    "nombre": "Anna Cols i Aguilar",
    "partido": "Junts",
    "color": "#20c0b2"
   },
   {
    "id": "jxcat-oriol-izquierdo-i-llopis",
    "nombre": "Oriol Izquierdo i Llopis",
    "partido": "Junts",
    "color": "#20c0b2"
   },
   {
    "id": "erc-eh-bildu-francesc-marc-alvaro-i-vidal",
    "nombre": "Francesc-Marc Álvaro i Vidal",
    "partido": "ERC-EH Bildu",
    "color": "#f4b400"
   },
   {
    "id": "erc-eh-bildu-mercedes-vidal-lago",
    "nombre": "Mercedes Vidal Lago",
    "partido": "ERC-EH Bildu",
    "color": "#f4b400"
   },
   {
    "id": "erc-eh-bildu-joaquim-pim-camprubi-i-cabane",
    "nombre": "Joaquim (Pim) Camprubí i Cabané",
    "partido": "ERC-EH Bildu",
    "color": "#f4b400"
   },
   {
    "id": "pctc-ferran-peris-serrano",
    "nombre": "Ferran Peris Serrano",
    "partido": "PCTC",
    "color": "#c00000"
   },
   {
    "id": "c-dem-laura-alzamora-merino",
    "nombre": "Laura Alzamora Merino",
    "partido": "Comuns-Front Ampli",
    "color": "#8a3f8f"
   },
   {
    "id": "c-dem-miquel-angel-essomba-gelabert",
    "nombre": "Miquel Àngel Essomba Gelabert",
    "partido": "Comuns-Front Ampli",
    "color": "#8a3f8f"
   },
   {
    "id": "c-dem-aida-llaurado-alvarez",
    "nombre": "Aïda Llauradó Álvarez",
    "partido": "Comuns-Front Ampli",
    "color": "#8a3f8f"
   },
   {
    "id": "vox-maria-elisa-garcia-fuster",
    "nombre": "María Elisa García Fuster",
    "partido": "VOX",
    "color": "#63be21"
   },
   {
    "id": "vox-jorge-mena-galvez",
    "nombre": "Jorge Mena Gálvez",
    "partido": "VOX",
    "color": "#63be21"
   },
   {
    "id": "vox-maria-montserrat-piqueras-ruiz",
    "nombre": "María Montserrat Piqueras Ruiz",
    "partido": "VOX",
    "color": "#63be21"
   },
   {
    "id": "pp-josep-tutusaus-besante",
    "nombre": "Josep Tutusaus Besante",
    "partido": "PP",
    "color": "#1d84ce"
   },
   {
    "id": "pp-monica-pares-centeno",
    "nombre": "Mónica Parés Centeno",
    "partido": "PP",
    "color": "#1d84ce"
   },
   {
    "id": "pp-javier-guasch-torrens",
    "nombre": "Javier Guasch Torrens",
    "partido": "PP",
    "color": "#1d84ce"
   }
  ],
  "Girona": [
   {
    "id": "psc-gael-rodriguez-garrido",
    "nombre": "Gael Rodríguez Garrido",
    "partido": "PSC",
    "color": "#e30613"
   },
   {
    "id": "psc-consol-cantenys-arboli",
    "nombre": "Consol Cantenys Arbolí",
    "partido": "PSC",
    "color": "#e30613"
   },
   {
    "id": "psc-moises-tomas-alcobe",
    "nombre": "Moisès Tomàs Alcobé",
    "partido": "PSC",
    "color": "#e30613"
   },
   {
    "id": "jxcat-joan-bague-i-roura",
    "nombre": "Joan Bagué i Roura",
    "partido": "Junts",
    "color": "#20c0b2"
   },
   {
    "id": "jxcat-julia-barcelo-i-puig",
    "nombre": "Júlia Barceló i Puig",
    "partido": "Junts",
    "color": "#20c0b2"
   },
   {
    "id": "jxcat-pau-taberner-i-pibernat",
    "nombre": "Pau Taberner i Pibernat",
    "partido": "Junts",
    "color": "#20c0b2"
   },
   {
    "id": "erc-eh-bildu-etna-estrems-fayos",
    "nombre": "Etna Estrems Fayos",
    "partido": "ERC-EH Bildu",
    "color": "#f4b400"
   },
   {
    "id": "erc-eh-bildu-miquel-reverter-tres",
    "nombre": "Miquel Reverter Tres",
    "partido": "ERC-EH Bildu",
    "color": "#f4b400"
   },
   {
    "id": "erc-eh-bildu-roser-carre-gonzalez",
    "nombre": "Roser Carré Gonzàlez",
    "partido": "ERC-EH Bildu",
    "color": "#f4b400"
   },
   {
    "id": "pctc-bernat-roig-arnau",
    "nombre": "Bernat Roig Arnau",
    "partido": "PCTC",
    "color": "#c00000"
   },
   {
    "id": "vox-francisco-javier-dominguez-garcia",
    "nombre": "Francisco Javier Domínguez García",
    "partido": "VOX",
    "color": "#63be21"
   },
   {
    "id": "vox-maria-carmen-comas-viladot",
    "nombre": "María Carmen Comas Viladot",
    "partido": "VOX",
    "color": "#63be21"
   },
   {
    "id": "vox-geronimo-vargas-henao",
    "nombre": "Gerónimo Vargas Henao",
    "partido": "VOX",
    "color": "#63be21"
   }
  ],
  "Lleida": [
   {
    "id": "psc-jan-pomes-lopez",
    "nombre": "Jan Pomés López",
    "partido": "PSC",
    "color": "#e30613"
   },
   {
    "id": "psc-pasion-gador-romero-garcia",
    "nombre": "Pasión Gador Romero García",
    "partido": "PSC",
    "color": "#e30613"
   },
   {
    "id": "psc-carlos-trinidad-ortega",
    "nombre": "Carlos Trinidad Ortega",
    "partido": "PSC",
    "color": "#e30613"
   },
   {
    "id": "jxcat-rosa-maria-melines-i-rius",
    "nombre": "Rosa Maria Melines i Rius",
    "partido": "Junts",
    "color": "#20c0b2"
   },
   {
    "id": "jxcat-emili-gilabert-i-roca",
    "nombre": "Emili Gilabert i Roca",
    "partido": "Junts",
    "color": "#20c0b2"
   },
   {
    "id": "jxcat-judit-guim-i-tarruella",
    "nombre": "Judit Guim i Tarruella",
    "partido": "Junts",
    "color": "#20c0b2"
   },
   {
    "id": "erc-eh-bildu-silvia-martinez-i-fuentes",
    "nombre": "Sílvia Martínez i Fuentes",
    "partido": "ERC-EH Bildu",
    "color": "#f4b400"
   },
   {
    "id": "erc-eh-bildu-pol-oliva-i-sole",
    "nombre": "Pol Oliva i Solé",
    "partido": "ERC-EH Bildu",
    "color": "#f4b400"
   },
   {
    "id": "erc-eh-bildu-judith-gisbert-i-ester",
    "nombre": "Judith Gisbert i Ester",
    "partido": "ERC-EH Bildu",
    "color": "#f4b400"
   },
   {
    "id": "pctc-guillem-sans-garrote",
    "nombre": "Guillem Sans Garrote",
    "partido": "PCTC",
    "color": "#c00000"
   },
   {
    "id": "pp-jose-ramon-guiu-estopa",
    "nombre": "José Ramón Guiu Estopá",
    "partido": "PP",
    "color": "#1d84ce"
   },
   {
    "id": "pp-ana-cava-munoz",
    "nombre": "Ana Cava Muñoz",
    "partido": "PP",
    "color": "#1d84ce"
   },
   {
    "id": "pp-miguel-angel-balao-garcia",
    "nombre": "Miguel Angel Balao Garcia",
    "partido": "PP",
    "color": "#1d84ce"
   },
   {
    "id": "vox-isabel-mas-picatoste",
    "nombre": "Isabel Mas Picatoste",
    "partido": "VOX",
    "color": "#63be21"
   },
   {
    "id": "vox-antonio-blas-marti-martin",
    "nombre": "Antonio Blas Martí Martín",
    "partido": "VOX",
    "color": "#63be21"
   },
   {
    "id": "vox-paula-garcia-castellanos",
    "nombre": "Paula García Castellanos",
    "partido": "VOX",
    "color": "#63be21"
   }
  ],
  "Tarragona": [
   {
    "id": "psc-manel-de-la-vega-carrera",
    "nombre": "Manel de la Vega Carrera",
    "partido": "PSC",
    "color": "#e30613"
   },
   {
    "id": "psc-montse-garcia-biosca",
    "nombre": "Montse García Biosca",
    "partido": "PSC",
    "color": "#e30613"
   },
   {
    "id": "psc-xavier-lorenzo-torres",
    "nombre": "Xavier Lorenzo Torres",
    "partido": "PSC",
    "color": "#e30613"
   },
   {
    "id": "erc-eh-bildu-noemi-llaurado-sans",
    "nombre": "Noemí Llauradó Sans",
    "partido": "ERC-EH Bildu",
    "color": "#f4b400"
   },
   {
    "id": "erc-eh-bildu-xavier-faura-sanmartin",
    "nombre": "Xavier Faura Sanmartín",
    "partido": "ERC-EH Bildu",
    "color": "#f4b400"
   },
   {
    "id": "erc-eh-bildu-montserrat-ventura-jane",
    "nombre": "Montserrat Ventura Jané",
    "partido": "ERC-EH Bildu",
    "color": "#f4b400"
   },
   {
    "id": "jxcat-josep-andreu-i-domingo",
    "nombre": "Josep Andreu i Domingo",
    "partido": "Junts",
    "color": "#20c0b2"
   },
   {
    "id": "jxcat-montserrat-vellve-i-foix",
    "nombre": "Montserrat Vellvé i Foix",
    "partido": "Junts",
    "color": "#20c0b2"
   },
   {
    "id": "jxcat-felip-monclus-i-arasa",
    "nombre": "Felip Monclús i Arasa",
    "partido": "Junts",
    "color": "#20c0b2"
   },
   {
    "id": "pctc-albert-camarasa-escubedo",
    "nombre": "Albert Camarasa Escubedo",
    "partido": "PCTC",
    "color": "#c00000"
   },
   {
    "id": "vox-ana-belen-rodriguez-ros",
    "nombre": "Ana Belén Rodríguez Ros",
    "partido": "VOX",
    "color": "#63be21"
   },
   {
    "id": "vox-francisco-javier-vaquero-rodriguez",
    "nombre": "Francisco Javier Vaquero Rodríguez",
    "partido": "VOX",
    "color": "#63be21"
   },
   {
    "id": "vox-maria-dolores-zamora-carmona",
    "nombre": "María Dolores Zamora Carmona",
    "partido": "VOX",
    "color": "#63be21"
   },
   {
    "id": "cnv-demelsa-bartual-soria",
    "nombre": "Demelsa Bartual Soria",
    "partido": "Convergents",
    "color": "#003f7f"
   },
   {
    "id": "cnv-manuel-andres-marin-garcia",
    "nombre": "Manuel Andrés Marín García",
    "partido": "Convergents",
    "color": "#003f7f"
   },
   {
    "id": "cnv-merce-alicia-sans-saez",
    "nombre": "Mercè Alicia Sans Sáez",
    "partido": "Convergents",
    "color": "#003f7f"
   },
   {
    "id": "mundo-justo-maria-del-carmen-barros-ruiz",
    "nombre": "María del Carmen Barros Ruiz",
    "partido": "Mundo+Justo",
    "color": "#7a8a99"
   }
  ]
};
// Una candidatura se presenta en una provincia si no tiene "orden" (= en todas) o si tiene número para esa provincia.
const sePresenta = (p, prov) => !p.orden || !Object.keys(p.orden).length || p.orden[prov] != null;
const configFile = path.join(DATA_DIR, 'config.json');
const mesasFile = path.join(DATA_DIR, 'mesas.json');

let config = readJSON(configFile, null);
if (!config) { config = DEFAULT_CONFIG; writeJSON(configFile, config); }
// Corrección BOE (rev. 2): en Barcelona, PACMA y Por un Mundo más Justo figuran como «No proclamada» en el Congreso.
if ((config.boeRev || 1) < 2) {
  for (const id of ['pacma', 'mundo-justo']) { const p = config.partidos.find((x) => x.id === id); if (p?.orden?.Barcelona != null) delete p.orden.Barcelona; }
  config.boeRev = 2; writeJSON(configFile, config);
}
if (!config.senado) { config.senado = DEFAULT_SENADO; config.eleccion = 'Generales 29-N 2026'; writeJSON(configFile, config); }
const TIPOS = ['congreso', 'senado'];
// Claves de voto de un acta: candidaturas (Congreso) o candidatos de la provincia (Senado).
const clavesVoto = (tipo, prov) => tipo === 'senado' ? (config.senado[prov] || []).map((c) => c.id) : config.partidos.filter((p) => sePresenta(p, prov)).map((p) => p.id);
let mesas = readJSON(mesasFile, []);
let mesasIndex = new Map();
function indexarMesas() { mesasIndex = new Map(mesas.map((x) => [mesaKey(x), x])); }

indexarMesas();

// ---------- reclamaciones (escritos de reclamación/impugnación) ----------
const reclamaciones = new Map(); // id -> reclamación
for (const f of fs.readdirSync(RECL_DIR)) {
  if (!f.endsWith('.json')) continue;
  const r = readJSON(path.join(RECL_DIR, f), null);
  if (r && r.id) reclamaciones.set(r.id, r);
}
// Reclamaciones de la misma mesa que un acta (del mismo tipo, o sin tipo indicado).
const reclDeActa = (a) => [...reclamaciones.values()].filter((r) => r.mesaKey === mesaKey(a) && (!r.tipo || r.tipo === 'ambas' || r.tipo === (a.tipo === 'senado' ? 'senado' : 'congreso')));

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

// Límite generoso de envíos por IP (los móviles de una misma operadora pueden compartir IP).
const envios = new Map();
function rateLimitedEnvios(ip) {
  const now = Date.now();
  const e = envios.get(ip) || { n: 0, t: now };
  if (now - e.t > 10 * 60 * 1000) { e.n = 0; e.t = now; }
  e.n++;
  envios.set(ip, e);
  return e.n > 300;
}

const lecturas = new Map();
function rateLimitedLecturas(ip) {
  const now = Date.now();
  const e = lecturas.get(ip) || { n: 0, t: now };
  if (now - e.t > 10 * 60 * 1000) { e.n = 0; e.t = now; }
  e.n++;
  lecturas.set(ip, e);
  return e.n > 200;
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
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json',
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
  const avisos = [];
  const suma = Object.values(a.votos).reduce((s, n) => s + (n || 0), 0);
  if (a.tipo === 'senado') {
    // Senado: cada papeleta puede marcar hasta 3 candidatos, así que la suma no tiene que coincidir con los votantes.
    const papeletas = a.votantes - a.nulos - a.blancos; // papeletas válidas con algún candidato marcado
    a.validos = a.votantes - a.nulos;
    a.diferencia = 0;
    if (papeletas < 0) avisos.push('Nulos + blancos superan a los votantes');
    const max = Math.max(0, ...Object.values(a.votos));
    if (papeletas >= 0 && max > papeletas) avisos.push('Un candidato tiene más votos que papeletas válidas');
    if (papeletas >= 0 && suma > 3 * papeletas) avisos.push(`Más votos de los posibles (máx. 3 por papeleta: ${3 * papeletas})`);
    if (papeletas > 0 && suma < papeletas) avisos.push('Menos votos que papeletas válidas');
    a.cuadra = avisos.length === 0;
  } else {
    const total = suma + a.blancos + a.nulos;
    a.validos = suma + a.blancos;
    a.diferencia = a.votantes - total; // >0 faltan votos, <0 sobran
    a.cuadra = a.diferencia === 0;
    if (!a.cuadra) avisos.push(a.diferencia > 0 ? `Faltan ${a.diferencia} votos` : `Sobran ${-a.diferencia} votos`);
  }
  if (a.censo && a.votantes > a.censo) avisos.push('Más votantes que electores');
  const m = mesasIndex.get(mesaKey(a));
  if (m && toInt(m.electores) && a.censo && toInt(m.electores) !== a.censo) avisos.push(`Censo distinto al oficial (${m.electores})`);
  if (mesas.length && !m) avisos.push('Mesa no está en el listado');
  const ds = SECCIONES[a.provincia]?.[a.municipio];
  if (ds && !m && !(ds[a.distrito] || []).includes(a.seccion) && !MESAS23[a.provincia]?.[a.municipio]?.[a.distrito + '|' + a.seccion]) avisos.push('Distrito/sección no está en el listado oficial');
  const l23 = MESAS23[a.provincia]?.[a.municipio]?.[a.distrito + '|' + a.seccion];
  if (l23 && !m && !l23.includes(a.mesa)) avisos.push(`Mesa ${a.mesa} no existía en 2023 (había ${l23.split('').join(', ')})`);
  if (Object.keys(MUNICIPIOS).length && !municipioOficial(a.provincia, a.municipio) && !m) avisos.push('Municipio no reconocido');
  if (a.conflicto) avisos.push('Hay otra versión distinta del acta');
  if (a.foto && a.ia?.estado === 'difiere') avisos.push(`🤖 La foto no coincide: ${(a.ia.diferencias || []).slice(0, 3).join('; ')}${(a.ia.diferencias || []).length > 3 ? '…' : ''}`);
  if (a.foto && (a.ia?.estado === 'no_es_acta' || a.ia?.estado === 'ilegible')) avisos.push('🤖 ' + (a.ia.diferencias?.[0] || 'Foto no verificada'));
  const nRecl = reclDeActa(a).length;
  if (nRecl) avisos.push(`📝 Tiene ${nRecl} reclamación(es)`);
  if (a.observaciones) avisos.push('Tiene observaciones');
  // Votos a candidaturas que no están proclamadas en esa provincia (no figuran en su acta).
  if (a.tipo !== 'senado') {
    const fuera = config.partidos.filter((p) => !sePresenta(p, a.provincia) && (a.votos?.[p.id] || 0) > 0).map((p) => `${p.nombre} (${a.votos[p.id]})`);
    if (fuera.length) avisos.push(`Votos a candidaturas que no se presentan en ${a.provincia}: ${fuera.join(', ')}`);
  }
  const pend = (a.comentarios || []).filter((c) => !c.leido).length;
  if (pend) avisos.push(`${pend} comentario(s) del apoderado`);
  a.avisos = avisos;
  a.incidencia = avisos.length > 0;
  return a;
}
function resumenActa(a) {
  const { historial, ...rest } = a;
  return { ...rest, versiones: (historial || []).length + 1 };
}

// Ubicación de una mesa tal como la guarda la app (provincia y municipio oficiales, distrito 2 cifras, sección 3).
function ubicacionDe(u) {
  const provincia = PROVINCIAS.find((p) => norm(p) === norm(u.provincia));
  if (!provincia) throw Object.assign(new Error('Provincia no válida'), { status: 400 });
  if (!String(u.municipio || '').trim() || !String(u.seccion || '').trim() || !String(u.mesa || '').trim() || !String(u.distrito || '').trim())
    throw Object.assign(new Error('Faltan datos de la mesa'), { status: 400 });
  return { provincia, municipio: municipioOficial(provincia, u.municipio) || String(u.municipio).trim(), distrito: padNum(u.distrito, 2), seccion: padNum(u.seccion, 3), mesa: String(u.mesa).trim().toUpperCase() };
}
function guardarReclamacion(body, user) {
  const u = body.ubicacion || {};
  const ubic = ubicacionDe(u);
  const colegio = String(u.colegio || '').trim().slice(0, 120);
  if (user.nombre.length < 3) throw Object.assign(new Error('Falta tu nombre'), { status: 400 });
  if (colegio.length < 3) throw Object.assign(new Error('Falta el nombre del colegio electoral'), { status: 400 });
  const texto = String(body.texto || '').trim().slice(0, 3000);
  if (texto.length < 3 && !body.foto) throw Object.assign(new Error('Describe la reclamación o adjunta la foto'), { status: 400 });
  const previa = [...reclamaciones.values()].find((r) => body.clientId && r.clientId === body.clientId);
  if (previa) return previa; // reenvío desde la cola sin conexión
  const id = 'rec-' + crypto.randomBytes(6).toString('hex');
  let foto = null;
  const m = typeof body.foto === 'string' && body.foto.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
  if (m) { foto = `${id}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`; fs.writeFileSync(path.join(FOTOS_DIR, foto), Buffer.from(m[2], 'base64')); }
  const r = {
    id, clase: 'reclamacion', tipo: ['congreso', 'senado', 'ambas'].includes(body.tipo) ? body.tipo : 'ambas',
    ...ubic, colegio, mesaKey: mesaKey(ubic), texto, reclamante: String(body.reclamante || '').slice(0, 200),
    foto, enviadoPor: { nombre: user.nombre, dispositivo: user.dispositivo }, recibido: new Date().toISOString(), clientId: body.clientId || null, revisada: false,
  };
  writeJSON(path.join(RECL_DIR, id + '.json'), r);
  reclamaciones.set(id, r);
  recalcularMesa(r.mesaKey);
  return r;
}
// Vuelve a calcular los avisos de las actas de una mesa (por ejemplo, al llegar o borrarse una reclamación).
function recalcularMesa(key) {
  for (const a of actas.values()) if (mesaKey(a) === key) { calcula(a); writeJSON(path.join(ACTAS_DIR, fileIdFor(a.id) + '.json'), a); }
}

function mismosDatos(a, d) {
  return ['censo', 'votantes', 'nulos', 'blancos'].every((k) => a[k] === d[k]) &&
    Object.keys({ ...a.votos, ...d.votos }).every((k) => (a.votos?.[k] ?? 0) === (d.votos?.[k] ?? 0));
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
  const nombre = String(body.nombre || '').trim().slice(0, 80);
  const colegio = String(u.colegio || '').trim().slice(0, 120);
  if (nombre.length < 3) throw Object.assign(new Error('Falta tu nombre'), { status: 400 });
  if (colegio.length < 3) throw Object.assign(new Error('Falta el nombre del colegio electoral'), { status: 400 });
  const oficial = mesas.find((x) => norm(x.provincia) === norm(provincia) && norm(x.municipio) === norm(ubic.municipio));
  if (oficial) ubic.municipio = oficial.municipio; // nombre tal cual está en el listado de mesas
  else {
    const mo = municipioOficial(provincia, ubic.municipio);
    if (mo) ubic.municipio = mo; // nombre oficial del INE
  }
  const tipo = body.tipo === 'senado' ? 'senado' : 'congreso';
  const id = (tipo === 'senado' ? 'senado|' : '') + mesaKey(ubic);
  const v = body.votos || {};
  const votos = {};
  for (const k of clavesVoto(tipo, provincia)) votos[k] = toInt(v.partidos?.[k]) ?? 0;
  const datos = {
    censo: toInt(v.censo) ?? 0,
    votantes: toInt(v.votantes) ?? 0,
    nulos: toInt(v.nulos) ?? 0,
    blancos: toInt(v.blancos) ?? 0,
    votos,
  };

  const previa = actas.get(id);
  if (previa && body.clientId && previa.clientId === body.clientId) return previa; // reenvío idempotente
  // Otra persona sube la misma acta con los mismos números: no se duplica ni se crea otra versión.
  if (previa && mismosDatos(previa, datos)) {
    const yaTeniaFoto = !!previa.foto;
    if (!yaTeniaFoto && typeof body.foto === 'string' && body.foto.startsWith('data:image/')) {
      const m = body.foto.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
      if (m) {
        previa.foto = `${fileIdFor(id)}-${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`; fs.writeFileSync(path.join(FOTOS_DIR, previa.foto), Buffer.from(m[2], 'base64'));
        previa.ia = lector.disponible() ? { estado: 'pendiente' } : null;
        encolarVerificacion(id, previa.foto, m[2], 'image/' + m[1]);
      }
    }
    (previa.confirmaciones ||= []).push({ nombre: user.nombre, dispositivo: user.dispositivo, recibido: new Date().toISOString() });
    writeJSON(path.join(ACTAS_DIR, fileIdFor(id) + '.json'), previa);
    return Object.assign(Object.create(null), previa, { duplicada: true });
  }

  let foto = null, fotoB64 = null, fotoTipo = null;
  if (typeof body.foto === 'string' && body.foto.startsWith('data:image/')) {
    const m = body.foto.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
    if (m) {
      foto = `${fileIdFor(id)}-${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
      fs.writeFileSync(path.join(FOTOS_DIR, foto), Buffer.from(m[2], 'base64'));
      fotoB64 = m[2]; fotoTipo = 'image/' + m[1];
    }
  }

  const acta = {
    id, tipo, ...ubic, colegio, ...datos,
    observaciones: String(body.observaciones || '').slice(0, 2000).trim(),
    foto, // cada versión guarda solo su propia foto
    ia: foto && lector.disponible() ? { estado: 'pendiente' } : null, // verificación de la foto por la IA
    enviadoPor: { nombre: user.nombre, dispositivo: user.dispositivo },
    recibido: new Date().toISOString(),
    clientId: body.clientId || null,
    revisada: false,
    historial: [],
    conflicto: false,
  };
  let final = acta;
  if (previa) {
    const { historial, ...anterior } = previa;
    acta.historial = [...(historial || []), anterior];
    acta.conflicto = true; // llega aquí solo si los números son distintos a los ya enviados
    // Se conservan los datos del acta (confirmaciones, comentarios…) y se elige la versión con más prioridad.
    Object.assign(acta, { confirmaciones: previa.confirmaciones, comentarios: previa.comentarios });
    final = elegirVersion(acta);
  }
  calcula(final);
  writeJSON(path.join(ACTAS_DIR, fileIdFor(id) + '.json'), final);
  actas.set(id, final);
  if (foto && fotoB64) encolarVerificacion(id, foto, fotoB64, fotoTipo);
  // Lo que se devuelve al apoderado es su propia versión (aunque no sea la que cuenta).
  return final === acta || final.foto === acta.foto && final.recibido === acta.recibido ? final : Object.assign(Object.create(null), final, { suyaNoPrioritaria: true });
}

// ---------- prioridad entre versiones de una misma mesa ----------
// 3 = foto verificada por la IA (coincide) · 2 = foto pendiente/sin IA · 1 = foto que no coincide · 0 = sin foto.
function puntos(v) {
  if (!v.foto) return 0;
  const e = v.ia?.estado;
  if (e === 'coincide') return 3;
  if (e === 'difiere' || e === 'no_es_acta') return 1;
  return 2;
}
const CAMPOS_ACTA = ['id', 'tipo', 'provincia', 'municipio', 'distrito', 'seccion', 'mesa', 'confirmaciones', 'comentarios', 'revisada', 'conflicto', 'elegidaManual'];
function elegirVersion(a) {
  if (a.elegidaManual) return a; // el equipo eligió una versión a mano: se respeta
  const { historial = [], ...actual } = a;
  const todas = [actual, ...historial];
  const mejor = [...todas].sort((x, y) => puntos(y) - puntos(x) || String(y.recibido).localeCompare(String(x.recibido)))[0];
  const motivo = `Cuenta la versión ${mejor.foto ? (puntos(mejor) === 3 ? 'con foto verificada por la IA' : 'con foto') : 'más reciente'}`;
  if (mejor === actual) return historial.length ? { ...a, prioridad: motivo } : a;
  const comunes = Object.fromEntries(CAMPOS_ACTA.map((k) => [k, a[k]]));
  const resto = todas.filter((v) => v !== mejor).sort((x, y) => String(x.recibido).localeCompare(String(y.recibido)))
    .map((v) => { const c = { ...v }; for (const k of CAMPOS_ACTA) if (k !== 'colegio') delete c[k]; return c; });
  return { ...mejor, ...comunes, historial: resto, prioridad: motivo };
}

// ---------- verificación de la foto por la IA ----------
// Al publicarse un acta con foto, la IA la lee y se compara con los números enviados.
// Si la foto ya se leyó desde el móvil (misma imagen), se reutiliza esa lectura y no se paga dos veces.
const lecturasCache = new Map(); // sha1(foto) -> lectura normalizada
const hashFoto = (b64) => crypto.createHash('sha1').update(b64).digest('hex');
function guardarEnCache(h, L) { lecturasCache.set(h, L); if (lecturasCache.size > 3000) lecturasCache.delete(lecturasCache.keys().next().value); }
async function leerConCache(b64, mediaType) {
  const h = hashFoto(b64);
  if (lecturasCache.has(h)) return lecturasCache.get(h);
  const { datos } = await lector.leerActa({ fotoBase64: b64, mediaType, config, provincias: PROVINCIAS });
  const L = normalizarLectura(datos);
  guardarEnCache(h, L);
  return L;
}
function compararConLectura(v, a, L) {
  if (!L.esActa) return { estado: 'no_es_acta', diferencias: ['La foto no parece un acta'] };
  const dif = [];
  if (L.tipo && L.tipo !== (a.tipo === 'senado' ? 'senado' : 'congreso')) dif.push(`Tipo: la foto es del ${L.tipo === 'senado' ? 'Senado' : 'Congreso'}`);
  for (const [k, nom] of [['distrito', 'Distrito'], ['seccion', 'Sección'], ['mesa', 'Mesa']]) if (L[k] && L[k] !== a[k]) dif.push(`${nom}: foto ${L[k]} / enviado ${a[k]}`);
  let leidos = 0;
  for (const [k, nom] of [['censo', 'Censo'], ['votantes', 'Votantes'], ['nulos', 'Nulos'], ['blancos', 'Blancos']]) {
    if (L[k] == null) continue; leidos++;
    if (L[k] !== v[k]) dif.push(`${nom}: foto ${L[k]} / enviado ${v[k]}`);
  }
  const nombres = Object.fromEntries([...config.partidos.map((p) => [p.id, p.nombre]), ...Object.values(config.senado || {}).flat().map((c) => [c.id, c.nombre])]);
  for (const [id, n] of Object.entries(v.votos || {})) {
    const f = L.votos?.[id];
    if (f == null) continue; leidos++;
    if (f !== n) dif.push(`${nombres[id] || id}: foto ${f} / enviado ${n}`);
  }
  if (!leidos) return { estado: 'ilegible', diferencias: ['La IA no ha podido leer las cifras de la foto'] };
  return { estado: dif.length ? 'difiere' : 'coincide', diferencias: dif, dudas: L.dudas || '' };
}
const colaIA = []; let iaActivas = 0;
function encolarVerificacion(id, foto, b64, mediaType) {
  if (!lector.disponible()) return;
  colaIA.push({ id, foto, b64, mediaType }); procesarColaIA();
}
// Versión (actual o anterior) de un acta que tiene una foto concreta.
const versionConFoto = (a, foto) => (a.foto === foto ? a : (a.historial || []).find((h) => h.foto === foto));
function procesarColaIA() {
  while (iaActivas < 2 && colaIA.length) {
    const t = colaIA.shift(); iaActivas++;
    (async () => {
      let ia;
      try {
        const L = await leerConCache(t.b64, t.mediaType);
        const a = actas.get(t.id), v = a && versionConFoto(a, t.foto);
        if (!v) return;
        ia = compararConLectura(v, a, L);
      } catch (e) {
        console.error('[verificación IA]', t.id, e.message);
        ia = { estado: 'error', diferencias: ['No se ha podido verificar la foto'] };
      }
      ia.fecha = new Date().toISOString();
      // El acta puede haber cambiado mientras la IA leía: se busca de nuevo la versión con esa foto.
      const a = actas.get(t.id), v = a && versionConFoto(a, t.foto);
      if (!v) return;
      v.ia = ia;
      const nueva = elegirVersion(a);
      calcula(nueva);
      writeJSON(path.join(ACTAS_DIR, fileIdFor(nueva.id) + '.json'), nueva);
      actas.set(nueva.id, nueva);
    })().finally(() => { iaActivas--; procesarColaIA(); });
  }
}
// Al arrancar: verificar las fotos que quedaron pendientes (por ejemplo, tras un reinicio).
setTimeout(() => {
  for (const a of actas.values()) for (const v of [a, ...(a.historial || [])]) {
    if (v.foto && v.ia?.estado === 'pendiente') {
      try { const b64 = fs.readFileSync(path.join(FOTOS_DIR, v.foto)).toString('base64'); encolarVerificacion(a.id, v.foto, b64, MIME[path.extname(v.foto)] || 'image/jpeg'); } catch {}
    }
  }
}, 3000);

// Ajusta lo leído por la IA a los nombres y formatos de la app (municipio oficial, distrito 2 cifras, etc.).
function normalizarLectura(d) {
  const num = (v) => (Number.isInteger(v) && v >= 0 ? v : null); // null = no se ha podido leer
  const provincia = PROVINCIAS.includes(d.provincia) ? d.provincia : null;
  const tipo = ['congreso', 'senado'].includes(d.tipo) ? d.tipo : null;
  const soloDig = (x) => String(x || '').replace(/\D/g, '');
  const municipio = provincia && d.municipio ? municipioOficial(provincia, d.municipio) : null;
  const validos = new Set(provincia && tipo ? clavesVoto(tipo, provincia) : []);
  const votos = {};
  for (const v of d.votos || []) if (!validos.size || validos.has(v.id)) votos[v.id] = num(v.votos);
  return {
    esActa: d.es_acta !== false,
    documento: ['acta', 'reclamacion', 'otro'].includes(d.documento) ? d.documento : (d.es_acta === false ? 'otro' : 'acta'),
    reclamacionTexto: String(d.reclamacion_texto || '').slice(0, 2000),
    reclamante: String(d.reclamante || '').slice(0, 200),
    tipo, provincia, municipio,
    municipioLeido: String(d.municipio || '').slice(0, 80),
    distrito: soloDig(d.distrito) ? padNum(soloDig(d.distrito), 2) : '',
    seccion: soloDig(d.seccion) ? padNum(soloDig(d.seccion), 3) : '',
    mesa: String(d.mesa || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2),
    censo: num(d.censo), votantes: num(d.votantes), nulos: num(d.nulos), blancos: num(d.blancos),
    votos,
    dudas: String(d.dudas || '').slice(0, 500),
  };
}

// ---------- descargas ----------
const limpiaNombre = (x) => String(x || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
function nombreFoto(a) {
  return limpiaNombre(`${a.clase === 'reclamacion' ? 'reclamacion' : a.tipo === 'senado' ? 'senado' : 'congreso'}_${a.municipio}_D${a.distrito}_S${a.seccion}_M${a.mesa}`).replace(/ /g, '-');
}
function filtroDe(url) {
  const provincia = PROVINCIAS.find((x) => norm(x) === norm(url.searchParams.get('provincia'))) || '';
  const mun = url.searchParams.get('municipio') || '';
  return { provincia, municipio: mun && provincia ? (municipioOficial(provincia, mun) || mun) : mun };
}
function actasFiltradas(f, tipo) {
  return [...actas.values()].filter((a) => (!tipo || (a.tipo === 'senado' ? 'senado' : 'congreso') === tipo) &&
    (!f.provincia || a.provincia === f.provincia) && (!f.municipio || norm(a.municipio) === norm(f.municipio)))
    .sort((x, y) => x.id.localeCompare(y.id));
}
function clavesExport(tipo) {
  return tipo === 'senado'
    ? PROVINCIAS.flatMap((pr) => (config.senado[pr] || []).map((c) => ({ id: c.id, titulo: `${c.nombre} (${c.partido}, ${pr})` })))
    : config.partidos.map((x) => ({ id: x.id, titulo: x.nombre }));
}
function csvActas(tipo, f) {
  const claves = clavesExport(tipo);
  const cols = ['provincia', 'municipio', 'colegio', 'distrito', 'seccion', 'mesa', 'censo', 'votantes', tipo === 'senado' ? 'papeletas_nulas' : 'nulos', tipo === 'senado' ? 'papeletas_blanco' : 'blancos',
    ...claves.map((c) => c.titulo), 'correcta', 'verificada', 'foto_verificada_ia', 'avisos', 'observaciones', 'enviado_por', 'confirmada_por', 'recibido', 'foto'];
  const lines = [cols.map(csvCell).join(';')];
  for (const a of actasFiltradas(f, tipo)) {
    lines.push([a.provincia, a.municipio, a.colegio, a.distrito, a.seccion, a.mesa, a.censo, a.votantes, a.nulos, a.blancos,
      ...claves.map((c) => a.votos[c.id] ?? ''), a.cuadra ? 'SI' : 'NO', a.revisada ? 'SI' : 'NO', !a.foto ? 'SIN FOTO' : ({ coincide: 'COINCIDE', difiere: 'NO COINCIDE', pendiente: 'PENDIENTE', error: 'ERROR', no_es_acta: 'NO ES ACTA', ilegible: 'ILEGIBLE' }[a.ia?.estado] || 'SIN IA'), (a.avisos || []).join(' | '), a.observaciones,
      a.enviadoPor?.nombre, (a.confirmaciones || []).map((c) => c.nombre).join(', '), new Date(a.recibido).toLocaleString('es-ES'), a.foto ? nombreFoto(a) + path.extname(a.foto) : ''].map(csvCell).join(';'));
  }
  return '\uFEFF' + lines.join('\r\n');
}
function csvReclamaciones(f) {
  const cols = ['provincia', 'municipio', 'colegio', 'distrito', 'seccion', 'mesa', 'eleccion', 'reclamacion', 'reclamante', 'enviada_por', 'recibida', 'revisada', 'nota_equipo', 'foto'];
  const lines = [cols.map(csvCell).join(';')];
  for (const r of [...reclamaciones.values()].filter((x) => (!f.provincia || x.provincia === f.provincia) && (!f.municipio || norm(x.municipio) === norm(f.municipio)))
    .sort((a, b) => a.mesaKey.localeCompare(b.mesaKey))) {
    lines.push([r.provincia, r.municipio, r.colegio, r.distrito, r.seccion, r.mesa, r.tipo, r.texto, r.reclamante, r.enviadoPor?.nombre, new Date(r.recibido).toLocaleString('es-ES'),
      r.revisada ? 'SI' : 'NO', r.nota || '', r.foto ? `${nombreFoto(r)}_${r.id.slice(-4)}${path.extname(r.foto)}` : ''].map(csvCell).join(';'));
  }
  return '\uFEFF' + lines.join('\r\n');
}
function csvMunicipios(tipo, f) {
  const claves = tipo === 'senado' ? clavesExport('senado') : config.partidos.map((x) => ({ id: x.id, titulo: x.nombre }));
  const g = {};
  for (const a of actasFiltradas(f, tipo)) {
    const m = g[a.provincia + '|' + a.municipio] ||= { provincia: a.provincia, municipio: a.municipio, actas: 0, censo: 0, votantes: 0, nulos: 0, blancos: 0, votos: {} };
    m.actas++; m.censo += a.censo; m.votantes += a.votantes; m.nulos += a.nulos; m.blancos += a.blancos;
    for (const c of claves) m.votos[c.id] = (m.votos[c.id] || 0) + (a.votos[c.id] || 0);
  }
  const cols = ['provincia', 'municipio', 'actas_recibidas', 'mesas_totales', 'censo', 'votantes', 'participacion_%', 'nulos', 'blancos', ...claves.map((c) => c.titulo)];
  const lines = [cols.map(csvCell).join(';')];
  for (const m of Object.values(g).sort((x, y) => x.provincia.localeCompare(y.provincia) || x.municipio.localeCompare(y.municipio, 'ca'))) {
    lines.push([m.provincia, m.municipio, m.actas, contarMesas(m.provincia, m.municipio), m.censo, m.votantes, m.censo ? (m.votantes / m.censo * 100).toFixed(2).replace('.', ',') : '', m.nulos, m.blancos,
      ...claves.map((c) => m.votos[c.id] || 0)].map(csvCell).join(';'));
  }
  return '\uFEFF' + lines.join('\r\n');
}

function reclPapelera(lista) {
  const dir = path.join(DATA_DIR, 'papelera', new Date().toISOString().replace(/[:.]/g, '-') + '-reclamaciones');
  fs.mkdirSync(dir, { recursive: true });
  const keys = new Set();
  for (const r of lista) {
    try { fs.renameSync(path.join(RECL_DIR, r.id + '.json'), path.join(dir, r.id + '.json')); } catch {}
    if (r.foto) try { fs.renameSync(path.join(FOTOS_DIR, r.foto), path.join(dir, r.foto)); } catch {}
    reclamaciones.delete(r.id); keys.add(r.mesaKey);
  }
  for (const k of keys) recalcularMesa(k);
}

function aPapelera(lista) {
  const dir = path.join(DATA_DIR, 'papelera', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  for (const a of lista) {
    const f = fileIdFor(a.id) + '.json';
    try { fs.renameSync(path.join(ACTAS_DIR, f), path.join(dir, f)); } catch {}
    for (const v of [a, ...(a.historial || [])]) {
      if (v.foto) try { fs.renameSync(path.join(FOTOS_DIR, v.foto), path.join(dir, v.foto)); } catch {}
    }
    actas.delete(a.id);
  }
}

function resumen() {
  const lista = [...actas.values()];
  const tot = { actas: lista.length, mesasTotal: contarMesas(), censo: 0, votantes: 0, nulos: 0, blancos: 0, validos: 0, incidencias: 0, votos: {} };
  const porMunicipio = {};
  for (const p of config.partidos) tot.votos[p.id] = 0;
  for (const a of lista) {
    if (a.tipo === 'senado') { if (a.incidencia && !a.revisada) tot.incidencias++; continue; }
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
  for (const m of Object.values(porMunicipio)) m.mesasTotal = contarMesas(m.provincia, m.municipio);
  return {
    config, totales: tot,
    municipios: Object.values(porMunicipio).sort((a, b) => b.censo - a.censo),
    actas: lista.map(resumenActa).sort((a, b) => b.recibido.localeCompare(a.recibido)),
    reclamaciones: [...reclamaciones.values()].map(({ enviadoPor, ...r }) => ({ ...r, enviadoPor: { nombre: enviadoPor?.nombre } }))
      .sort((a, b) => b.recibido.localeCompare(a.recibido)),
    actualizado: new Date().toISOString(),
  };
}

// Municipios oficiales de Catalunya (INE, 947). Clave sin acentos ni artículo inicial para reconocer «Hospitalet» = «L'Hospitalet de Llobregat».
const MUNICIPIOS = readJSON(path.join(__dirname, 'municipios.json'), {});
const claveMun = (s) => norm(s).replace(/^(el|la|els|les|es|sa|ses) |^(l|s)['’]/, '').replace(/['’`.,·-]/g, '').replace(/\s+/g, ' ').trim();
const indiceMun = new Map();
for (const [p, lista] of Object.entries(MUNICIPIOS)) for (const m of lista) indiceMun.set(p + '|' + claveMun(m), m);
function municipioOficial(prov, nombre) { return indiceMun.get(prov + '|' + claveMun(nombre)) || null; }

// Secciones censales oficiales de Catalunya (INE 2025): { provincia: { municipio: { distrito: [secciones] } } }.
const SECCIONES = readJSON(path.join(__dirname, 'secciones.json'), {});
// Mesas oficiales de las Generales 2023 (Ministerio del Interior): { provincia: { municipio: { 'distrito|seccion': 'AB' } } }.
const MESAS23 = readJSON(path.join(__dirname, 'mesas-2023.json'), {});
// Nº de mesas (para el % escrutado): listado cargado en el panel si lo hay; si no, el oficial de 2023.
function contarMesas(prov, mun) {
  if (mesas.length) return mesas.filter((m) => (!prov || norm(m.provincia) === norm(prov)) && (!mun || norm(m.municipio) === norm(mun))).length;
  let n = 0;
  for (const p in MESAS23) if (!prov || p === prov) for (const mu in MESAS23[p]) if (!mun || mu === mun) for (const l of Object.values(MESAS23[p][mu])) n += l.length;
  return n;
}
// Secciones + letras de mesa: las del INE, ampliadas con el listado de mesas que se cargue desde el panel.
function seccionesConfig() {
  const secc = JSON.parse(JSON.stringify(SECCIONES));
  const letras = {};
  for (const p in MESAS23) for (const mun in MESAS23[p]) for (const [ds, l] of Object.entries(MESAS23[p][mun])) {
    const [d, s] = ds.split('|');
    const lista = ((secc[p] ||= {})[mun] ||= {})[d] ||= [];
    if (!lista.includes(s)) { lista.push(s); lista.sort(); }
    letras[[p, mun, d, s].join('|')] = l.split('');
  }
  const subidas = new Set();
  for (const m of mesas) {
    const p = PROVINCIAS.find((x) => norm(x) === norm(m.provincia));
    if (!p) continue;
    const mun = municipioOficial(p, m.municipio) || m.municipio;
    const d = padNum(m.distrito, 2), s = padNum(m.seccion, 3);
    const lista = ((secc[p] ||= {})[mun] ||= {})[d] ||= [];
    if (!lista.includes(s)) { lista.push(s); lista.sort(); }
    const k = [p, mun, d, s].join('|');
    if (!subidas.has(k)) { letras[k] = []; subidas.add(k); } // el listado del panel sustituye al de 2023
    letras[k].includes(m.mesa) || letras[k].push(m.mesa);
  }
  for (const k in letras) letras[k].sort((a, b) => (a === 'U' ? -1 : b === 'U' ? 1 : a.localeCompare(b)));
  return { secciones: secc, letras };
}
let cacheSecc = null;

// Nombres de los distritos censales: { provincia: { municipio: { '01': 'Nombre' } } }.
// Solo Barcelona ciudad viene de serie (sus distritos censales son sus 10 distritos); el resto se carga desde el panel.
const distritosFile = path.join(DATA_DIR, 'distritos.json');
const DISTRITOS_BCN = { Barcelona: { Barcelona: { '01': 'Ciutat Vella', '02': 'Eixample', '03': 'Sants-Montjuïc', '04': 'Les Corts', '05': 'Sarrià-Sant Gervasi', '06': 'Gràcia', '07': 'Horta-Guinardó', '08': 'Nou Barris', '09': 'Sant Andreu', '10': 'Sant Martí' } } };
let distritos = readJSON(distritosFile, null) || DISTRITOS_BCN;

function municipiosConfig() {
  const out = {};
  for (const p of PROVINCIAS) out[p] = [...(MUNICIPIOS[p] || [])];
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
  if (m === 'POST' && p === '/api/admin/login') {
    if (rateLimited('a:' + clientIp(req))) return send(res, 429, { error: 'Demasiados intentos. Espera unos minutos.' });
    const b = await readBody(req);
    if (!safeEqual(ADMIN_PASSWORD, b.password || '')) return send(res, 401, { error: 'Contraseña incorrecta.' });
    return send(res, 200, { token: sign({ rol: 'admin', exp: Date.now() + 1000 * 60 * 60 * 24 * 3 }) });
  }

  // --- app abierta: no hace falta iniciar sesión ---
  const dispositivo = String(req.headers['x-dispositivo'] || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
  if (p === '/api/config' && m === 'GET') {
    cacheSecc ||= seccionesConfig();
    return send(res, 200, { distritos, lecturaAutomatica: lector.disponible(), eleccion: config.eleccion, partidos: config.partidos, senado: config.senado, provincias: PROVINCIAS, municipios: municipiosConfig(), ...cacheSecc, hayListadoMesas: mesas.length > 0 });
  }
  if (p === '/api/mesas' && m === 'GET') {
    const prov = norm(url.searchParams.get('provincia')), mun = norm(url.searchParams.get('municipio'));
    return send(res, 200, mesas.filter((x) => norm(x.provincia) === prov && norm(x.municipio) === mun)
      .map((x) => ({ distrito: padNum(x.distrito, 2), seccion: padNum(x.seccion, 3), mesa: String(x.mesa).toUpperCase(), electores: toInt(x.electores) })));
  }
  // Lectura automática de la foto del acta (IA). Devuelve los datos para que el apoderado solo los revise.
  if (p === '/api/leer-acta' && m === 'POST') {
    if (!lector.disponible()) return send(res, 503, { error: 'La lectura automática no está activada', codigo: 'sin_ia' });
    if (rateLimitedLecturas(clientIp(req))) return send(res, 429, { error: 'Demasiadas lecturas seguidas. Espera unos minutos.' });
    const b = await readBody(req);
    const mm = typeof b.foto === 'string' && b.foto.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
    if (!mm) return send(res, 400, { error: 'Falta la foto' });
    const h = hashFoto(mm[2]);
    if (lecturasCache.has(h)) return send(res, 200, { ok: true, lectura: lecturasCache.get(h) });
    const t0 = Date.now();
    const { datos, uso } = await lector.leerActa({ fotoBase64: mm[2], mediaType: mm[1], config, provincias: PROVINCIAS });
    console.log(`[lectura] ${Date.now() - t0} ms · entrada ${uso?.input_tokens} · caché leída ${uso?.cache_read_input_tokens || 0} · caché escrita ${uso?.cache_creation_input_tokens || 0} · salida ${uso?.output_tokens}`);
    const L = normalizarLectura(datos);
    guardarEnCache(h, L);
    return send(res, 200, { ok: true, lectura: L });
  }
  if (p === '/api/reclamaciones' && m === 'POST') {
    if (rateLimitedEnvios(clientIp(req))) return send(res, 429, { error: 'Demasiados envíos seguidos. Espera unos minutos.' });
    const b = await readBody(req);
    const r = guardarReclamacion(b, { nombre: String(b.nombre || '').trim().slice(0, 80), dispositivo });
    return send(res, 200, { ok: true, id: r.id });
  }
  if (p === '/api/actas' && m === 'POST') {
    if (rateLimitedEnvios(clientIp(req))) return send(res, 429, { error: 'Demasiados envíos seguidos. Espera unos minutos.' });
    const b = await readBody(req);
    const a = guardarActa(b, { nombre: String(b.nombre || '').trim().slice(0, 80), dispositivo });
    return send(res, 200, { ok: true, duplicada: !!a.duplicada, noPrioritaria: !!a.suyaNoPrioritaria, acta: resumenActa(a) });
  }
  if (p === '/api/existe' && m === 'GET') {
    const q = Object.fromEntries(url.searchParams);
    const provincia = PROVINCIAS.find((x) => norm(x) === norm(q.provincia));
    if (!provincia) return send(res, 200, { existe: false });
    const ubic = { provincia, municipio: municipioOficial(provincia, q.municipio) || q.municipio, distrito: padNum(q.distrito, 2), seccion: padNum(q.seccion, 3), mesa: String(q.mesa || '').toUpperCase() };
    const a = actas.get((q.tipo === 'senado' ? 'senado|' : '') + mesaKey(ubic));
    if (!a) return send(res, 200, { existe: false });
    return send(res, 200, { existe: true, nombre: a.enviadoPor?.nombre || '', recibido: a.recibido, colegio: a.colegio, mia: !!dispositivo && a.enviadoPor?.dispositivo === dispositivo });
  }
  // Actas en las que ha participado este móvil (enviadas, confirmadas o con una versión suya).
  const deEsteMovil = (a) => !!dispositivo && (a.enviadoPor?.dispositivo === dispositivo ||
    (a.historial || []).some((h) => h.enviadoPor?.dispositivo === dispositivo) ||
    (a.confirmaciones || []).some((c) => c.dispositivo === dispositivo));
  // Lo que ve el apoderado: sin identificadores de otros móviles ni historial.
  const paraApoderado = (a) => ({
    id: a.id, tipo: a.tipo || 'congreso', provincia: a.provincia, municipio: a.municipio, colegio: a.colegio, distrito: a.distrito, seccion: a.seccion, mesa: a.mesa,
    censo: a.censo, votantes: a.votantes, nulos: a.nulos, blancos: a.blancos, votos: a.votos, cuadra: a.cuadra, diferencia: a.diferencia,
    observaciones: a.observaciones, recibido: a.recibido, hayFoto: !!a.foto,
    enviadoPor: a.enviadoPor?.nombre || '', mia: a.enviadoPor?.dispositivo === dispositivo,
    confirmadaPor: (a.confirmaciones || []).map((c) => c.nombre),
    comentarios: (a.comentarios || []).filter((c) => c.dispositivo === dispositivo).map(({ texto, fecha }) => ({ texto, fecha })),
  });
  if (p === '/api/mis-actas' && m === 'GET') {
    if (!dispositivo) return send(res, 200, []);
    const recl = [...reclamaciones.values()].filter((r) => r.enviadoPor?.dispositivo === dispositivo).map((r) => ({
      id: r.id, clase: 'reclamacion', tipo: r.tipo, provincia: r.provincia, municipio: r.municipio, colegio: r.colegio, distrito: r.distrito, seccion: r.seccion, mesa: r.mesa,
      texto: r.texto, recibido: r.recibido, hayFoto: !!r.foto, mia: true, enviadoPor: r.enviadoPor?.nombre || '', revisada: r.revisada,
    }));
    return send(res, 200, [...[...actas.values()].filter(deEsteMovil).map(paraApoderado), ...recl]);
  }
  // Foto de un acta propia (el apoderado solo ve las de sus actas). El identificador del móvil va en la URL para poder usarla en <img>.
  if (p === '/api/mis-actas/foto' && m === 'GET') {
    const d = String(url.searchParams.get('d') || '').replace(/[^a-zA-Z0-9-]/g, '');
    const rec = reclamaciones.get(url.searchParams.get('id') || '');
    if (rec) {
      if (!d || rec.enviadoPor?.dispositivo !== d || !rec.foto || !fs.existsSync(path.join(FOTOS_DIR, rec.foto))) return send(res, 404, 'No encontrada');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(rec.foto)] || 'image/jpeg', 'Cache-Control': 'private, max-age=600' });
      return fs.createReadStream(path.join(FOTOS_DIR, rec.foto)).pipe(res);
    }
    const a = actas.get(url.searchParams.get('id') || '');
    const suya = a && d && (a.enviadoPor?.dispositivo === d || (a.historial || []).some((h) => h.enviadoPor?.dispositivo === d) || (a.confirmaciones || []).some((c) => c.dispositivo === d));
    if (!suya || !a.foto || !fs.existsSync(path.join(FOTOS_DIR, a.foto))) return send(res, 404, 'No encontrada');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(a.foto)] || 'image/jpeg', 'Cache-Control': 'private, max-age=600' });
    return fs.createReadStream(path.join(FOTOS_DIR, a.foto)).pipe(res);
  }
  // Comentario del apoderado sobre un acta suya (no cambia los datos: avisa al equipo).
  if (p === '/api/mis-actas/comentario' && m === 'POST') {
    const b = await readBody(req);
    const a = actas.get(b.id);
    const texto = String(b.texto || '').trim().slice(0, 1000);
    if (!a || !deEsteMovil(a)) return send(res, 404, { error: 'No se encuentra esta acta' });
    if (texto.length < 3) return send(res, 400, { error: 'Escribe el comentario' });
    (a.comentarios ||= []).push({ texto, nombre: String(b.nombre || '').trim().slice(0, 80), dispositivo, fecha: new Date().toISOString(), leido: false });
    a.revisada = false;
    calcula(a);
    writeJSON(path.join(ACTAS_DIR, fileIdFor(a.id) + '.json'), a);
    return send(res, 200, { ok: true });
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
      if (a.revisada) { a.conflicto = false; for (const c of a.comentarios || []) c.leido = true; }
      calcula(a);
      writeJSON(path.join(ACTAS_DIR, fileIdFor(a.id) + '.json'), a);
      return send(res, 200, { ok: true });
    }
    // Borrar = mover a data/papelera/<fecha>/ (se puede recuperar a mano si hace falta).
    // Elegir una versión anterior como la buena (la actual pasa al historial).
    if (p === '/api/admin/acta/version' && m === 'POST') {
      const b = await readBody(req);
      const a = actas.get(b.id);
      const i = Number(b.indice);
      if (!a || !a.historial?.[i]) return send(res, 404, { error: 'No existe esa versión' });
      const { historial, ...actual } = a;
      const elegida = historial[i];
      const nueva = { ...elegida, id: a.id, tipo: a.tipo, historial: [...historial.filter((_, j) => j !== i), actual].map(({ elegidaManual, prioridad, ...v }) => v), conflicto: true, revisada: true, confirmaciones: a.confirmaciones, comentarios: a.comentarios, elegidaManual: true, prioridad: 'Versión elegida por el equipo' };
      calcula(nueva);
      writeJSON(path.join(ACTAS_DIR, fileIdFor(a.id) + '.json'), nueva);
      actas.set(a.id, nueva);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/reclamacion/revisada' && m === 'POST') {
      const b = await readBody(req);
      const r = reclamaciones.get(b.id);
      if (!r) return send(res, 404, { error: 'No existe' });
      r.revisada = !!b.revisada; r.nota = String(b.nota ?? r.nota ?? '').slice(0, 1000);
      writeJSON(path.join(RECL_DIR, r.id + '.json'), r);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/reclamacion/borrar' && m === 'POST') {
      const b = await readBody(req);
      const r = reclamaciones.get(b.id);
      if (!r) return send(res, 404, { error: 'No existe' });
      reclPapelera([r]);
      return send(res, 200, { ok: true });
    }
    // Verificar con la IA las fotos de un acta que no se verificaron (p. ej., enviadas antes de activar la verificación).
    if (p === '/api/admin/acta/verificar' && m === 'POST') {
      const b = await readBody(req);
      const a = actas.get(b.id);
      if (!a) return send(res, 404, { error: 'No existe' });
      if (!lector.disponible()) return send(res, 503, { error: 'La lectura automática no está activada' });
      let n = 0;
      for (const v of [a, ...(a.historial || [])]) {
        if (!v.foto || ['coincide', 'difiere', 'no_es_acta', 'pendiente'].includes(v.ia?.estado)) continue;
        try { const b64 = fs.readFileSync(path.join(FOTOS_DIR, v.foto)).toString('base64'); v.ia = { estado: 'pendiente' }; encolarVerificacion(a.id, v.foto, b64, MIME[path.extname(v.foto)] || 'image/jpeg'); n++; } catch {}
      }
      calcula(a); writeJSON(path.join(ACTAS_DIR, fileIdFor(a.id) + '.json'), a);
      return send(res, 200, { ok: true, verificando: n });
    }
    if (p === '/api/admin/acta/borrar' && m === 'POST') {
      const b = await readBody(req);
      const a = actas.get(b.id);
      if (!a) return send(res, 404, { error: 'No existe' });
      aPapelera([a]);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/borrar-todas' && m === 'POST') {
      const b = await readBody(req);
      if (b.confirmacion !== 'BORRAR') return send(res, 400, { error: 'Escribe BORRAR para confirmar' });
      // que: 'congreso' | 'senado' (solo esas actas) | 'reclamaciones' | 'todo' (por defecto)
      const que = ['congreso', 'senado', 'reclamaciones'].includes(b.que) ? b.que : 'todo';
      const la = que === 'reclamaciones' ? [] : [...actas.values()].filter((a) => que === 'todo' || (a.tipo === 'senado' ? 'senado' : 'congreso') === que);
      const lr = que === 'todo' || que === 'reclamaciones' ? [...reclamaciones.values()] : [];
      if (la.length) aPapelera(la);
      if (lr.length) reclPapelera(lr);
      return send(res, 200, { ok: true, borradas: la.length, reclamaciones: lr.length });
    }
    if (p === '/api/admin/foto' && m === 'GET') {
      const f = path.basename(url.searchParams.get('f') || '');
      const file = path.join(FOTOS_DIR, f);
      if (!f || !fs.existsSync(file)) return send(res, 404, 'No encontrada');
      const h = { 'Content-Type': MIME[path.extname(f)] || 'image/jpeg', 'Cache-Control': 'private, max-age=3600' };
      if (url.searchParams.get('descargar')) {
        const a = [...actas.values()].find((x) => x.foto === f || (x.historial || []).some((v) => v.foto === f)) ||
          [...reclamaciones.values()].find((x) => x.foto === f);
        const nombre = (a ? nombreFoto(a) : 'acta') + path.extname(f);
        const rfc5987 = encodeURIComponent(nombre).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
        h['Content-Disposition'] = `attachment; filename="${nombre.replace(/[^\x20-\x7e]|["']/g, '_')}"; filename*=UTF-8''${rfc5987}`;
      }
      res.writeHead(200, h);
      return fs.createReadStream(file).pipe(res);
    }
    if (p === '/api/admin/export.csv' && m === 'GET') {
      const senado = url.searchParams.get('tipo') === 'senado';
      const nombre = senado ? 'actas-senado.csv' : 'actas-congreso.csv';
      return send(res, 200, csvActas(senado ? 'senado' : 'congreso', filtroDe(url)), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${nombre}"` });
    }
    // Descarga en ZIP: ?fotos=1 (fotos) ?datos=1 (CSV de datos y resultados) — se pueden combinar. Respeta ?provincia y ?municipio.
    if (p === '/api/admin/descarga.zip' && m === 'GET') {
      const filtro = filtroDe(url);
      const conFotos = url.searchParams.get('fotos') === '1', conDatos = url.searchParams.get('datos') === '1';
      const sufijo = [filtro.provincia, filtro.municipio].filter(Boolean).join('-').replace(/[^A-Za-z0-9-]+/g, '_');
      const nombre = `actas${conDatos && !conFotos ? '-datos' : ''}${conFotos && !conDatos ? '-fotos' : ''}${sufijo ? '-' + sufijo : ''}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.zip`;
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${nombre}"`, 'Cache-Control': 'no-store' });
      const zip = new ZipWriter(res);
      if (conDatos) {
        for (const t of ['congreso', 'senado']) {
          await zip.add(`actas-${t}.csv`, Buffer.from(csvActas(t, filtro), 'utf8'));
          await zip.add(`resultados-por-municipio-${t}.csv`, Buffer.from(csvMunicipios(t, filtro), 'utf8'));
        }
        await zip.add('reclamaciones.csv', Buffer.from(csvReclamaciones(filtro), 'utf8'));
        await zip.add('LEEME.txt', Buffer.from(`Descarga del ${new Date().toLocaleString('es-ES')}\r\n\r\nactas-*.csv: una fila por acta (mesa), con todos los votos.\r\nresultados-por-municipio-*.csv: totales por municipio.\r\nfotos/: foto de cada acta, por tipo, provincia y municipio.\r\nLos CSV se abren con Excel (separador punto y coma).\r\n`, 'utf8'));
      }
      if (conFotos) {
        for (const a of actasFiltradas(filtro).filter((x) => x.foto)) {
          const file = path.join(FOTOS_DIR, a.foto);
          if (!fs.existsSync(file)) continue;
          const carpeta = [a.tipo === 'senado' ? 'senado' : 'congreso', a.provincia, a.municipio].map(limpiaNombre).join('/');
          await zip.add(`fotos/${carpeta}/${nombreFoto(a)}${path.extname(a.foto)}`, await fs.promises.readFile(file), new Date(a.recibido));
        }
        for (const r of [...reclamaciones.values()].filter((x) => x.foto && (!filtro.provincia || x.provincia === filtro.provincia) && (!filtro.municipio || norm(x.municipio) === norm(filtro.municipio)))) {
          const file = path.join(FOTOS_DIR, r.foto);
          if (!fs.existsSync(file)) continue;
          await zip.add(`fotos/reclamaciones/${limpiaNombre(r.provincia)}/${limpiaNombre(r.municipio)}/${nombreFoto(r)}_${r.id.slice(-4)}${path.extname(r.foto)}`, await fs.promises.readFile(file), new Date(r.recibido));
        }
      }
      await zip.end();
      return;
    }
    if (p === '/api/admin/config' && m === 'GET') {
      return send(res, 200, { config, mesas: mesas.length });
    }
    if (p === '/api/admin/config' && m === 'PUT') {
      const b = await readBody(req);
      const partidos = (b.partidos || []).map((x) => ({
        id: String(x.id || x.nombre).trim().toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        nombre: String(x.nombre || '').trim(), color: /^#[0-9a-f]{6}$/i.test(x.color) ? x.color : '#888888',
        orden: Object.fromEntries(Object.entries(x.orden || {}).map(([p, n]) => [PROVINCIAS.find((q) => norm(q) === norm(p)), toInt(n) ?? 99]).filter(([p]) => p)),
      })).filter((x) => x.id && x.nombre);
      if (!partidos.length) return send(res, 400, { error: 'Hace falta al menos un partido' });
      if (new Set(partidos.map((x) => x.id)).size !== partidos.length) return send(res, 400, { error: 'Hay partidos repetidos' });
      let senado = config.senado;
      if (Array.isArray(b.senado)) {
        senado = Object.fromEntries(PROVINCIAS.map((pr) => [pr, []]));
        for (const c of b.senado) {
          const pr = PROVINCIAS.find((q) => norm(q) === norm(c.provincia));
          const nombre = String(c.nombre || '').trim(), partido = String(c.partido || '').trim();
          if (!pr || !nombre) continue;
          const previo = (config.senado[pr] || []).find((x) => x.nombre === nombre);
          const id = previo?.id || (partido + '-' + nombre).toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
          senado[pr].push({ id, nombre, partido, color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : (partidos.find((x) => norm(x.nombre) === norm(partido))?.color || '#888888') });
        }
      }
      config = { boeRev: config.boeRev, eleccion: String(b.eleccion || config.eleccion).trim(), partidos, senado };
      writeJSON(configFile, config);
      return send(res, 200, { ok: true, config });
    }
    // Plantilla/listado de distritos: todos los municipios con más de un distrito, con el nombre si ya lo tiene.
    if (p === '/api/admin/distritos.csv' && m === 'GET') {
      cacheSecc ||= seccionesConfig();
      const filas = [['provincia', 'municipio', 'distrito', 'secciones', 'nombre'].join(';')];
      for (const pr of PROVINCIAS) for (const mun of Object.keys(cacheSecc.secciones[pr] || {}).sort((a, b) => a.localeCompare(b, 'ca'))) {
        const ds = Object.keys(cacheSecc.secciones[pr][mun]).sort();
        if (ds.length < 2 && !distritos[pr]?.[mun]) continue;
        for (const d of ds) filas.push([pr, mun, d, cacheSecc.secciones[pr][mun][d].length, distritos[pr]?.[mun]?.[d] || ''].map(csvCell).join(';'));
      }
      return send(res, 200, '\uFEFF' + filas.join('\r\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="distritos.csv"' });
    }
    if (p === '/api/admin/distritos' && m === 'PUT') {
      const b = await readBody(req);
      const nuevo = {}; const errores = []; let n = 0;
      parseCSV(b.csv).forEach((r, i) => {
        const nombre = String(r.nombre || r.nom || '').trim();
        if (!nombre) return; // filas sin nombre: se ignoran
        const pr = PROVINCIAS.find((x) => norm(x) === norm(r.provincia));
        const mun = pr && municipioOficial(pr, r.municipio || r.municipi);
        const d = padNum(r.distrito || r.districte, 2);
        if (!pr || !mun || !/^\d{2}$/.test(d)) { errores.push(`Fila ${i + 2}: provincia, municipio o distrito no válidos`); return; }
        ((nuevo[pr] ||= {})[mun] ||= {})[d] = nombre.slice(0, 60); n++;
      });
      if (!n) return send(res, 400, { error: 'No hay ningún nombre en el fichero. Rellena la columna «nombre».', errores: errores.slice(0, 20) });
      distritos = nuevo;
      writeJSON(distritosFile, distritos);
      return send(res, 200, { ok: true, total: n, errores: errores.slice(0, 20) });
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
      cacheSecc = null;
      for (const a of actas.values()) calcula(a);
      return send(res, 200, { ok: true, total: mesas.length, errores: errores.slice(0, 50) });
    }
  }

  return send(res, 404, { error: 'No encontrado' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (e instanceof require('@anthropic-ai/sdk').APIError) { console.error('[lectura] error API', e.status, e.message); e = Object.assign(new Error('No se ha podido leer el acta automáticamente'), { status: 502 }); }
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
