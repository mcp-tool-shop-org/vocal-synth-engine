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
  
            <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/vocal-synth-engine/readme.png"
           alt="Vocal Synth Engine" width="400" />
</p>

<p align="center">
  <a href="https://github.com/mcp-tool-shop-org/vocal-synth-engine/actions/workflows/ci.yml"><img src="https://github.com/mcp-tool-shop-org/vocal-synth-engine/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT">
  <a href="https://mcp-tool-shop-org.github.io/vocal-synth-engine/"><img src="https://img.shields.io/badge/Landing_Page-live-blue" alt="Landing Page"></a>
</p>

<p align="center"><strong>Deterministic vocal instrument engine — additive synthesis, voice presets, real-time WebSocket streaming, multi-user jam sessions, cockpit UI</strong></p>

一个用 TypeScript 构建的确定性人声合成引擎。它使用加法合成、人声预设和实时 WebSocket 传输，从乐谱数据生成人声。可以通过键盘/MIDI 实时演奏，参与多人协作的即兴演奏，或者将乐谱渲染为 WAV 文件。

## 功能

- **人声加法合成**：谐波分量 + 频谱包络 + 噪声残余
- **15 种人声预设**：来自 Kokoro TTS 语音的分析数据 + 实验室预设，每种预设包含多种音色
- **复音渲染**：可配置的最大复音数，具有每个音符的状态管理和音符抢占功能
- **实时模式**：通过键盘或 MIDI 实时演奏，并进行实时 WebSocket 音频传输
- **即兴演奏**：多人协作的会话，具有主持人权限、参与者身份识别和录音功能
- **乐谱输入**：将 `VocalScore` 导入音轨，实现与节拍同步的自动播放
- **录制与导出**：将实时演奏录制为事件记录，并导出为带有完整溯源信息的 WAV 文件
- **歌词和音素**：音素转换流水线，并提供音素通道的可视化
- **控制面板 UI**：基于浏览器的单页面应用，包含钢琴卷帘编辑器、实时键盘、XY 触摸板、渲染库和遥测数据
- **确定性**：使用种子随机数生成器，相同输入产生可重复的输出

## 架构

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

**主要目录：**

| 目录 | 用途 |
| ----------- | --------- |
| `src/engine/` | 核心合成器：块渲染器、流媒体引擎、ADSR/颤音曲线 |
| `src/dsp/` | 信号处理：FFT、音高检测 |
| `src/preset/` | 人声预设：模式、加载器和解析器 |
| `src/server/` | Express + WebSocket API 服务器，即兴演奏会话管理器 |
| `src/types/` | 共享类型：乐谱、即兴演奏协议、预设 |
| `src/cli/` | 命令行工具 + 集成测试套件 |
| `apps/cockpit/` | 浏览器控制面板 UI (Vite + 原生 TypeScript) |
| `presets/` | 15 种预编译的人声预设，包含二进制音色数据 |

## 快速开始

```bash
npm ci
npm run dev
```

开发服务器启动在 `http://localhost:4321`。控制面板 UI 从同一端口提供服务。

## 控制面板 UI

控制面板是一个基于浏览器的单页面应用，包含三个标签：

### 乐谱编辑器
- 钢琴卷帘，支持拖动创建、移动和调整音符大小（C2-C6 范围）
- 每个音符的控制：力度、音色、呼吸感、颤音
- 歌词输入，自动生成音素
- 音素通道叠加，与钢琴卷帘同步
- 渲染为 WAV 文件，可配置预设、复音数、种子和 BPM

### 实时模式
- 24 键音阶键盘（鼠标 + 快捷键）
- MIDI 设备输入，支持通道过滤
- XY 触摸板，用于实时调整音色（X 轴）和呼吸感（Y 轴）
- 延音踏板、力度/呼吸感滑块、颤音控制
- 节拍器，带有量化网格（1/4、1/8、1/16）
- 延迟校准（低/平衡/安全 预设）
- 录制演奏并保存到渲染库
- 实时遥测数据：人声数量、峰值 dBFS、RTF、爆音风险、WebSocket 抖动

### 渲染库
- 浏览、播放、固定、重命名和删除已保存的渲染文件
- 将渲染文件的乐谱加载回编辑器
- 渲染文件之间的侧边对齐遥测数据比较
- 溯源信息跟踪：提交 SHA、乐谱哈希、WAV 哈希

## 即兴演奏会话

通过 WebSocket 进行的多用户协作会话 (`/ws/jam`)：

- **主控方权限** — 会话创建者控制传输、跟踪、录制和量化。
- **参与者权限** — 参与者可以在任何音轨上演奏音符，但不能修改会话状态。
- **音轨所有权** — 音轨归属于其创建者；只有所有者或主控方可以修改/删除。
- **参与者归属** — EventTape 中记录的每个音符事件都记录了是谁演奏的。
- **乐谱输入模式** — 将 `VocalScore` 导入到音轨中，实现与传输同步的自动播放。
- **录制** — 捕获所有参与者的音符到 EventTape 中，并导出为 WAV 格式。
- **节拍器** — 共享节拍器，可配置 BPM（每分钟节拍数）和拍号。

### Jam Protocol

客户端连接到 `/ws/jam`，并交换 JSON 消息。

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

| 端点 | 方法 | Auth | 描述 |
| ---------- | -------- | ------ | ------------- |
| `/api/health` | GET | No | 服务器状态、版本、运行时间 |
| `/api/presets` | GET | No | 列出带有音色和元数据的语音预设。 |
| `/api/phonemize` | POST | Yes | 将歌词文本转换为音素事件。 |
| `/api/render` | POST | Yes | 将乐谱渲染为 WAV 文件。 |
| `/api/renders` | GET | Yes | 列出所有已保存的渲染文件。 |
| `/api/renders/:id/audio.wav` | GET | Yes | 下载渲染后的 WAV 文件。 |
| `/api/renders/:id/score` | GET | Yes | 原始乐谱 JSON 数据。 |
| `/api/renders/:id/meta` | GET | Yes | 渲染元数据。 |
| `/api/renders/:id/telemetry` | GET | Yes | 渲染遥测数据（峰值、RTF、点击次数）。 |
| `/api/renders/:id/provenance` | GET | Yes | 来源信息（提交记录、哈希值、配置）。 |

身份验证是可选的，当 `AUTH_TOKEN` 在环境中设置时启用。

### WebSocket

| Path | 用途 |
| ------ | --------- |
| `/ws` | 实时模式 — 单用户音符播放，带音频流。 |
| `/ws/jam` | Jam 会话 — 多用户协作，带录制功能。 |

## 语音预设

包含 15 个预设，支持多音色：

| 预设 | Voice | 音色 |
| -------- | ------- | --------- |
| `default-voice` | 女性基础音 | 默认音色 |
| `bright-lab` | 实验室/实验 | 明亮共振 |
| `kokoro-af-*` | Aoede, Heart, Jessica, Sky | 每个语音包含多个音色 |
| `kokoro-am-*` | Eric, Fenrir, Liam, Onyx | 每个语音包含多个音色 |
| `kokoro-bf-*` | Alice, Emma, Isabella | 每个语音包含多个音色 |
| `kokoro-bm-*` | George, Lewis | 每个语音包含多个音色 |

每个预设包含二进制 `.f32` 资源（谐波幅度、频谱包络、噪声底线），以及一个 JSON 清单，描述音高范围、共振和颤音的默认值。

## 脚本

```bash
npm run dev          # Dev server with hot reload
npm run build        # Build cockpit + server
npm start            # Production server
npm run inspect      # CLI preset inspector
```

## 测试

集成测试运行在实时开发服务器上：

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

## 许可证

MIT。 参见 [LICENSE](LICENSE)。
