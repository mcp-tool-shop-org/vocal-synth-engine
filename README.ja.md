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
  <img src="assets/logo.png" alt="Vocal Synth Engine" width="400" />
</p>

<p align="center">
  <a href="https://github.com/mcp-tool-shop-org/vocal-synth-engine/actions/workflows/ci.yml"><img src="https://github.com/mcp-tool-shop-org/vocal-synth-engine/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT">
  <a href="https://mcp-tool-shop-org.github.io/vocal-synth-engine/"><img src="https://img.shields.io/badge/Landing_Page-live-blue" alt="Landing Page"></a>
</p>

<p align="center"><strong>Deterministic vocal instrument engine — additive synthesis, voice presets, real-time WebSocket streaming, multi-user jam sessions, cockpit UI</strong></p>

TypeScriptで構築された、決定論的な音声合成エンジンです。スコアデータから、加算合成、音声プリセット、およびリアルタイムのWebSocketストリーミングを使用して、歌声を生成します。キーボード/MIDI経由でリアルタイムに演奏したり、複数ユーザーでの共同セッションに参加したり、スコアをWAV形式でレンダリングしたりできます。

## 機能

- **加算音声合成**：倍音成分 + スペクトルエンベロープ + ノイズ残響
- **15種類の音声プリセット**：Kokoro TTSの音声分析データと、ラボで作成されたプリセットを組み合わせたもので、それぞれに複数の音色バリエーションがあります。
- **ポリフォニックレンダリング**：最大同時発音数を設定可能。各音声の状態管理と、音声の割り当てを行います。
- **ライブモード**：キーボードまたはMIDI経由で音を演奏し、リアルタイムのWebSocketオーディオストリーミングで出力します。
- **共同セッション**：ホスト権限を持つ、複数ユーザーでの共同セッション。参加者の識別と、録音機能があります。
- **スコア入力**：`VocalScore`ファイルをトラックに読み込み、トランスポートと同期した自動再生を行います。
- **録音とエクスポート**：ライブパフォーマンスをEventTapeにキャプチャし、完全な情報とともにWAV形式でエクスポートします。
- **歌詞と音素**：文字から音素への変換パイプラインと、音素の可視化機能。
- **コックピットUI**：ピアノロールエディター、ライブキーボード、XYパッド、レンダリングバンク、およびテレメトリ機能を備えた、ブラウザベースのSPA。
- **決定論的**：シード値に基づいた乱数生成により、同じ入力からは常に同じ出力が得られます。

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

**主要ディレクトリ:**

| ディレクトリ | 目的 |
| ----------- | --------- |
| `src/engine/` | コア合成エンジン：ブロックレンダラー、ストリーミングエンジン、ADSR/ビブラートカーブ |
| `src/dsp/` | 信号処理：FFT、ピッチ検出 |
| `src/preset/` | 音声プリセットのスキーマ、ローダー、および解決機能 |
| `src/server/` | Express + WebSocket APIサーバー、共同セッションマネージャー |
| `src/types/` | 共有型データ：スコア、共同セッションプロトコル、プリセット |
| `src/cli/` | CLIツール + 統合テストスイート |
| `apps/cockpit/` | ブラウザコックピットUI (Vite + vanilla TS) |
| `presets/` | 15種類のバンドルされた音声プリセット（バイナリ音色データを含む） |

## クイックスタート

```bash
npm ci
npm run dev
```

開発サーバーは`http://localhost:4321`で起動します。コックピットUIも同じポートで提供されます。

## コックピットUI

コックピットは、ピアノロールエディター、ライブキーボード、XYパッド、レンダリングバンク、およびテレメトリ機能を備えた、ブラウザベースのSPAです。3つのタブがあります。

### スコアエディター
- ドラッグ＆ドロップでノートを作成、移動、サイズ変更できるピアノロール
- 各ノートごとに、ベロシティ、音色、息の強さ、ビブラート、ポルタメントを調整可能
- 自動音素生成機能付きの歌詞入力
- ピアノロールと同期した音素表示
- 設定可能なプリセット、ポリフォニー、シード値、およびBPMでWAV形式にレンダリング

### ライブモード
- 24鍵のクロマティックキーボード（マウスとキーバインド）
- チャンネルフィルタリング機能付きのMIDIデバイス入力
- リアルタイムの音色変化（X軸）と息の強さ（Y軸）を調整できるXYパッド
- ホールドペダル、ベロシティ/息の強さスライダー、ビブラートコントロール
- 量子化グリッド（1/4、1/8、1/16）付きのメトロノーム
- レイテンシ補正（低、バランス、安全のプリセット）
- ライブパフォーマンスの録音とレンダリングバンクへの保存
- ライブテレメトリ：音声数、ピークdBFS、RTF、クリックリスク、WebSocketのジッター

### レンダリングバンク
- 保存されたレンダリングを閲覧、再生、ピン留め、名前変更、削除
- レンダーのスコアをエディターに読み込み
- レンダー間のテレメトリの比較
- プロヴェナンスの追跡：コミットSHA、スコアハッシュ、WAVハッシュ

## 共同セッション

WebSocket経由での複数ユーザー共同セッション（`/ws/jam`）：

- **ホスト権限**：セッションの作成者が、再生、トラック、録音、および量子化を制御します。
- **ゲスト参加**：ゲストは任意のトラックの音を再生できますが、セッションの状態を変更することはできません。
- **トラックの所有権**：トラックは作成者に帰属し、所有者またはホストのみが変更または削除できます。
- **参加者属性**：EventTapeに記録されるすべての音符イベントには、誰が演奏したかが記録されます。
- **楽譜入力モード**：`VocalScore`をトラックに読み込み、再生速度と同期して自動的に再生します。
- **録音**：すべての参加者の音符をEventTapeに記録し、WAV形式でエクスポートします。
- **メトロノーム**：設定可能なBPMと拍子を持つ共有メトロノームです。

### Jam Protocol

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

| エンドポイント | メソッド | Auth | 説明 |
| ---------- | -------- | ------ | ------------- |
| `/api/health` | GET | No | サーバーの状態、バージョン、稼働時間 |
| `/api/presets` | GET | No | 音色のプリセットを、音質とメタデータとともに一覧表示します。 |
| `/api/phonemize` | POST | Yes | 歌詞のテキストを、音素イベントに変換します。 |
| `/api/render` | POST | Yes | 楽譜をWAV形式に変換します。 |
| `/api/renders` | GET | Yes | 保存されたすべての変換結果を一覧表示します。 |
| `/api/renders/:id/audio.wav` | GET | Yes | 変換結果のWAVファイルをダウンロードします。 |
| `/api/renders/:id/score` | GET | Yes | 元の楽譜のJSONデータ |
| `/api/renders/:id/meta` | GET | Yes | 変換に関するメタデータ |
| `/api/renders/:id/telemetry` | GET | Yes | 変換に関するテレメトリデータ（ピーク値、RTF、クリック数） |
| `/api/renders/:id/provenance` | GET | Yes | 生成元情報（コミット、ハッシュ値、設定） |

認証はオプションです。環境変数`AUTH_TOKEN`が設定されている場合に有効になります。

### WebSocket

| Path | 目的 |
| ------ | --------- |
| `/ws` | ライブモード：単一ユーザーによる音符の再生とオーディオストリーミング |
| `/ws/jam` | Jamセッション：複数ユーザーによる共同作業と録音 |

## 音色プリセット

マルチ音色に対応した15種類のプリセットが同梱されています。

| プリセット | Voice | 音色 |
| -------- | ------- | --------- |
| `default-voice` | 女性の基本音 | デフォルトの音色 |
| `bright-lab` | 実験用/研究用 | 明るい倍音 |
| `kokoro-af-*` | Aoede, Heart, Jessica, Sky | 1つの音色につき複数 |
| `kokoro-am-*` | Eric, Fenrir, Liam, Onyx | 1つの音色につき複数 |
| `kokoro-bf-*` | Alice, Emma, Isabella | 1つの音色につき複数 |
| `kokoro-bm-*` | George, Lewis | 1つの音色につき複数 |

各プリセットには、バイナリ形式の`.f32`ファイル（倍音の大きさ、スペクトルエンベロープ、ノイズフロア）と、音域、共鳴、ビブラートのデフォルト値を記述したJSONマニフェストが含まれています。

## スクリプト

```bash
npm run dev          # Dev server with hot reload
npm run build        # Build cockpit + server
npm start            # Production server
npm run inspect      # CLI preset inspector
```

## テスト

統合テストは、ライブの開発サーバーに対して実行されます。

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

## ライセンス

MITライセンス。 [LICENSE](LICENSE) を参照してください。
