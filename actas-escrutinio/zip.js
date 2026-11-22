// Escritor de ZIP mínimo y sin dependencias (método «store», sin comprimir: las fotos JPEG ya van comprimidas).
// Va escribiendo en la respuesta HTTP fichero a fichero, sin cargarlo todo en memoria.
'use strict';

const zlib = require('zlib');

const crc32 = zlib.crc32 || (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
})();

function dosTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

class ZipWriter {
  constructor(out) { this.out = out; this.offset = 0; this.entries = []; }
  async write(buf) {
    this.offset += buf.length;
    if (!this.out.write(buf)) await new Promise((r) => this.out.once('drain', r));
  }
  async add(nombre, data, fecha) {
    const name = Buffer.from(nombre, 'utf8');
    const crc = crc32(data) >>> 0;
    const { time, date } = dosTime(fecha);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    this.entries.push({ name, crc, size: data.length, offset: this.offset, time, date });
    await this.write(h); await this.write(name); await this.write(data);
  }
  async end() {
    const inicio = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
      c.writeUInt16LE(e.time, 12); c.writeUInt16LE(e.date, 14); c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.size, 20); c.writeUInt32LE(e.size, 24); c.writeUInt16LE(e.name.length, 28);
      c.writeUInt32LE(e.offset, 42);
      await this.write(c); await this.write(e.name);
    }
    const fin = Buffer.alloc(22);
    fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(this.entries.length, 8); fin.writeUInt16LE(this.entries.length, 10);
    fin.writeUInt32LE(this.offset - inicio, 12); fin.writeUInt32LE(inicio, 16);
    await this.write(fin);
    this.out.end();
  }
}

module.exports = { ZipWriter };
