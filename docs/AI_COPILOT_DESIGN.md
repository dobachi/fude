# AIコパイロット実装計画

## 概要

FudeエディタにObsidian Copilotライクなエディタ内AI支援機能を追加する。OpenRouter経由で任意のLLMモデルを使用。実装順序はComposer → Chat → Inline completionの3フェーズ。

## Phase 1: Composer（選択テキストのAI編集）

### UX

1. テキスト選択 → `Ctrl+Shift+I`
2. フローティングポップアップ: Rewrite / Summarize / Expand / Fix Grammar / Custom
3. ストリーミングでレスポンス表示
4. diff表示（before/after）→ Accept or Reject

### 新規ファイル

| ファイル | 責務 |
|---|---|
| `src/js/features/ai/openrouter-client.js` | OpenRouter APIクライアント（chat, stream, models） |
| `src/js/features/ai/composer.js` | ComposerのUI、ストリーミング、diff表示、適用/却下 |
| `src/js/features/ai/context.js` | コンテキスト組み立て（現在のファイル、選択テキスト） |

### 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `src/js/features/ai-copilot.js` | 動的importオーケストレーターに書き換え |
| `src/js/backend.js` | `aiChat`, `aiChatStream` 追加 |
| `scripts/serve.js` | `ai_chat`, `/api/ai_chat_stream`（SSE）追加 |
| `src-tauri/src/lib.rs` | `ai_chat`, `ai_chat_stream` Tauriコマンド追加（reqwest） |
| `src-tauri/Cargo.toml` | `reqwest` 依存追加 |
| `src/js/app.js` | `Ctrl+Shift+I` ショートカット追加 |
| `src/style.css` | Composerポップアップ、diff表示のCSS |

### API Flow

```
Frontend (composer.js)
  → backend.aiChatStream(messages, model, onChunk, onDone, onError)
    → Browser: fetch /api/ai_chat_stream (SSE)
    → Tauri: invoke ai_chat_stream + listen events
      → OpenRouter https://openrouter.ai/api/v1/chat/completions (stream: true)
```

### バックエンドAPI

```javascript
// backend.js
export async function aiChat(messages, model) { ... }
export async function aiChatStream(messages, model, onChunk, onDone, onError) { ... }
```

```javascript
// serve.js - SSE endpoint
// POST /api/ai_chat_stream
// Request: { messages, model }
// Response: text/event-stream
```

## Phase 2: Chat（サイドパネル）

### 新規ファイル

| ファイル | 責務 |
|---|---|
| `src/js/features/ai/chat.js` | チャットUI（メッセージリスト、入力、モデル選択） |
| `src/js/features/ai/model-picker.js` | OpenRouterモデル一覧・選択 |
| `src/js/features/ai/chat-history.js` | チャット履歴の.md保存/読み込み |

### 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `src/js/backend.js` | `aiModels`, `searchFiles` 追加 |
| `scripts/serve.js` | `ai_models`, `search_files` 追加 |
| `src-tauri/src/lib.rs` | `ai_models`, `search_files` Tauriコマンド追加 |
| `src/js/app.js` | `Ctrl+I` でAIパネルトグル |
| `src/style.css` | チャットメッセージ、入力バー、モデルピッカーCSS |

### チャットUI構造

```
#ai-panel-content
  ├── .ai-chat-model-bar     (モデル選択 + 新規チャット)
  ├── .ai-chat-messages       (スクロール可能メッセージリスト)
  │     ├── .ai-msg.user
  │     └── .ai-msg.assistant (markdownレンダリング)
  └── .ai-chat-input-bar      (textarea + 送信ボタン)
```

### コンテキスト

- デフォルト: 現在のファイル内容をsystemメッセージに含める
- `@filename`で他ファイルのコンテキスト追加（searchFiles API）
- チャット履歴: `{vault}/.fude-chat/YYYY-MM-DD-HHmm.md`

## Phase 3: Inline Completion（ゴーストテキスト）

### 新規ファイル

| ファイル | 責務 |
|---|---|
| `src/js/features/ai/inline-completion.js` | CodeMirror ViewPlugin + GhostTextWidget |

### 動作

- 入力停止800ms後にトリガー
- カーソル前の~500文字をコンテキストに補完リクエスト
- ゴーストテキスト（opacity: 0.4）で表示
- Tab: 採用、Escape: 却下
- AbortControllerで前のリクエストをキャンセル

## 設計上の決定

- **APIキー保護**: バックエンドプロキシ経由（フロントエンドからOpenRouterに直接呼ばない）
- **動的import**: `ai_copilot: false`なら一切JSを読み込まない
- **ストリーミング**: ブラウザ=SSE、Tauri=イベントエミッター
- **diff**: 外部ライブラリなし、シンプルな行レベルdiff

## 検証方法

1. `make browser` でComposerテスト: テキスト選択→Ctrl+Shift+I→アクション選択→diff表示→Accept
2. 設定でOpenRouter APIキーを入力、モデル選択
3. `make dev` でTauriネイティブでも同様にテスト
4. `npx vitest run` でユニットテスト確認
