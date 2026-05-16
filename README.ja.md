<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

<p align="center"><strong>Deterministic vocal instrument engine — 加法合成、ボイスプリセット、リアルタイムWebSocketストリーミング、マルチユーザーでの共同セッション、操作画面</strong></p>

TypeScriptで構築された、決定論的なボーカルインストゥルメントエンジンです。加法合成、ボイスプリセット、リアルタイムWebSocketストリーミングを使用して、楽譜データから歌声を生成します。キーボード/MIDIでリアルタイムに演奏したり、マルチユーザーでの共同セッションに参加したり、楽譜をWAV形式で出力したりできます。

**ステータス:** v1.0.3 (ソースコード)。まだnpmに公開されていません。v1.0.4が公開されるまで、ソースコードからインストールしてください（[インストール](#install)を参照）。

## 機能

- **加法ボーカル合成:** ハーモニック成分 + スペクトルエンベロープ + ノイズ残響
- **15種類のボイスプリセット:** Kokoro TTSの分析データ + 実験的なプリセット。それぞれに複数の音色があります。
- **ポリフォニック再生:** 設定可能な最大ポリフォニー。各ボイスの状態管理とボイスの切り替え機能があります。
- **ライブモード:** キーボードまたはMIDIでノートを演奏し、リアルタイムのWebSocketオーディオストリーミングで再生します。
- **共同セッション:** ホスト権限、参加者識別、録音機能を持つマルチユーザーの共同セッション。
- **楽譜入力:** `VocalScore`をトラックにロードし、自動的に再生します（再生速度と同期）。
- **録音とエクスポート:** ライブパフォーマンスをEventTapeにキャプチャし、完全な情報とともにWAV形式でエクスポートします。
- **歌詞と音素:** 音素化パイプラインと、音素の可視化機能。
- **操作画面:** ブラウザベースのSPAで、ピアノロールエディタ、ライブキーボード、XYパッド、レンダリングバンク、およびテレメトリー機能を提供します。
- **決定論的:** シード値を持つ乱数生成器を使用し、同じ入力からは常に同じ出力が得られます。

## アーキテクチャ

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

**主要なディレクトリ:**

| ディレクトリ | 目的 |
|-----------|---------|
| `src/engine/` | コアシンセ — ブロックレンダラー、ストリーミングエンジン、ADSR/ビブラートカーブ |
| `src/dsp/` | 信号処理 — FFT、ピッチ検出 |
| `src/preset/` | ボイスプリセットのスキーマ、ローダー、および解決関数 |
| `src/server/` | Express + WebSocket APIサーバー、共同セッションマネージャー |
| `src/types/` | 共有型データ — 楽譜、共同セッションプロトコル、プリセット |
| `src/cli/` | ユーザー向けのCLIツール (analyze, build-preset, compare, inspect, play-score, resynth, gen-vowel-wav, realtime-demo) |
| `scripts/` | ビルド/テストの回帰スクリプト (配布されず、`npm test`の一部ではありません) |
| `apps/cockpit/` | ブラウザベースの操作画面 (Vite + vanilla TS) |
| `presets/` | 15種類のバンドルされたボイスプリセット（バイナリ形式の音色データを含む） |

## インストール

パッケージ `@mcptoolshop/vocal-synth-engine` はまだnpmに公開されていません。v1.0.4が公開されるまで、ソースコードからインストールしてください。

```bash
git clone https://github.com/mcp-tool-shop-org/vocal-synth-engine.git
cd vocal-synth-engine
npm ci
npm run build
```

特定のコミットをプロジェクトに固定するには:

```bash
npm install github:mcp-tool-shop-org/vocal-synth-engine#<commit-sha>
```

## クイックスタート

```bash
npm ci
npm run dev
```

開発サーバーは `http://localhost:4321` で起動します。操作画面も同じポートで提供されます。

## 操作画面

操作画面は、3つのタブを持つブラウザベースのSPAです。

### 楽譜エディタ
- ドラッグ＆ドロップでノートを作成、移動、サイズ変更できるピアノロール
- 各ノートのコントロール: ベロシティ、音色、息の強さ、ビブラート、ポルタメント
- 自動音素生成機能付きの歌詞入力
- ピアノロールと同期した音素の可視化
- 設定可能なプリセット、ポリフォニー、シード値、BPMでWAV形式でレンダリング

### ライブモード
- 24鍵のクロマチックキーボード (マウス + キーバインド)
- チャンネルフィルタリング機能付きのMIDIデバイス入力
- リアルタイムの音色変化 (X軸) と息の強さ (Y軸) を調整できるXYパッド
- ホールドペダル、ベロシティ/息の強さのスライダー、ビブラートコントロール
- 量子化グリッド (1/4, 1/8, 1/16) 付きのメトロノーム
- レイテンシーの調整 (低、バランス、安全のプリセット)
- ライブパフォーマンスの録音とレンダリングバンクへの保存
- ライブテレメトリー: ボイス数、ピークdBFS、RTF、クリックのリスク、WebSocketのジッター

### レンダリングバンク
- 保存したレンダリング結果の閲覧、再生、ピン留め、名前変更、削除
- レンダリング結果のスコアをエディタに読み込み
- レンダリング結果間のテレメトリ比較（並べて表示）
- 起源の追跡：コミットのSHA、スコアのハッシュ値、WAVのハッシュ値

## ジャムセッション

WebSocket経由でのマルチユーザー共同セッション (`/ws/jam`):

- **ホスト権限**: セッション作成者がトランスポート、トラック、録音、量子化を制御
- **ゲスト参加**: ゲストは任意のトラックの音を再生できますが、セッションの状態を変更することはできません。
- **トラックの所有権**: 各トラックは作成者に属し、所有者またはホストのみが変更または削除できます。
- **参加者属性**: EventTape内のすべての音符イベントには、誰が演奏したかが記録されます。
- **スコア入力モード**: `VocalScore`をトラックに読み込み、トランスポートと同期した自動再生を行います。
- **録音**: すべての参加者の音符をEventTapeにキャプチャし、WAV形式でエクスポートします。
- **メトロノーム**: 設定可能なBPMと拍子を持つ共有メトロノーム。

### ジャムプロトコル

クライアントは`/ws/jam`に接続し、JSONメッセージを交換します。

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

| エンドポイント | メソッド | 認証 | 説明 |
|----------|--------|------|-------------|
| `/api/health` | GET | No | サーバーの状態、バージョン、稼働時間 |
| `/api/presets` | GET | No | 音色とメタデータを持つ音声プリセットの一覧 |
| `/api/phonemize` | POST | はい | 歌詞テキストをフォネムイベントに変換 |
| `/api/render` | POST | はい | スコアをWAV形式でレンダリング |
| `/api/renders` | GET | はい | 保存されたレンダリング結果の一覧 |
| `/api/renders/:id/audio.wav` | GET | はい | レンダリングされたWAVファイルをダウンロード |
| `/api/renders/:id/score` | GET | はい | 元のスコアのJSONデータ |
| `/api/renders/:id/meta` | GET | はい | レンダリングのメタデータ |
| `/api/renders/:id/telemetry` | GET | はい | レンダリングのテレメトリ（ピーク値、RTF、クリック数） |
| `/api/renders/:id/provenance` | GET | はい | 起源情報（コミット、ハッシュ値、設定） |

認証はオプションです。環境変数`AUTH_TOKEN`が設定されている場合に有効になります。トークンは、`Authorization: Bearer <トークン>`ヘッダーまたは`?token=<トークン>`クエリパラメータで指定できます。

### WebSocket

| パス | 目的 |
|------|---------|
| `/ws` | ライブモード：単一ユーザーによる音符の再生とオーディオストリーミング |
| `/ws/jam` | ジャムセッション：録音機能付きのマルチユーザー共同作業 |

## MCPサーバー

`vocal-synth-engine`には、Claudeエージェントやその他のMCPクライアントがエンジンを直接呼び出せるようにするためのMCP（Model Context Protocol）サーバーが付属しています。HTTPのオーバーヘッドは不要です。`vocal-synth-engine-mcp`というバイナリエントリーから起動します（標準入出力経由）。

利用可能なツール：

| ツール | 目的 |
|------|---------|
| `render_score` | 音声プリセットを使用してVocalScoreをレンダリング → base64エンコードされたWAVデータ + テレメトリ |
| `phonemize_text` | 歌詞テキスト → ARPAbetフォネムイベント（`notes`が指定されている場合は音符にアライン） |
| `list_presets` | 利用可能なプリセットIDの一覧（GET /api/presetsと同じ形式） |
| `validate_score` | VocalScoreのJSONデータをレンダリングせずに解析および検証 |
| `inspect_preset` | プリセットのマニフェスト + 各音色のハーモニック/エネルギー（`vse-inspect --json`と同じ） |

Claude Desktop / Codeの設定に組み込む：

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

## 音声プリセット

マルチ音色に対応した15種類のプリセットが同梱されています。

| プリセット | 音声 | 音色 |
|--------|-------|---------|
| `default-voice` | 基準となる女性の声 | デフォルトの音色 |
| `bright-lab` | 実験用 | 明るいフォルマント |
| `kokoro-af-*` | Aoede, Heart, Jessica, Sky | 各音声に複数 |
| `kokoro-am-*` | Eric, Fenrir, Liam, Onyx | 各音声に複数 |
| `kokoro-bf-*` | Alice, Emma, Isabella | 各音声に複数 |
| `kokoro-bm-*` | George, Lewis | 各音声に複数 |

各プリセットには、バイナリー形式の`.f32`ファイル（ハーモニックの振幅、スペクトルエンベロープ、ノイズフロア）と、ピッチレンジ、共鳴、ビブラートのデフォルト値を記述したJSONマニフェストが含まれています。

## スクリプト

```bash
npm run dev          # Dev server with hot reload
npm run build        # Build cockpit + server
npm start            # Production server
npm run inspect      # CLI preset inspector
```

## テスト

主要なテスト環境はvitestです。

```bash
npm test                # Run all unit + integration tests once
npm run test:watch      # Watch mode
npm run test:coverage   # Coverage report
```

`scripts/`ディレクトリにある追加の回帰テストスクリプト（ジャムテストには実行中の開発サーバーが必要です。他のテストはスタンドアロンで実行できます）。

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

これらのファイルは、将来的にvitestの`tests/integration/`ディレクトリに移行される予定であり、そのため`npm test`によるテストカバレッジが自動的に適用されます。

## セキュリティとデータ範囲

| 側面 | 詳細 |
|--------|--------|
| **Data touched** | 音声合成（メモリ内）、WebSocket接続（ローカルホスト）、WAVファイル出力、楽譜データ、音声プリセット |
| **Data NOT touched** | テレメトリー、分析機能、クラウド同期機能、認証情報は一切保存されません。 |
| **Permissions** | ネットワーク：ローカルホスト上のWebSocketサーバー。ディスク：ユーザーが指定したパスへのWAVファイル出力。 |
| **Network** | ローカルホストのWebSocketサーバーのみ。外部への接続はありません。 |
| **Telemetry** | 収集も送信も行いません。 |

脆弱性に関する報告は、[SECURITY.md](SECURITY.md) を参照してください。

## スコアカード

| カテゴリ | スコア |
|----------|-------|
| A. セキュリティ | 10 |
| B. エラー処理 | 10 |
| C. 運用ドキュメント | 10 |
| D. リリース時の品質管理 | 10 |
| E. 認証（ソフト） | 10 |
| **Overall** | **50/50** |

> 詳細な監査：[SHIP_GATE.md](SHIP_GATE.md) · [SCORECARD.md](SCORECARD.md)

## ライセンス

MITライセンス。 [LICENSE](LICENSE) を参照してください。
