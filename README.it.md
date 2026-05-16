<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.md">English</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

<p align="center"><strong>Motore per strumenti vocali deterministico: sintesi additiva, preset vocali, streaming WebSocket in tempo reale, sessioni musicali collaborative multiutente, interfaccia utente intuitiva.</strong></p>

Un motore per strumenti vocali deterministico, sviluppato in TypeScript. Permette di riprodurre voci cantate a partire da dati musicali, utilizzando la sintesi additiva, preset vocali e streaming WebSocket in tempo reale. È possibile suonare in diretta tramite tastiera/MIDI, collaborare in sessioni musicali con più utenti, oppure generare file audio in formato WAV a partire dalle partiture.

**Stato:** v1.0.3. Il codice sorgente non è ancora stato pubblicato su npm. Installare direttamente dal codice sorgente fino alla pubblicazione della versione v1.0.4 (vedere [Installazione](#installazione)).

## Cosa fa

- **Sintesi vocale additiva** — armoniche parziali + inviluppo spettrale + rumore residuo.
- **15 preset vocali** — analisi preesistente delle voci di Kokoro TTS, insieme a preset di laboratorio, ognuno con molteplici timbri.
- **Rendering polifonico** — polifonia massima configurabile, con gestione dello stato per ogni voce e possibilità di "furto" di voci.
- **Modalità live** — riproduzione di note tramite tastiera o MIDI, con streaming audio WebSocket in tempo reale.
- **Sessioni collaborative** — sessioni collaborative multiutente con autorità dell'host, attribuzione dei partecipanti e possibilità di registrazione.
- **Importazione di partiture** — caricamento di un file `VocalScore` in una traccia per la riproduzione automatica sincronizzata con il trasporto.
- **Registrazione ed esportazione** — registrazione di performance in tempo reale su un "EventTape", esportazione in formato WAV con informazioni complete sulla provenienza.
- **Testi e fonemi** — pipeline da grafema a fonema, con visualizzazione delle "lane" dei fonemi.
- **Interfaccia utente (Cockpit)** — applicazione web SPA (Single Page Application) con editor di piano, tastiera live, pad XY, libreria di rendering e telemetria.
- **Determinismo** — generatore di numeri casuali con seme, output riproducibile a partire dagli stessi input.

## Architettura

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

**Directory principali:**

| Elenco. | Scopo. |
|-----------|---------|
| `src/engine/` | Sintetizzatore principale: motore di rendering a blocchi, sistema di streaming, curve ADSR/vibrato. |
| `src/dsp/` | Elaborazione del segnale: Trasformata di Fourier veloce (FFT), rilevamento della frequenza fondamentale. |
| `src/preset/` | Schema, caricatore e risolutore per le impostazioni vocali. |
| `src/server/` | Server API Express + WebSocket, gestore di sessioni musicali collaborative. |
| `src/types/` | Tipi condivisi: punteggi, protocollo di collaborazione, impostazioni predefinite. |
| `src/cli/` | Strumenti a riga di comando (CLI) per l'utente (analyze, build-preset, compare, inspect, play-score, resynth, gen-vowel-wav, realtime-demo). |
| `scripts/` | Creare/testare script di regressione (non inclusi nella distribuzione, non parte di `npm test`). |
| `apps/cockpit/` | Interfaccia utente per il controllo del browser (sviluppata con Vite e TypeScript standard). |
| `presets/` | 15 preset di equalizzazione vocale, inclusi i dati timbrici in formato binario. |

## Installa

Il pacchetto `@mcptoolshop/vocal-synth-engine` non è ancora stato pubblicato su npm. Fino alla versione 1.0.4, installare direttamente dal codice sorgente:

```bash
git clone https://github.com/mcp-tool-shop-org/vocal-synth-engine.git
cd vocal-synth-engine
npm ci
npm run build
```

Per "fissare" un commit specifico in un progetto derivato:

```bash
npm install github:mcp-tool-shop-org/vocal-synth-engine#<commit-sha>
```

## Avvio rapido

```bash
npm ci
npm run dev
```

Il server di sviluppo è accessibile all'indirizzo `http://localhost:4321`. L'interfaccia utente di Cockpit è disponibile sullo stesso indirizzo.

## Interfaccia utente della cabina di pilotaggio

La dashboard è un'applicazione web single-page (SPA) accessibile tramite browser e presenta tre schede:

### Editor di partiture
- Tastiera virtuale con funzionalità di trascinamento per creare, spostare e ridimensionare le note (intervallo C2-C6).
- Controlli per singola nota: intensità, timbro, effetto "soffio", vibrato, portamento.
- Inserimento di testi con generazione automatica dei fonemi.
- Sovrapposizione di una traccia fonetica sincronizzata con la tastiera virtuale.
- Esportazione in formato WAV con impostazioni predefinite configurabili, polifonia, seme e BPM.

### Modalità live
- Tastiera cromatica a 24 tasti (mouse + assegnazione di tasti)
- Ingresso MIDI con filtro dei canali
- Pad XY per la modulazione in tempo reale del timbro (asse X) e della "respirazione" (asse Y)
- Pedale di sustain, cursori per la sensibilità alla velocità/respirazione, controlli del vibrato
- Metronomo con griglia di quantizzazione (1/4, 1/8, 1/16)
- Calibrazione della latenza (preset "bassa", "equilibrata", "sicura")
- Possibilità di registrare le performance e salvarle nella libreria di rendering
- Telemetria in tempo reale: numero di voci, picco in dBFS, RTF (Real-Time Factor), rischio di "click", jitter del WS (Waveform Synthesis).

### Render Bank
- Esplorare, riprodurre, salvare, rinominare ed eliminare i rendering salvati.
- Caricare il punteggio di un rendering nell'editor.
- Confronto telemetrico affiancato tra i rendering.
- Tracciamento della provenienza: commit SHA, hash del punteggio, hash WAV.

## Sessioni di Jam

Sessioni collaborative multiutente tramite WebSocket (`/ws/jam`):

- **Autorità dell'host** — il creatore della sessione controlla il trasporto, le tracce, la registrazione e la quantizzazione.
- **Partecipazione degli ospiti** — gli ospiti possono suonare note su qualsiasi traccia, ma non possono modificare lo stato della sessione.
- **Proprietà delle tracce** — le tracce appartengono al loro creatore; solo il proprietario o l'host possono modificarle/eliminarle.
- **Attribuzione dei partecipanti** — ogni evento di nota nella EventTape registra chi l'ha suonata.
- **Modalità di input del punteggio** — caricare un `VocalScore` in una traccia per la riproduzione automatica sincronizzata con il trasporto.
- **Registrazione** — catturare le note di tutti i partecipanti in una EventTape, esportare in formato WAV.
- **Metronomo** — metronomo condiviso con BPM e tempo configurabili.

### Protocollo di Jam

I client si connettono a `/ws/jam` e scambiano messaggi JSON:

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

| Endpoint | Metodo | Autenticazione | Descrizione |
|----------|--------|------|-------------|
| `/api/health` | GET | No | Stato del server, versione, uptime |
| `/api/presets` | GET | No | Elenco dei preset vocali con timbri e metadati. |
| `/api/phonemize` | POST | Sì | Convertire il testo dei testi in eventi fonetici. |
| `/api/render` | POST | Sì | Renderizzare un punteggio in formato WAV. |
| `/api/renders` | GET | Sì | Elencare tutti i rendering salvati. |
| `/api/renders/:id/audio.wav` | GET | Sì | Scaricare il rendering in formato WAV. |
| `/api/renders/:id/score` | GET | Sì | Punteggio JSON originale. |
| `/api/renders/:id/meta` | GET | Sì | Metadati del rendering. |
| `/api/renders/:id/telemetry` | GET | Sì | Telemetria del rendering (picco, RTF, click). |
| `/api/renders/:id/provenance` | GET | Sì | Provenienza (commit, hash, configurazione). |

L'autenticazione è facoltativa; è abilitata quando `AUTH_TOKEN` è impostato nell'ambiente. I token possono essere forniti tramite l'intestazione `Authorization: Bearer <token>` o il parametro di query `?token=<token>`.

### WebSocket

| Percorso | Scopo. |
|------|---------|
| `/ws` | Modalità live — riproduzione di note a utente singolo con streaming audio. |
| `/ws/jam` | Sessioni di jam — collaborazione multiutente con registrazione. |

## Server MCP

`vocal-synth-engine` include un server MCP (Model Context Protocol) in modo che gli agenti Claude e altri client MCP possano chiamare direttamente il motore; non è necessario alcun scaffolding HTTP. Avviare tramite l'entry point `vocal-synth-engine-mcp` (trasporto stdio).

Strumenti esposti:

| Strumento | Scopo. |
|------|---------|
| `render_score` | Renderizzare un VocalScore tramite un preset → WAV in base64 + telemetria. |
| `phonemize_text` | Testo dei testi → Eventi fonetici ARPAbet (allineati alle note se forniti `notes`). |
| `list_presets` | Elencare gli ID dei preset disponibili (stessa struttura di GET /api/presets). |
| `validate_score` | Analizzare e validare il JSON VocalScore senza renderizzare. |
| `inspect_preset` | Manifesto del preset + armoniche/energia per timbro (come `vse-inspect --json`). |

Integrare in una configurazione Claude Desktop / Code:

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

## Preset vocali

15 preset inclusi con supporto multi-timbro:

| Preset | Voce | Timbri |
|--------|-------|---------|
| `default-voice` | Femminile di base | Timbro predefinito |
| `bright-lab` | Laboratorio/sperimentale | Formante brillante |
| `kokoro-af-*` | Aoede, Heart, Jessica, Sky | Multipli per voce |
| `kokoro-am-*` | Eric, Fenrir, Liam, Onyx | Multipli per voce |
| `kokoro-bf-*` | Alice, Emma, Isabella | Multipli per voce |
| `kokoro-bm-*` | George, Lewis | Multipli per voce |

Ogni preset include asset binari `.f32` (magnitudini armoniche, inviluppo spettrale, rumore di fondo) e un manifest JSON che descrive l'intervallo di pitch, la risonanza e i valori predefiniti del vibrato.

## Script

```bash
npm run dev          # Dev server with hot reload
npm run build        # Build cockpit + server
npm start            # Production server
npm run inspect      # CLI preset inspector
```

## Test

La superficie di test principale è vitest:

```bash
npm test                # Run all unit + integration tests once
npm run test:watch      # Watch mode
npm run test:coverage   # Coverage report
```

Script di regressione aggiuntivi nella directory `scripts/` (richiedono un server di sviluppo in esecuzione per i test di jam; gli altri sono autonomi):

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

Questi elementi saranno spostati nella directory `tests/integration/` all'interno di vitest in una versione futura, in modo da essere automaticamente inclusi nella copertura dei test tramite `npm test`.

## Sicurezza e ambito dei dati

| Aspetto | Dettaglio |
|--------|--------|
| **Data touched** | Sintesi audio (in memoria), connessioni WebSocket (localhost), output di file WAV, dati della partitura, preset vocali. |
| **Data NOT touched** | Nessuna telemetria, nessuna analisi, nessuna sincronizzazione cloud, nessuna credenziale memorizzata. |
| **Permissions** | Rete: server WebSocket su localhost. Disco: output di file WAV in percorsi specificati dall'utente. |
| **Network** | Solo server WebSocket su localhost: nessuna connessione in uscita. |
| **Telemetry** | Nessun dato raccolto o trasmesso. |

Consultare il file [SECURITY.md](SECURITY.md) per la segnalazione di vulnerabilità.

## Scheda di valutazione

| Categoria | Punteggio |
|----------|-------|
| A. Sicurezza | 10 |
| B. Gestione degli errori | 10 |
| C. Documentazione per gli operatori | 10 |
| D. Igiene del rilascio | 10 |
| E. Identità (soft) | 10 |
| **Overall** | **50/50** |

> Audit completo: [SHIP_GATE.md](SHIP_GATE.md) · [SCORECARD.md](SCORECARD.md)

## Licenza

MIT. Consultare il file [LICENSE](LICENSE).
