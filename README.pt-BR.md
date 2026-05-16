<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.md">English</a>
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

<p align="center"><strong>Motor de instrumento vocal determinístico — síntese aditiva, presets de voz, streaming em tempo real via WebSocket, sessões colaborativas multiusuário, interface de usuário (UI) tipo "cockpit".</strong></p>

Um motor de instrumento vocal determinístico construído em TypeScript. Renderiza vozes cantadas a partir de dados de partitura usando síntese aditiva, presets de voz e streaming em tempo real via WebSocket. Permite tocar ao vivo via teclado/MIDI, colaborar em sessões colaborativas multiusuário ou renderizar partituras para arquivos WAV.

> **Status:** v1.0.3 (código-fonte) — ainda não publicado no npm. Instale a partir do código-fonte até a versão v1.0.4 ser publicada (veja [Instalação](#install)).

## O que ele faz

- **Síntese vocal aditiva** — harmônicos + envelope espectral + ruído residual.
- **15 presets de voz** — análises de áudio congeladas de vozes Kokoro TTS + presets de laboratório, cada um com múltiplas timbres.
- **Renderização polifônica** — polifonia máxima configurável com gerenciamento de estado por voz e "roubo" de voz.
- **Modo ao vivo** — toque notas via teclado ou MIDI com streaming de áudio em tempo real via WebSocket.
- **Sessões colaborativas** — sessões colaborativas multiusuário com autoridade do host, atribuição de participantes e gravação.
- **Entrada de partitura** — carregue uma `VocalScore` em uma faixa para reprodução automática sincronizada com o "transporte".
- **Gravação e exportação** — capture performances ao vivo em um "EventTape", exporte para WAV com informações completas de origem.
- **Letras e fonemas** — pipeline de grafema para fonema com visualização da "faixa" de fonemas.
- **UI tipo "cockpit"** — SPA (aplicativo de página única) baseado em navegador com editor de piano roll, teclado ao vivo, painel XY, banco de renderização e telemetria.
- **Determinístico** — RNG (gerador de números aleatórios) com semente, saída reproduzível a partir das mesmas entradas.

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
|-----------|---------|
| `src/engine/` | Núcleo do sintetizador — renderizador de blocos, motor de streaming, curvas ADSR/vibrato. |
| `src/dsp/` | Processamento de sinal — FFT (Transformada Rápida de Fourier), detecção de afinação. |
| `src/preset/` | Esquema, carregador e resolvedor de VoicePreset. |
| `src/server/` | Servidor de API Express + WebSocket, gerenciador de sessões colaborativas. |
| `src/types/` | Tipos compartilhados — partituras, protocolo de sessão colaborativa, presets. |
| `src/cli/` | Ferramentas de linha de comando (CLI) para o usuário (analyze, build-preset, compare, inspect, play-score, resynth, gen-vowel-wav, realtime-demo). |
| `scripts/` | Scripts de build/teste de regressão (não incluídos, não fazem parte de `npm test`). |
| `apps/cockpit/` | UI tipo "cockpit" para navegador (Vite + TypeScript puro). |
| `presets/` | 15 presets de voz agrupados com dados de timbre binários. |

## Instalação

O pacote `@mcptoolshop/vocal-synth-engine` ainda não foi publicado no npm. Até a versão v1.0.4 ser publicada, instale a partir do código-fonte:

```bash
git clone https://github.com/mcp-tool-shop-org/vocal-synth-engine.git
cd vocal-synth-engine
npm ci
npm run build
```

Para fixar um commit específico em um projeto dependente:

```bash
npm install github:mcp-tool-shop-org/vocal-synth-engine#<commit-sha>
```

## Início rápido

```bash
npm ci
npm run dev
```

O servidor de desenvolvimento inicia em `http://localhost:4321`. A UI tipo "cockpit" é servida na mesma porta.

## UI tipo "cockpit"

O "cockpit" é uma SPA baseada em navegador com três abas:

### Editor de Partitura
- Piano roll com funções de arrastar para criar, mover e redimensionar notas (intervalo C2-C6).
- Controles por nota: velocidade, timbre, "breathiness" (leveza), vibrato, portamento.
- Entrada de letras com geração automática de fonemas.
- Sobreposição da "faixa" de fonemas sincronizada com o piano roll.
- Renderização para WAV com preset, polifonia, semente e BPM configuráveis.

### Modo ao vivo
- Teclado cromático de 24 teclas (mouse + atalhos de teclado).
- Entrada de dispositivo MIDI com filtragem de canal.
- Painel XY para transformação de timbre em tempo real (eixo X) e "breathiness" (eixo Y).
- Pedal de sustentação, sliders de velocidade/breathiness, controles de vibrato.
- Metrônomo com grade de quantização (1/4, 1/8, 1/16).
- Calibração de latência (presets de baixa latência, equilibrado e seguro).
- Grave performances e salve no banco de renderização.
- Telemetria em tempo real: vozes, pico de dBFS, RTF (Fator de Forma de Ruído), risco de "clique", "jitter" do WebSocket.

### Banco de Renderização
- Navegar, reproduzir, fixar, renomear e excluir renderizações salvas.
- Carregar a pontuação de uma renderização de volta para o editor.
- Comparação lado a lado de dados de telemetria entre renderizações.
- Rastreamento de origem: hash do commit, hash da pontuação, hash WAV.

## Sessões de Jam

Sessões colaborativas multiusuário via WebSocket (`/ws/jam`):

- **Autoridade do host** — o criador da sessão controla o transporte, as faixas, a gravação e a quantização.
- **Participação de convidados** — os convidados podem tocar notas em qualquer faixa, mas não podem modificar o estado da sessão.
- **Propriedade da faixa** — as faixas pertencem ao seu criador; apenas o proprietário ou o host podem modificar/remover.
- **Atribuição de participantes** — cada evento de nota na EventTape registra quem o tocou.
- **Modo de entrada de pontuação** — carregue uma `VocalScore` em uma faixa para reprodução automática sincronizada com o transporte.
- **Gravação** — capture as notas de todos os participantes em uma EventTape e exporte para WAV.
- **Metrônomo** — metrônomo compartilhado com BPM e assinatura de tempo configuráveis.

### Protocolo de Jam

Os clientes se conectam a `/ws/jam` e trocam mensagens JSON:

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

| Endpoint | Método | Autenticação | Descrição |
|----------|--------|------|-------------|
| `/api/health` | GET | No | Estado do servidor, versão, tempo de atividade. |
| `/api/presets` | GET | No | Lista de predefinições de voz com timbres e metadados. |
| `/api/phonemize` | POST | Sim | Converte texto de letras em eventos fonêmicos. |
| `/api/render` | POST | Sim | Renderiza uma pontuação para WAV. |
| `/api/renders` | GET | Sim | Lista de todas as renderizações salvas. |
| `/api/renders/:id/audio.wav` | GET | Sim | Baixa a renderização WAV. |
| `/api/renders/:id/score` | GET | Sim | Pontuação JSON original. |
| `/api/renders/:id/meta` | GET | Sim | Metadados da renderização. |
| `/api/renders/:id/telemetry` | GET | Sim | Telemetria da renderização (pico, RTF, cliques). |
| `/api/renders/:id/provenance` | GET | Sim | Origem (commit, hashes, configuração). |

A autenticação é opcional — habilitada quando `AUTH_TOKEN` é definido no ambiente. Os tokens podem ser fornecidos via cabeçalho `Authorization: Bearer <token>` ou parâmetro de consulta `?token=<token>`.

### WebSocket

| Caminho | Propósito |
|------|---------|
| `/ws` | Modo de reprodução — reprodução de notas de um único usuário com streaming de áudio. |
| `/ws/jam` | Sessões de jam — colaboração multiusuário com gravação. |

## Servidor MCP

O vocal-synth-engine inclui um servidor MCP (Model Context Protocol) para que agentes Claude e outros clientes MCP possam chamar o motor diretamente — não é necessário nenhum scaffolding HTTP. Inicie via a entrada de binário `vocal-synth-engine-mcp` (transporte stdio).

Ferramentas expostas:

| Ferramenta | Propósito |
|------|---------|
| `render_score` | Renderiza uma VocalScore através de uma predefinição → WAV em base64 + telemetria. |
| `phonemize_text` | Texto de letras → Eventos fonêmicos ARPAbet (alinhados com notas, se `notas` forem fornecidos). |
| `list_presets` | Enumera os IDs de predefinição disponíveis (mesmo formato de GET /api/presets). |
| `validate_score` | Analisa e valida JSON VocalScore sem renderizar. |
| `inspect_preset` | Manifesto da predefinição + harmônicos/energia por timbre (mesmo que `vse-inspect --json`). |

Integre-o em uma configuração do Claude Desktop / Code:

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

## Predefinições de Voz

15 predefinições incluídas com suporte multi-timbre:

| Predefinição | Voz | Timbre |
|--------|-------|---------|
| `default-voice` | Feminina padrão | Timbre padrão |
| `bright-lab` | Laboratório/experimental | Formante brilhante |
| `kokoro-af-*` | Aoede, Heart, Jessica, Sky | Múltiplos por voz |
| `kokoro-am-*` | Eric, Fenrir, Liam, Onyx | Múltiplos por voz |
| `kokoro-bf-*` | Alice, Emma, Isabella | Múltiplos por voz |
| `kokoro-bm-*` | George, Lewis | Múltiplos por voz |

Cada predefinição inclui ativos binários `.f32` (magnitudes harmônicas, envelope espectral, nível de ruído) e um manifesto JSON descrevendo a faixa de afinação, ressonância e vibrato padrão.

## Scripts

```bash
npm run dev          # Dev server with hot reload
npm run build        # Build cockpit + server
npm start            # Production server
npm run inspect      # CLI preset inspector
```

## Testes

A principal superfície de teste é vitest:

```bash
npm test                # Run all unit + integration tests once
npm run test:watch      # Watch mode
npm run test:coverage   # Coverage report
```

Scripts de regressão adicionais em `scripts/` (requerem um servidor de desenvolvimento em execução para os testes de jam; os outros são autônomos):

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

Esses arquivos serão migrados para o diretório `tests/integration/` dentro do vitest em uma versão futura, o que permite que eles sejam automaticamente cobertos pelos testes executados com `npm test`.

## Segurança e Escopo de Dados

| Aspecto | Detalhe |
|--------|--------|
| **Data touched** | Síntese de áudio (em memória), conexões WebSocket (localhost), saída de arquivos WAV, dados da partitura, predefinições de voz. |
| **Data NOT touched** | Sem telemetria, sem análise, sem sincronização na nuvem, sem credenciais armazenadas. |
| **Permissions** | Rede: Servidor WebSocket no localhost. Disco: Saída de arquivos WAV para caminhos especificados pelo usuário. |
| **Network** | Apenas servidor WebSocket no localhost — sem conexões de saída. |
| **Telemetry** | Nenhum dado coletado ou enviado. |

Consulte o arquivo [SECURITY.md](SECURITY.md) para relatar vulnerabilidades.

## Avaliação

| Categoria | Pontuação |
|----------|-------|
| A. Segurança | 10 |
| B. Tratamento de Erros | 10 |
| C. Documentação para Operadores | 10 |
| D. Boas Práticas de Desenvolvimento | 10 |
| E. Identidade (suave) | 10 |
| **Overall** | **50/50** |

> Auditoria completa: [SHIP_GATE.md](SHIP_GATE.md) · [SCORECARD.md](SCORECARD.md)

## Licença

MIT. Consulte o arquivo [LICENSE](LICENSE).
