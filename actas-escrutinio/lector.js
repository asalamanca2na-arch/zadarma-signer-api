// Lectura automática de la foto del acta con Claude (visión + salida estructurada).
// Necesita la variable de entorno ANTHROPIC_API_KEY. Sin ella, la app funciona igual pero sin lectura automática.
'use strict';

const Anthropic = require('@anthropic-ai/sdk').default;

const MODELO = 'claude-opus-5-5';
let cliente = null;
function getCliente() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  cliente ||= new Anthropic({ timeout: 120 * 1000, maxRetries: 1 });
  return cliente;
}
const disponible = () => !!process.env.ANTHROPIC_API_KEY;

// Lista de candidaturas/candidatos con sus identificadores, para que el modelo devuelva ids que la app entiende.
function catalogo(config, provincias) {
  const lineas = ['CONGRESO — candidaturas por provincia (id: nombre), en el orden de la papeleta:'];
  for (const pr of provincias) {
    const ps = config.partidos.filter((p) => !p.orden || !Object.keys(p.orden).length || p.orden[pr] != null)
      .sort((a, b) => (a.orden?.[pr] ?? 99) - (b.orden?.[pr] ?? 99));
    lineas.push(`  ${pr}: ` + ps.map((p) => `${p.id}: ${p.nombre}`).join(' | '));
  }
  lineas.push('', 'SENADO — candidatos por provincia (id: nombre [partido]), en el orden de la papeleta:');
  for (const pr of provincias) {
    lineas.push(`  ${pr}: ` + (config.senado?.[pr] || []).map((c) => `${c.id}: ${c.nombre} [${c.partido}]`).join(' | '));
  }
  return lineas.join('\n');
}

function esquema(config, provincias) {
  const ids = [...new Set([...config.partidos.map((p) => p.id), ...provincias.flatMap((pr) => (config.senado?.[pr] || []).map((c) => c.id))])];
  const entero = { type: 'integer', description: 'Número tal como aparece en el acta; -1 si no se puede leer con seguridad' };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['es_acta', 'tipo', 'provincia', 'municipio', 'distrito', 'seccion', 'mesa', 'censo', 'votantes', 'nulos', 'blancos', 'votos', 'dudas'],
    properties: {
      es_acta: { type: 'boolean', description: 'true si la imagen es un acta de escrutinio' },
      tipo: { type: 'string', enum: ['congreso', 'senado', 'desconocido'] },
      provincia: { type: 'string', enum: [...provincias, 'desconocida'] },
      municipio: { type: 'string', description: 'Nombre del municipio tal como aparece; vacío si no aparece' },
      distrito: { type: 'string', description: 'Número de distrito (solo dígitos); vacío si no aparece' },
      seccion: { type: 'string', description: 'Número de sección (solo dígitos); vacío si no aparece' },
      mesa: { type: 'string', description: 'Letra de la mesa (U, A, B, C...); vacío si no aparece' },
      censo: entero,
      votantes: entero,
      nulos: entero,
      blancos: entero,
      votos: {
        type: 'array',
        description: 'Un elemento por cada candidatura (Congreso) o candidato (Senado) que aparece en el acta',
        items: {
          type: 'object', additionalProperties: false, required: ['id', 'votos'],
          properties: { id: { type: 'string', enum: ids }, votos: entero },
        },
      },
      dudas: { type: 'string', description: 'Cifras o datos dudosos o ilegibles, en una frase corta en castellano; vacío si todo se lee bien' },
    },
  };
}

const SISTEMA = `Lees fotos de actas de escrutinio de mesas electorales de Catalunya (elecciones generales: Congreso y Senado) para una app de recuento.
Tu trabajo es transcribir, no calcular: copia cada cifra exactamente como está escrita en el acta, aunque los totales no cuadren. Nunca inventes ni corrijas un número; si una cifra no se lee con seguridad, pon -1 y menciónala en "dudas".
- El acta del Congreso tiene votos por candidatura (partido). El acta del Senado tiene votos por candidato (persona) y habla de "papeletas" nulas y en blanco.
- Usa solo los identificadores (id) del catálogo de la provincia del acta. Si en el acta aparece una candidatura o candidato con votos que no está en el catálogo, menciónalo en "dudas".
- "censo" es el número de electores de la mesa; "votantes" es el total de votantes.
- Si la imagen no es un acta de escrutinio, pon es_acta=false y deja el resto vacío o a -1.`;

async function leerActa({ fotoBase64, mediaType, config, provincias }) {
  const c = getCliente();
  if (!c) throw Object.assign(new Error('La lectura automática no está configurada'), { status: 503, codigo: 'sin_ia' });
  const resp = await c.beta.messages.create({
    model: MODELO,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default', // si el modelo rechaza la petición, la API la repite en otro modelo
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: esquema(config, provincias) } },
    system: SISTEMA + '\n\n' + catalogo(config, provincias),
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: fotoBase64 } },
        { type: 'text', text: 'Transcribe esta acta de escrutinio.' },
      ],
    }],
  });
  if (resp.stop_reason === 'refusal') throw Object.assign(new Error('No se ha podido leer el acta'), { status: 422 });
  if (resp.stop_reason === 'max_tokens') throw Object.assign(new Error('La lectura del acta se ha cortado'), { status: 502 });
  const texto = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return { datos: JSON.parse(texto), uso: resp.usage };
  } catch {
    throw Object.assign(new Error('Respuesta de lectura no válida'), { status: 502 });
  }
}

module.exports = { leerActa, disponible, MODELO };
