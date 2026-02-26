<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.zh.md">中文</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.hi.md">हिन्दी</a> ·
  <a href="README.it.md">Italiano</a> ·
  <a href="README.pt-BR.md">Português</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/vocal-synth-engine/readme.png" alt="Vocal Synth Engine" width="400" />
</p>

<p align="center">
  <a href="https://github.com/mcp-tool-shop-org/vocal-synth-engine/actions/workflows/ci.yml"><img src="https://github.com/mcp-tool-shop-org/vocal-synth-engine/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT">
  <a href="https://mcp-tool-shop-org.github.io/vocal-synth-engine/"><img src="https://img.shields.io/badge/Landing_Page-live-blue" alt="Landing Page"></a>
</p>

<p align="center"><strong>Deterministic vocal instrument engine — additive synthesis, voice presets, real-time WebSocket streaming, multi-user jam sessions, cockpit UI</strong></p>

Um motor de instrumento vocal determinístico construído em TypeScript. Renderiza vozes cantadas a partir de dados de partitura usando síntese aditiva, predefinições de voz e streaming em tempo real via WebSocket. Permite tocar ao vivo via teclado/MIDI, colaborar em sessões colaborativas com vários usuários ou renderizar partituras para arquivos WAV.

## O que ele faz

- **Síntese vocal aditiva** — harmônicos + envelope espectral + ruído residual
- **15 predefinições de voz** — análises pré-existentes das vozes Kokoro TTS + predefinições de laboratório, cada uma com múltiplas timbres
- **Renderização polifônica** — polifonia máxima configurável com gerenciamento de estado por voz e "roubo" de voz
- **Modo ao vivo** — toque notas via teclado ou MIDI com streaming de áudio em tempo real via WebSocket
- **Sessões colaborativas** — sessões colaborativas com vários usuários, com autoridade do host, atribuição de participantes e gravação
- **Entrada de partitura** — carregue uma `VocalScore` em uma faixa para reprodução automática sincronizada com a transportadora
- **Gravação e exportação** — capture performances ao vivo em uma "EventTape", exporte para WAV com rastreamento completo de origem
- **Letras e fonemas** — pipeline de grafema para fonema com visualização da "faixa" de fonemas
- **Interface de usuário (Cockpit)** — SPA baseada em navegador com editor de piano roll, teclado ao vivo, painel XY, banco de renderização e telemetria
- **Determinístico** — RNG com semente, saída reproduzível a partir das mesmas entradas

## Arquitetura

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

**Diretórios principais:**

| Diretório | Propósito |
| ----------- | --------- |
| `src/engine/` | Núcleo do sintetizador — renderizador de blocos, motor de streaming, curvas ADSR/vibrato |
| `src/dsp/` | Processamento de sinal — FFT, detecção de afinação |
| `src/preset/` | Esquema, carregador e resolvedor de predefinição de voz |
| `src/server/` | Servidor de API Express + WebSocket, gerenciador de sessão colaborativa |
| `src/types/` | Tipos compartilhados — partituras, protocolo de sessão colaborativa, predefinições |
| `src/cli/` | Ferramentas de linha de comando (CLI) + suítes de testes de integração |
| `apps/cockpit/` | Interface de usuário (Cockpit) para navegador (Vite + TypeScript puro) |
| `presets/` | 15 predefinições de voz incluídas com dados de timbre binários |

## Como começar

```bash
npm ci
npm run dev
```

O servidor de desenvolvimento é iniciado em `http://localhost:4321`. A interface de usuário (Cockpit) é servida no mesmo endereço.

## Interface de usuário (Cockpit)

O cockpit é uma SPA baseada em navegador com três abas:

### Editor de partitura
- Piano roll com funções de arrastar para criar, mover e redimensionar notas (intervalo de C2 a C6)
- Controles por nota: velocidade, timbre, "breathiness" (leveza), vibrato, portamento
- Entrada de letras com geração automática de fonemas
- Sobreposição da "faixa" de fonemas sincronizada com o piano roll
- Renderização para WAV com predefinição, polifonia, semente e BPM configuráveis

### Modo ao vivo
- Teclado cromático de 24 teclas (mouse + atalhos de teclado)
- Entrada de dispositivo MIDI com filtragem de canal
- Painel XY para transformação de timbre em tempo real (eixo X) e "breathiness" (eixo Y)
- Pedal de sustentação, controles deslizantes de velocidade/breathiness, controles de vibrato
- Metrônomo com grade de quantização (1/4, 1/8, 1/16)
- Calibração de latência (predefinições de baixa, equilibrada e segura)
- Grave performances e salve no banco de renderização
- Telemetria em tempo real: vozes, pico de dBFS, RTF (Fator de Forma de Ruído), risco de "clique", "jitter" do WebSocket

### Banco de renderização
- Navegue, reproduza, fixe, renomeie e exclua renderizações salvas
- Carregue a partitura de uma renderização de volta para o editor
- Comparação lado a lado da telemetria entre renderizações
- Rastreamento de origem: hash do commit, hash da partitura, hash do WAV

## Sessões colaborativas

Sessões colaborativas com vários usuários via WebSocket (`/ws/jam`):

- **Autoridade do host** — o criador da sessão controla o transporte, as faixas, a gravação e a quantização.
- **Participação de convidados** — os convidados podem tocar notas em qualquer faixa, mas não podem modificar o estado da sessão.
- **Propriedade das faixas** — as faixas pertencem ao seu criador; apenas o proprietário ou o host podem modificá-las/removê-las.
- **Atribuição de participantes** — cada evento de nota no EventTape registra quem o tocou.
- **Modo de entrada de partitura** — carregue uma `VocalScore` em uma faixa para reprodução automática sincronizada com o transporte.
- **Gravação** — capture as notas de todos os participantes em um EventTape e exporte para WAV.
- **Metrônomo** — metrônomo compartilhado com BPM e assinatura de tempo configuráveis.

### Protocolo Jam

Os clientes conectam-se a `/ws/jam` e trocam mensagens JSON:

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

| Endpoint | Método | Auth | Descrição |
| ---------- | -------- | ------ | ------------- |
| `/api/health` | GET | No | Saúde do servidor, versão, tempo de atividade |
| `/api/presets` | GET | No | Lista de predefinições de voz com timbres e metadados |
| `/api/phonemize` | POST | Yes | Converte texto de letras em eventos fonêmicos |
| `/api/render` | POST | Yes | Renderiza uma partitura para WAV |
| `/api/renders` | GET | Yes | Lista todas as renderizações salvas |
| `/api/renders/:id/audio.wav` | GET | Yes | Faz o download da renderização WAV |
| `/api/renders/:id/score` | GET | Yes | Partitura JSON original |
| `/api/renders/:id/meta` | GET | Yes | Metadados da renderização |
| `/api/renders/:id/telemetry` | GET | Yes | Telemetria da renderização (pico, RTF, cliques) |
| `/api/renders/:id/provenance` | GET | Yes | Origem (commit, hashes, configuração) |

A autenticação é opcional — habilitada quando `AUTH_TOKEN` é definido no ambiente.

### WebSocket

| Path | Propósito |
| ------ | --------- |
| `/ws` | Modo de reprodução — reprodução de notas de um único usuário com streaming de áudio. |
| `/ws/jam` | Sessões Jam — colaboração multiusuário com gravação. |

## Predefinições de Voz

15 predefinições incluídas com suporte a multi-timbres:

| Predefinição | Voice | Timbres |
| -------- | ------- | --------- |
| `default-voice` | Feminina padrão | Tímbre padrão |
| `bright-lab` | Laboratório/experimental | Formante brilhante |
| `kokoro-af-*` | Aoede, Heart, Jessica, Sky | Múltiplos por voz |
| `kokoro-am-*` | Eric, Fenrir, Liam, Onyx | Múltiplos por voz |
| `kokoro-bf-*` | Alice, Emma, Isabella | Múltiplos por voz |
| `kokoro-bm-*` | George, Lewis | Múltiplos por voz |

Cada predefinição inclui ativos binários `.f32` (magnitudes harmônicas, envelope espectral, nível de ruído) e um manifesto JSON que descreve a faixa de afinação, ressonância e vibrato padrão.

## Scripts

```bash
npm run dev          # Dev server with hot reload
npm run build        # Build cockpit + server
npm start            # Production server
npm run inspect      # CLI preset inspector
```

## Testes

Testes de integração são executados contra um servidor de desenvolvimento ativo:

```bash
# Start the server first
npm run dev

# Then in another terminal:
npx tsx src/cli/test-jam-session.ts        # Jam session lifecycle (12 tests)
npx tsx src/cli/test-jam-recording.ts      # Recording & export (10 tests)
npx tsx src/cli/test-jam-collaboration.ts  # Collaboration & score input (12 tests)
npx tsx src/cli/test-score-render.ts       # Score rendering pipeline
npx tsx src/cli/test-consonants.ts         # Consonant phonemes
npx tsx src/cli/test-g2p.ts               # Grapheme-to-phoneme
npx tsx src/cli/test-lyrics-golden.ts      # Lyrics golden tests
npx tsx src/cli/test-multi-timbre.ts       # Multi-timbre rendering
npx tsx src/cli/test-noise-tail.ts         # Tail silence/noise
```

## Licença

MIT. Veja [LICENSE](LICENSE).
