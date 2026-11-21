# Recuento de actas de escrutinio · Catalunya

Web app sencilla para que los apoderados suban las actas de escrutinio la noche electoral
y el equipo vea los resultados en tiempo real y las mesas con incidencias.

- **Sin tiendas de apps**: se abre en el navegador del móvil o del ordenador. En el móvil se puede
  «Añadir a pantalla de inicio» y queda como una app.
- **Sin dependencias**: solo necesita Node.js 18 o superior. Los datos se guardan en la carpeta `data/`.

## Congreso y Senado

La app recoge las **dos actas** de cada mesa. En el paso 1 el apoderado elige **Congreso** o **Senado**:

- **Congreso**: votos por candidatura (en el orden del acta de cada provincia). Debe cumplirse
  `candidaturas + blancos + nulos = votantes`.
- **Senado**: votos a **cada candidato** de la provincia (BOE-A-2026-23103). Como cada papeleta puede marcar hasta 3
  candidatos, se comprueba que ningún candidato tenga más votos que papeletas válidas y que el total no supere 3 por papeleta.
  En el panel se marcan como «Escaño» los 4 más votados de cada provincia (provisional).

El panel tiene un selector **Congreso / Senado** que cambia resultados, actas y exportación CSV. Además:

- **Proyección de escaños del Congreso** por provincia (D'Hondt, mínimo 3 %): Barcelona 32, Girona 6, Lleida 4, Tarragona 6.
- **Tabla por municipio** con la columna del municipio fija, el PP primero y solo las candidaturas con votos.
- **Mesas pendientes**: eligiendo provincia y municipio, lista por distrito las mesas que aún no han enviado acta.

Las letras de mesa (U, A, B…) y el % escrutado salen del listado oficial de **8.923 mesas** de Catalunya de las
Generales 2023 (Ministerio del Interior). Si la mesa del acta no aparece (o ha cambiado desde 2023), se puede escribir a mano: solo la letra («✏️ Escribir…» en el desplegable) o distrito, sección y mesa («¿No aparece tu distrito, sección o mesa?»).

## Cómo funciona (apoderado)

1. Abre el enlace: **no hace falta iniciar sesión**.
2. **Saca la foto del acta** (o la sube desde la galería, o la introduce sin foto).
3. **Paso 1 · Tus datos y mesa**: **nombre y apellido** y **colegio electoral** (obligatorios; el móvil los recuerda), y la mesa con
   desplegables en cascada **provincia → municipio → distrito → sección → mesa**, cargados con los 947 municipios y las
   5.143 secciones censales oficiales del INE (2025). Si una sección no aparece, se puede escribir a mano. Antes era: provincia, municipio, distrito, sección y mesa. Si se ha cargado el listado
   de mesas, la elige de una lista. Recuerda la última mesa usada.
4. **Paso 2 · Votos**: censo, votantes, nulos, blancos y votos de cada candidatura.
   Un aviso **verde** indica que los votos cuadran (`candidaturas + blancos + nulos = votantes`)
   y uno **rojo** cuántos faltan o sobran.
5. **Enviar** → «Acta enviada». Si no hay cobertura, el acta se guarda en el móvil y **se envía sola**
   al volver la conexión (aparece como «Pendiente» hasta entonces).

## Panel de control (`/admin`)

- Actas recibidas y % escrutado, participación, nulos y blancos, votos y % por candidatura.
- Filtros por provincia y municipio, y tabla por municipio.
- **Actas e incidencias**: votos que no cuadran, más votantes que censo, censo distinto al oficial,
  mesa fuera del listado, observaciones del apoderado, dos versiones distintas de la misma mesa.
  Cada acta se abre con la foto, los datos y las versiones anteriores, y se puede marcar como revisada.
- **Exportar CSV** (se abre en Excel) para preparar el Escrutinio General.
- **Configuración**: nombre de la elección, candidaturas y colores, y listado de mesas.

> La app de los apoderados está **abierta**: cualquiera con el enlace puede enviar actas. Compártelo solo con tu equipo.
> El panel `/admin` sí está protegido con contraseña.

## Puesta en marcha

```bash
cd actas-escrutinio
ADMIN_PASSWORD="una-contraseña-larga" npm start
```

- App de apoderados: `http://localhost:3000`
- Panel: `http://localhost:3000/admin`
- Si no defines `ADMIN_PASSWORD`, se genera una y se muestra en la consola (y queda en `data/admin-password.txt`).

Después, en **Configuración**:

1. Revisa las **candidaturas**. Vienen precargadas las del **Congreso, generales 29-N-2026**, tal como las proclamó el
   BOE-A-2026-23103: en cada provincia salen solo las que se presentan allí y en el orden del acta.
2. (Recomendado) Carga el **listado de mesas** con un CSV `provincia;municipio;distrito;seccion;mesa;electores`
   (ver `ejemplos/mesas.csv`). Se puede preparar a partir de los datos de mesas que publica la Junta Electoral / el Idescat.

### Publicarla en internet (Render, recomendado)

El repositorio incluye `render.yaml`, así que en Render basta con:
**New → Blueprint → elegir este repositorio y la rama → Apply**. Crea el servicio con disco permanente,
`DATA_DIR=/var/data` y una contraseña de administración aleatoria (se ve en *Environment → ADMIN_PASSWORD*).

### Otras opciones

Para que los móviles puedan entrar, el servidor tiene que estar accesible por **HTTPS**
(la cámara y el modo sin conexión lo requieren). Opciones fáciles:

- Un VPS pequeño (Hetzner, OVH, DigitalOcean…) con Caddy delante, que pone HTTPS automático.
- Render / Railway / Fly.io con un **disco persistente** montado y `DATA_DIR` apuntando a él.

Variables de entorno: `PORT` (3000), `ADMIN_PASSWORD`, `DATA_DIR` (`./data`), `APP_SECRET` (opcional).

**Copia de seguridad**: toda la información está en `DATA_DIR` (actas en JSON y fotos en JPG). Basta con copiar esa carpeta.

## Diferencias con la app del vídeo (simplificaciones)

| App del partido | Esta versión |
|---|---|
| App nativa Android/iOS | Web app (sin instalar nada) |
| Código por SMS | Acceso abierto con el enlace (nombre y colegio obligatorios) |
| Lectura automática del acta (OCR) | Introducción manual + foto como prueba |
| Recorte automático de esquinas | Foto entera, con botón de girar |

Posibles mejoras: lectura automática de cifras con IA, cálculo de concejales (D'Hondt) por municipio,
versión en catalán, avisos por WhatsApp al equipo de soporte.
