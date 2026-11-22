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
    required: ['es_acta', 'documento', 'reclamacion_texto', 'reclamante', 'tipo', 'provincia', 'municipio', 'distrito', 'seccion', 'mesa', 'censo', 'votantes', 'nulos', 'blancos', 'votos', 'dudas'],
    properties: {
      es_acta: { type: 'boolean', description: 'true si la imagen es un acta de escrutinio o de sesión con resultados' },
      documento: { type: 'string', enum: ['acta', 'reclamacion', 'otro'], description: 'acta = acta de escrutinio/sesión; reclamacion = escrito de reclamación, protesta o impugnación; otro = cualquier otra cosa' },
      reclamacion_texto: { type: 'string', description: 'Solo si documento=reclamacion: la anomalía o hechos que se reclaman, transcritos tal cual; vacío en otro caso' },
      reclamante: { type: 'string', description: 'Solo si documento=reclamacion: nombre de quien firma la reclamación y en calidad de qué (interventor/apoderado de qué candidatura); vacío en otro caso' },
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

const SISTEMA = `Lees fotos de actas de escrutinio (o actas de sesión) de mesas electorales de Catalunya (elecciones generales: Congreso y Senado) para una app de recuento. Suelen estar escritas a mano, en castellano o catalán, con tachones y correcciones.
Tu trabajo es transcribir, no inventar: copia cada cifra tal como está en el acta, aunque los totales no cuadren. Si una cifra no se lee con seguridad, pon -1 y menciónala en "dudas".
Cómo es el acta y qué campo corresponde a qué:
- Cabecera: provincia, municipio, "distrito censal", "sección" y "mesa" (U, A, B...). El sello redondo de la Junta Electoral de Zona suele repetir "DTE", "SECC" y "MESA": úsalo para confirmar la cabecera cuando esté borrosa, doblada o lejos, y si no coinciden dilo en "dudas". El acta del Congreso pone "CONGRESO DE LOS DIPUTADOS"; la del Senado pone "SENADO", tiene votos por candidato (persona) y habla de "papeletas".
- "censo" = TOTAL ELECTORES (1+2): electores según las listas del censo + certificaciones de alta. Si ese total está en blanco pero están el 1 y el 2, súmalos y dilo en "dudas".
- "votantes" = TOTAL VOTANTES (A+B): electores censados que han votado + interventores no censados. Si el total está en blanco o escrito como una suma (p. ej. "370 + 3"), calcula A+B y dilo en "dudas".
- "nulos" = número de votos (o papeletas) nulos; "blancos" = votos (o papeletas) en blanco. Una raya o un guion significa 0.
- Si una cifra manuscrita es ambigua (p. ej. un 3 que parece 53, un 1 que parece 7), en el acta del Congreso comprueba la suma: votos de todas las candidaturas (también las que no estén en el catálogo) + blancos + nulos = total votantes. Elige la lectura que cuadra y explícalo en "dudas". No uses la suma para cambiar cifras que se leen con claridad.
- Cada candidatura tiene el número escrito dos veces: "en letra" y "en núm.". Usa las dos para leer bien cada cifra. Si no coinciden, elige la que tenga más sentido con el resto del acta y explícalo en "dudas". Si una cifra está tachada y corregida, vale la corrección. Una raya o un guion es 0. Fíjate en la fila: los números van alineados con el nombre de su candidatura.
- Usa solo los identificadores (id) del catálogo de la provincia del acta, y solo cuando sea la MISMA candidatura (mismo nombre o siglas). Nunca pases los votos de una candidatura a otra distinta aunque se parezca. Si en el acta hay candidaturas o candidatos con votos que no están en el catálogo, no los pongas en "votos" y di en "dudas" cuáles son y cuántos votos tienen.
- Si la imagen es un ESCRITO DE RECLAMACIÓN (o protesta/impugnación): es_acta=false, documento=reclamacion; rellena la mesa (provincia, municipio, distrito, sección, mesa), "tipo" si dice Congreso o Senado (si no, desconocido), "reclamacion_texto" con la anomalía transcrita y "reclamante". Censo, votantes, nulos y blancos a -1 y votos vacío.
- Si la imagen no es ni un acta ni una reclamación, pon es_acta=false, documento=otro y deja el resto vacío o a -1.`;

async function leerActa({ fotoBase64, mediaType, config, provincias, modelo = MODELO, effort = 'medium' }) {
  const c = getCliente();
  if (!c) throw Object.assign(new Error('La lectura automática no está configurada'), { status: 503, codigo: 'sin_ia' });
  const resp = await c.beta.messages.create({
    model: modelo,
    max_tokens: 16000,
    // Si el modelo rechaza la petición, la API la repite en otro modelo (Haiku no admite esta opción).
    ...(modelo.includes('haiku') ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
    output_config: { effort, format: { type: 'json_schema', schema: esquema(config, provincias) } },
    // Las instrucciones y el catálogo son iguales en todas las lecturas: se guardan en caché (las siguientes cuestan ~20 veces menos).
    system: [{ type: 'text', text: SISTEMA + '\n\n' + catalogo(config, provincias), cache_control: { type: 'ephemeral' } }],
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
