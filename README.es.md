<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.md">English</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/vocal-synth-engine/readme.png" alt="Vocal Synth Engine" width="400" />
</p>

<p align="center">
  <a href="https://github.com/mcp-tool-shop-org/vocal-synth-engine/actions/workflows/ci.yml"><img src="https://github.com/mcp-tool-shop-org/vocal-synth-engine/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT">
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white" alt="Node >=20">
  <img src="https://img.shields.io/badge/status-pre--release-orange" alt="Status: pre-release">
</p>

<p align="center"><strong>Motor de sonido vocal determinista: síntesis aditiva, preajustes de voz, transmisión en tiempo real mediante WebSocket, sesiones colaborativas multijugador, interfaz de usuario tipo "cóckpit".</strong></p>

Un motor de síntesis vocal determinista, desarrollado en TypeScript. Genera voces cantadas a partir de datos de partitura, utilizando síntesis aditiva, ajustes predefinidos de voz y transmisión en tiempo real a través de WebSocket. Permite la interpretación en vivo mediante teclado/MIDI, la colaboración en sesiones musicales multijugador, o la conversión de partituras a formato WAV.

**Estado:** v1.0.3 (código fuente) — aún no se ha publicado en npm. Instale desde el código fuente hasta que se publique la versión v1.0.4 (consulte la sección [Instalación](#instalación)).

## Qué hace

- **Síntesis vocal aditiva:** parciales armónicos + envolvente espectral + ruido residual.
- **15 presets de voz:** análisis predefinidos de las voces de Kokoro TTS + presets de laboratorio, cada uno con múltiples timbres.
- **Reproducción polifónica:** polifonía máxima configurable, con gestión de estado por voz y "robo" de voces.
- **Modo en vivo:** reproducción de notas a través del teclado o MIDI, con transmisión de audio en tiempo real mediante WebSockets.
- **Sesiones colaborativas:** sesiones multijugador con autoridad de host, atribución de participantes y grabación.
- **Entrada de partituras:** carga de una `VocalScore` en una pista para reproducción automática sincronizada con el transportador.
- **Grabación y exportación:** captura de interpretaciones en vivo en una "EventTape", exportación a formato WAV con información completa de origen.
- **Letras y fonemas:** proceso de conversión de grafemas a fonemas con visualización de la "pista" de fonemas.
- **Interfaz de usuario (Cockpit):** aplicación web de una sola página (SPA) con editor de piano, teclado en vivo, panel XY, banco de reproducción y telemetría.
- **Determinista:** generador de números aleatorios con semilla, salida reproducible a partir de las mismas entradas.

## Arquitectura

```
                          ┌─── Cockpit UI (browser SPA) ───┐
                          │  Piano Roll  │  Live  │ Renders │
                          └──────────────┴────────┴─────────┘
                                     │        │
                              REST API    WebSocket
                                     │    /ws  /ws/jam
                          ┌──────────┴────────┴─────────────┐
                          │        Express Server            │
                          │  Render API │ Jam Sessions       │
                          └──────┬──────┴───────┬────────────┘
                                 │              │
                      StreamingVocalSynthEngine  │
                        LiveSynthEngine ─────────┘
                                 │
                    ┌────────────┼─────────────┐
              VoicePreset    DSP (FFT)    Curves (ADSR,
              (.f32 blobs)   Pitch Det.   vibrato, automation)
```

**Directorios principales:**

| Directorio. | Propósito. |
|-----------|---------|
| `src/engine/` | Sintetizador central: renderizado por bloques, motor de transmisión, curvas ADSR/vibrato. |
| `src/dsp/` | Procesamiento de señales: Transformada Rápida de Fourier (FFT), detección de tono. |
| `src/preset/` | Esquema, cargador y resolutor para la configuración de voz. |
| `src/server/` | Servidor de API WebSocket para Express, gestor de sesiones de improvisación musical. |
| `src/types/` | Tipos compartidos: puntuaciones, protocolo de sincronización, configuraciones predefinidas. |
| `src/cli/` | Herramientas de línea de comandos (CLI) para el usuario (analizar, preconfiguración de compilación, comparar, inspeccionar, calcular la puntuación de reproducción, resintetizar, generar archivos WAV de vocales, demostración en tiempo real). |
| `scripts/` | Crear/probar scripts de regresión (no incluidos en la distribución, ni parte de `npm test`). |
| `apps/cockpit/` | Interfaz de usuario para el navegador, desarrollada con Vite y TypeScript puro. |
| `presets/` | 15 ajustes de voz predefinidos que incluyen datos de timbre en formato binario. |

## Instalar

El paquete `@mcptoolshop/vocal-synth-engine` aún no ha sido publicado en npm. Hasta que se lance la versión 1.0.4, instálelo directamente desde el código fuente:

```bash
git clone https://github.com/mcp-tool-shop-org/vocal-synth-engine.git
cd vocal-synth-engine
npm ci
npm run build
```

Para fijar un commit específico en un proyecto derivado:

```bash
npm install github:mcp-tool-shop-org/vocal-synth-engine#<commit-sha>
```

## Inicio rápido

```bash
npm ci
npm run dev
```

El servidor de desarrollo se inicia en la dirección `http://localhost:4321`. La interfaz de usuario de Cockpit se sirve desde el mismo puerto.

## Interfaz de usuario de la cabina de vuelo

El panel de control es una aplicación web de una sola página (SPA) que se ejecuta en un navegador y tiene tres pestañas:

### Editor de partituras
- Rollo de piano con funciones de arrastrar y soltar para crear, mover y redimensionar notas (rango C2-C6).
- Controles individuales para cada nota: velocidad, timbre, brillo, vibrato, portamento.
- Introducción de letras con generación automática de fonemas.
- Capa de fonemas sincronizada con el rollo de piano.
- Exportación a formato WAV con ajustes predefinidos configurables, polifonía, semilla y BPM.

### Modo en vivo
- Teclado cromático de 24 teclas (ratón + asignación de teclas).
- Entrada de dispositivo MIDI con filtrado de canales.
- Panel XY para la modulación en tiempo real del timbre (eje X) y la expresividad (eje Y).
- Pedal de sostenido, controles deslizantes de velocidad/expresividad y vibrato.
- Metrónomo con cuadrícula de cuantización (1/4, 1/8, 1/16).
- Calibración de latencia (presets: bajo, equilibrado, seguro).
- Grabar interpretaciones y guardar en la biblioteca de proyectos.
- Telemetría en tiempo real: voces, nivel máximo de dBFS, RTF (factor de forma de onda), riesgo de clics, fluctuación de la frecuencia de muestreo.

### Render Bank
- Ver, reproducir, fijar, renombrar y eliminar las representaciones guardadas.
- Cargar la puntuación de una representación de nuevo en el editor.
- Comparación lado a lado de las métricas de rendimiento entre las representaciones.
- Seguimiento del origen: commit SHA, hash de la puntuación, hash WAV.

## Sesiones de improvisación

Sesiones colaborativas multiusuario a través de WebSocket (`/ws/jam`):

- **Autoridad del anfitrión** — el creador de la sesión controla el transporte, las pistas, la grabación y la cuantización.
- **Participación de invitados** — los invitados pueden tocar notas en cualquier pista, pero no pueden modificar el estado de la sesión.
- **Propiedad de la pista** — las pistas pertenecen a su creador; solo el propietario o el anfitrión pueden modificarlas o eliminarlas.
- **Atribución de participantes** — cada evento de nota en la cinta de eventos registra quién lo tocó.
- **Modo de entrada de puntuación** — cargue una `VocalScore` en una pista para la reproducción automática sincronizada con el transporte.
- **Grabación** — capture las notas de todos los participantes en una cinta de eventos y expórtela a WAV.
- **Metrónomo** — metrónomo compartido con BPM y compás configurables.

### Protocolo de improvisación

Los clientes se conectan a `/ws/jam` e intercambian mensajes JSON:

```
Client: jam_hello → Server: jam_hello_ack (participantId)
Client: session_create → Server: session_created (snapshot)
Client: session_join → Server: session_joined (snapshot)
Client: track_note_on/off → Server: track_note_ack
Client: record_start/stop → Server: record_status
Client: record_export → Server: record_exported (renderId)
Client: track_set_score → Server: score_status
```

## API

| Punto de acceso | Método | Autenticación | Descripción |
|----------|--------|------|-------------|
| `/api/health` | GET | No | Estado del servidor, versión, tiempo de actividad. |
| `/api/presets` | GET | No | Lista de preajustes de voz con timbres y metadatos. |
| `/api/phonemize` | POST | Sí | Convierte texto de letras en eventos fonéticos. |
| `/api/render` | POST | Sí | Renderiza una puntuación a WAV. |
| `/api/renders` | GET | Sí | Lista de todas las representaciones guardadas. |
| `/api/renders/:id/audio.wav` | GET | Sí | Descarga el archivo WAV de la representación. |
| `/api/renders/:id/score` | GET | Sí | Puntuación JSON original. |
| `/api/renders/:id/meta` | GET | Sí | Metadatos de la representación. |
| `/api/renders/:id/telemetry` | GET | Sí | Métricas de rendimiento de la representación (pico, RTF, clics). |
| `/api/renders/:id/provenance` | GET | Sí | Origen (commit, hashes, configuración). |

La autenticación es opcional; se habilita cuando `AUTH_TOKEN` está configurado en el entorno. Los tokens se pueden proporcionar a través del encabezado `Authorization: Bearer <token>` o el parámetro de consulta `?token=<token>`.

### WebSocket

| Ruta | Propósito. |
|------|---------|
| `/ws` | Modo en vivo: reproducción de notas de un solo usuario con transmisión de audio. |
| `/ws/jam` | Sesiones de improvisación: colaboración multiusuario con grabación. |

## Servidor MCP

`vocal-synth-engine` incluye un servidor MCP (Model Context Protocol) para que los agentes de Claude y otros clientes MCP puedan llamar directamente al motor; no se necesita ninguna infraestructura HTTP. Inicie el servicio a través de la entrada de binario `vocal-synth-engine-mcp` (transporte stdio).

Herramientas expuestas:

| Herramienta | Propósito. |
|------|---------|
| `render_score` | Renderiza una `VocalScore` a través de un preajuste → WAV en base64 + métricas de rendimiento. |
| `phonemize_text` | Texto de letras → Eventos fonéticos ARPAbet (alineados con notas si se proporcionan `notes`). |
| `list_presets` | Enumera los ID de preajustes disponibles (misma estructura que GET /api/presets). |
| `validate_score` | Analiza y valida el JSON de `VocalScore` sin renderizar. |
| `inspect_preset` | Manifiesto del preajuste + armónicos/energía por timbre (igual que `vse-inspect --json`). |

Conéctelo a una configuración de Claude Desktop / Code:

```json
{
  "mcpServers": {
    "vocal-synth-engine": {
      "command": "npx",
      "args": ["-y", "@mcptoolshop/vocal-synth-engine", "vocal-synth-engine-mcp"]
    }
  }
}
```

## Preajustes de voz

15 preajustes incluidos con soporte multi-timbre:

| Preajuste | Voz | Timbres |
|--------|-------|---------|
| `default-voice` | Femenina básica | Timbre predeterminado |
| `bright-lab` | Laboratorio/experimental | Formante brillante |
| `kokoro-af-*` | Aoede, Heart, Jessica, Sky | Múltiples por voz |
| `kokoro-am-*` | Eric, Fenrir, Liam, Onyx | Múltiples por voz |
| `kokoro-bf-*` | Alice, Emma, Isabella | Múltiples por voz |
| `kokoro-bm-*` | George, Lewis | Múltiples por voz |

Cada preajuste incluye archivos binarios `.f32` (magnitudes armónicas, envolvente espectral, nivel de ruido) y un manifiesto JSON que describe el rango de tono, la resonancia y los valores predeterminados de vibrato.

## Scripts

```bash
npm run dev          # Dev server with hot reload
npm run build        # Build cockpit + server
npm start            # Production server
npm run inspect      # CLI preset inspector
```

## Pruebas

La superficie de prueba principal es vitest:

```bash
npm test                # Run all unit + integration tests once
npm run test:watch      # Watch mode
npm run test:coverage   # Coverage report
```

Scripts de regresión adicionales en el directorio `scripts/` (requieren un servidor de desarrollo en ejecución para las pruebas de improvisación; los demás son independientes):

```bash
npx tsx scripts/test-jam-session.ts        # Jam session lifecycle
npx tsx scripts/test-jam-recording.ts      # Recording & export
npx tsx scripts/test-jam-collaboration.ts  # Collaboration & score input
npx tsx scripts/test-score-render.ts       # Score rendering pipeline
npx tsx scripts/test-consonants.ts         # Consonant phonemes
npx tsx scripts/test-g2p.ts                # Grapheme-to-phoneme
npx tsx scripts/test-lyrics-golden.ts      # Lyrics golden tests
npx tsx scripts/test-multi-timbre.ts       # Multi-timbre rendering
npx tsx scripts/test-noise-tail.ts         # Tail silence/noise
```

Estos archivos están programados para migrarse a la carpeta `tests/integration/` dentro de vitest en una futura actualización, lo que permite que se incluyan automáticamente en la cobertura de las pruebas con `npm test`.

## Seguridad y alcance de los datos

| Aspecto | Detalle |
|--------|--------|
| **Data touched** | Síntesis de audio (en memoria), conexiones WebSocket (localhost), salida de archivos WAV, datos de la partitura, preajustes de voz. |
| **Data NOT touched** | Sin telemetría, sin análisis, sin sincronización en la nube, sin credenciales almacenadas. |
| **Permissions** | Red: Servidor WebSocket en localhost. Disco: Salida de archivos WAV a las rutas especificadas por el usuario. |
| **Network** | Solo servidor WebSocket en localhost: no hay conexiones salientes. |
| **Telemetry** | Ninguna se recopila ni se envía. |

Consulte [SECURITY.md](SECURITY.md) para informar sobre vulnerabilidades.

## Cuadro de evaluación

| Categoría | Puntuación |
|----------|-------|
| A. Seguridad | 10 |
| B. Manejo de errores | 10 |
| C. Documentación para el operador | 10 |
| D. Higiene en el proceso de entrega | 10 |
| E. Identidad (suave) | 10 |
| **Overall** | **50/50** |

> Auditoría completa: [SHIP_GATE.md](SHIP_GATE.md) · [SCORECARD.md](SCORECARD.md)

## Licencia

MIT. Consulte [LICENSE](LICENSE).
