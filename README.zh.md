<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.md">English</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

<p align="center"><strong>确定性人声乐器引擎——基于加法合成，包含预设人声，支持实时WebSocket流媒体，支持多人协作，提供控制面板UI。</strong></p>

这是一个使用TypeScript构建的确定性人声乐器引擎。它使用加法合成、预设人声和实时WebSocket流媒体，从乐谱数据生成人声。可以通过键盘/MIDI进行实时演奏，参与多人协作，或者将乐谱渲染为WAV文件。

**状态：** v1.0.3 源代码——尚未发布到npm。在v1.0.4发布之前，请从源代码安装（参见[安装](#install)）。

## 功能

- **基于加法的语音合成**——谐波分量 + 频谱包络 + 噪声残余
- **15个预设人声**——来自Kokoro TTS语音的分析数据快照 + 实验室预设，每个预设包含多种音色
- **多音渲染**——可配置的最大多音数，并具有每个音符的状态管理和音符切换功能
- **实时模式**——通过键盘或MIDI播放音符，并进行实时WebSocket音频流媒体
- **协作会话**——支持多人协作，具有主持人权限、参与者身份识别和录音功能
- **乐谱输入**——将`VocalScore`加载到音轨中，实现与节拍同步的自动播放
- **录制和导出**——捕获实时表演并保存为EventTape，导出为WAV文件，并保留完整的元数据
- **歌词和音素**——基于音素的语音转换流水线，并提供音素通道的可视化
- **控制面板UI**——基于浏览器的SPA，包含钢琴卷帘编辑器、实时键盘、XY面板、渲染库和遥测信息
- **确定性**——使用种子随机数生成器，相同输入产生可重复的输出

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
|-----------|---------|
| `src/engine/` | 核心合成器——块渲染器、流媒体引擎、ADSR/颤音曲线 |
| `src/dsp/` | 信号处理——FFT、音高检测 |
| `src/preset/` | 人声预设的模式、加载器和解析器 |
| `src/server/` | Express + WebSocket API服务器、协作会话管理器 |
| `src/types/` | 共享类型——乐谱、协作协议、预设 |
| `src/cli/` | 用户界面命令行工具（analyze, build-preset, compare, inspect, play-score, resynth, gen-vowel-wav, realtime-demo） |
| `scripts/` | 构建/测试回归脚本（未包含在发布包中，不属于`npm test`） |
| `apps/cockpit/` | 浏览器控制面板UI（Vite + 原生TypeScript） |
| `presets/` | 15个打包的人声预设，包含二进制音色数据 |

## 安装

该包`@mcptoolshop/vocal-synth-engine`尚未发布到npm。在v1.0.4发布之前，请从源代码安装：

```bash
git clone https://github.com/mcp-tool-shop-org/vocal-synth-engine.git
cd vocal-synth-engine
npm ci
npm run build
```

为了在下游项目中固定特定的提交：

```bash
npm install github:mcp-tool-shop-org/vocal-synth-engine#<commit-sha>
```

## 快速开始

```bash
npm ci
npm run dev
```

开发服务器启动在`http://localhost:4321`。控制面板UI从相同的端口提供服务。

## 控制面板UI

控制面板是一个基于浏览器的SPA，包含三个选项卡：

### 乐谱编辑器
- 钢琴卷帘，支持拖动创建、移动和调整音符大小（C2-C6范围）
- 每个音符的控制：力度、音色、呼吸感、颤音、滑音
- 歌词输入，自动生成音素
- 音素通道叠加，与钢琴卷帘同步
- 渲染为WAV文件，可配置预设、多音数、种子和BPM

### 实时模式
- 24键色阶键盘（鼠标 + 快捷键）
- MIDI设备输入，支持通道过滤
- XY面板，用于实时调整音色（X轴）和呼吸感（Y轴）
- 延音踏板、力度/呼吸感滑块、颤音控制
- 节拍器，带有量化网格（1/4、1/8、1/16）
- 延迟校准（低延迟/平衡/安全预设）
- 录制表演并保存到渲染库
- 实时遥测：音色数量、峰值dBFS、RTF、失真风险、WebSocket抖动

### 渲染库
- 浏览、播放、固定、重命名和删除已保存的渲染结果。
- 将渲染结果的分数加载回编辑器。
- 渲染结果之间的并排遥测数据比较。
- 溯源信息：提交 SHA、分数哈希值、WAV 哈希值。

## 即兴演奏会

通过 WebSocket 进行的多用户协作会话（`/ws/jam`）：

- **主持人权限**：会话创建者控制传输、音轨、录制和量化。
- **访客参与**：访客可以在任何音轨上演奏音符，但不能修改会话状态。
- **音轨所有权**：音轨属于其创建者；只有所有者或主持人可以修改/删除。
- **参与者归属**：EventTape 中的每个音符事件都记录了是谁演奏的。
- **乐谱输入模式**：将 `VocalScore` 加载到音轨上，以实现与传输同步的自动播放。
- **录制**：捕获所有参与者的音符到 EventTape 中，并导出为 WAV 文件。
- **节拍器**：共享节拍器，可配置 BPM 和拍号。

### 即兴演奏协议

客户端连接到 `/ws/jam` 并交换 JSON 消息：

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

| 端点 | 方法 | 身份验证 | 描述 |
|----------|--------|------|-------------|
| `/api/health` | GET | No | 服务器状态、版本、运行时间 |
| `/api/presets` | GET | No | 列出带有音色和元数据的语音预设 |
| `/api/phonemize` | POST | 是 | 将歌词文本转换为音素事件 |
| `/api/render` | POST | 是 | 将乐谱渲染为 WAV 文件 |
| `/api/renders` | GET | 是 | 列出所有已保存的渲染结果 |
| `/api/renders/:id/audio.wav` | GET | 是 | 下载渲染结果的 WAV 文件 |
| `/api/renders/:id/score` | GET | 是 | 原始乐谱 JSON |
| `/api/renders/:id/meta` | GET | 是 | 渲染元数据 |
| `/api/renders/:id/telemetry` | GET | 是 | 渲染遥测数据（峰值、RTF、点击次数） |
| `/api/renders/:id/provenance` | GET | 是 | 溯源信息（提交、哈希值、配置） |

身份验证是可选的，当 `AUTH_TOKEN` 在环境变量中设置时启用。 令牌可以通过 `Authorization: Bearer <token>` 头部或 `?token=<token>` 查询参数提供。

### WebSocket

| 路径 | 用途 |
|------|---------|
| `/ws` | 实时模式：单用户音符播放，带音频流。 |
| `/ws/jam` | 即兴演奏会：多用户协作，带录制功能。 |

## MCP 服务器

`vocal-synth-engine` 包含一个 MCP（模型上下文协议）服务器，以便 Claude 代理和其他 MCP 客户端可以直接调用引擎，无需 HTTP 封装。 通过 `vocal-synth-engine-mcp` 二进制文件启动（使用标准输入/输出传输）。

提供的工具：

| 工具 | 用途 |
|------|---------|
| `render_score` | 通过预设渲染 VocalScore → base64 编码的 WAV 文件 + 遥测数据。 |
| `phonemize_text` | 歌词文本 → ARPAbet 音素事件（如果提供了 `notes`，则与音符对齐）。 |
| `list_presets` | 枚举可用的预设 ID（与 GET /api/presets 相同）。 |
| `validate_score` | 解析和验证 VocalScore JSON，但不进行渲染。 |
| `inspect_preset` | 预设清单 + 每个音色的谐波/能量（与 `vse-inspect --json` 相同）。 |

将其集成到 Claude Desktop / Code 配置中：

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

## 语音预设

包含 15 个支持多音色的预设：

| 预设 | 语音 | 音色 |
|--------|-------|---------|
| `default-voice` | 默认女性音色 | 默认音色 |
| `bright-lab` | 实验室/实验 | 明亮共振 |
| `kokoro-af-*` | Aoede, Heart, Jessica, Sky | 每个语音包含多个 |
| `kokoro-am-*` | Eric, Fenrir, Liam, Onyx | 每个语音包含多个 |
| `kokoro-bf-*` | Alice, Emma, Isabella | 每个语音包含多个 |
| `kokoro-bm-*` | George, Lewis | 每个语音包含多个 |

每个预设都包含二进制 `.f32` 文件（谐波幅度、频谱包络、噪声底线）以及描述音高范围、共振和颤音默认值的 JSON 清单。

## 脚本

```bash
npm run dev          # Dev server with hot reload
npm run build        # Build cockpit + server
npm start            # Production server
npm run inspect      # CLI preset inspector
```

## 测试

主要的测试框架是 vitest：

```bash
npm test                # Run all unit + integration tests once
npm run test:watch      # Watch mode
npm run test:coverage   # Coverage report
```

`scripts/` 目录下有额外的回归脚本（需要运行开发服务器才能进行即兴演奏测试；其他脚本是独立的）：

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

这些文件计划在未来的某个版本迁移到 `tests/integration/` 目录下，并使用 vitest，这样它们可以自动获得 `npm test` 的测试覆盖率。

## 安全与数据范围

| 方面 | 详细信息 |
|--------|--------|
| **Data touched** | 音频合成（内存中），WebSocket 连接（本地），WAV 文件输出，乐谱数据，语音预设。 |
| **Data NOT touched** | 无遥测数据，无分析功能，无云同步，不存储任何凭证。 |
| **Permissions** | 网络：本地 WebSocket 服务器。磁盘：将 WAV 文件输出到用户指定的路径。 |
| **Network** | 仅限本地 WebSocket 服务器，不进行任何外部连接。 |
| **Telemetry** | 不收集或发送任何数据。 |

有关漏洞报告，请参阅 [SECURITY.md](SECURITY.md)。

## 评分卡

| 类别 | 评分 |
|----------|-------|
| A. 安全性 | 10 |
| B. 错误处理 | 10 |
| C. 操作文档 | 10 |
| D. 发布质量 | 10 |
| E. 身份验证（软性） | 10 |
| **Overall** | **50/50** |

> 完整审计：[SHIP_GATE.md](SHIP_GATE.md) · [SCORECARD.md](SCORECARD.md)

## 许可证

MIT 协议。请参阅 [LICENSE](LICENSE)。
