# Fude (筆) - 設計ドキュメント

> 最終更新: 2026-03-15
> バージョン: 0.1.0

---

## 1. プロジェクト概要

- **製品名**: Fude (筆)
- **目的**: Windows / Mac / Linux / WSL で使える超軽量 Markdown エディタ
- **技術スタック**: Tauri v2 (Rust) + Vanilla JS + CodeMirror 6 + markdown-it + esbuild
- **識別子**: `com.devmarkdowneditor.app`
- **ターゲットバイナリサイズ**: ~3MB (Release profile: `strip=true`, `lto=true`, `opt-level="s"`)

### 設計思想

- **軽量・高速起動**: Electron ではなく Tauri を採用。フレームワーク (React/Vue) を使わず Vanilla JS で実装
- **機能トグル**: 重量級機能は動的 import で遅延読み込み。不要な機能の JS は一切ロードしない
- **Obsidian Vault 互換**: 特別な設定なしにディレクトリを開くだけで使える
- **クロスプラットフォーム**: Tauri のネイティブビルドに加え、WSL 環境用の HTTP フォールバックを設計済み

---

## 2. アーキテクチャ

### プロジェクト構造

```
projects/markdown-editor/
├── src-tauri/
│   ├── src/main.rs          # エントリポイント (windows_subsystem, run()呼び出し)
│   ├── src/lib.rs           # 全Tauriコマンド・データ構造・テスト
│   ├── Cargo.toml           # Rust依存関係 (tauri 2, serde, dirs)
│   └── tauri.conf.json      # Tauri設定 (ウィンドウ, CLI引数, バンドル)
├── src/
│   ├── index.html           # HTMLシェル (sidebar, workspace, ai-panel)
│   ├── style.css            # CSS Grid + CSS変数によるテーマシステム
│   └── js/
│       ├── app.js           # メインオーケストレーター (初期化, キーバインド, セッション)
│       ├── backend.js       # Tauri invoke抽象化レイヤー (HTTP fallback対応)
│       ├── settings.js      # 設定画面UI (オーバーレイモーダル)
│       ├── core/            # コア機能 (常にロード)
│       │   ├── editor.js    # CodeMirror 6 + Vim + Markdown入力支援
│       │   ├── preview.js   # markdown-it描画 + Vimライクナビゲーション
│       │   ├── tabs.js      # タブ管理 (開く/閉じる/切替/ダーティ表示)
│       │   ├── panes.js     # ペイン分割管理 (縦/横)
│       │   ├── sidebar.js   # ファイルツリー (.mdのみ表示, ディレクトリ折り畳み)
│       │   ├── session.js   # セッション保存/復元 (2秒デバウンス)
│       │   ├── theme.js     # ダーク/ライトテーマ切替
│       │   ├── autosave.js  # 暫定ファイル自動保存 (2秒デバウンス)
│       │   └── keymode.js   # vim/emacs/normal切替
│       ├── features/        # トグル可能機能 (動的import)
│       │   ├── ai-copilot.js
│       │   └── diff-highlight.js
│       └── __tests__/       # vitestテスト
│           ├── tabs.test.js
│           └── backend.test.js
├── dist/                    # esbuildビルド出力 (bundle.js, index.html, style.css)
├── package.json
├── vitest.config.js         # vitest + jsdom設定
└── docs/
    └── DESIGN.md            # このファイル
```

### アーキテクチャ概要図

```
┌──────────────────────────────────────────────────────────┐
│                    Tauri Window                          │
│  ┌─────────┐  ┌─────────────────────┐  ┌────────────┐   │
│  │ Sidebar  │  │     Workspace       │  │  AI Panel  │   │
│  │(file-tree│  │  ┌───────┬────────┐ │  │ (将来実装)  │   │
│  │  .md)    │  │  │Editor │Preview │ │  │            │   │
│  │         │  │  │(CM6)  │(md-it) │ │  │            │   │
│  │         │  │  │       │        │ │  │            │   │
│  └─────────┘  │  └───────┴────────┘ │  └────────────┘   │
│               │  [Tab Bar]           │                   │
│               └─────────────────────┘                   │
└──────────────────────────────────────────────────────────┘
         │                                      │
         │  Tauri invoke / HTTP fallback        │
         ▼                                      ▼
┌──────────────────────────────────────────────────────────┐
│                  Rust Backend (lib.rs)                    │
│  read_file, write_file, read_dir_tree                    │
│  load_session, save_session, get_config, save_config     │
│  write_temp_file, delete_temp_file, check_temp_files     │
└──────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────┐
│  File System                                             │
│  ~/.config/markdown-editor/  (session.json, config.json) │
│  Vault directory (.md files)                             │
│  .~filename.md.tmp (autosave temp files)                 │
└──────────────────────────────────────────────────────────┘
```

---

## 3. Rust バックエンド

### データ構造

```rust
// ファイルツリーのエントリ (再帰的)
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileEntry>>,
}

// セッション内のタブ情報
pub struct TabInfo {
    pub path: String,
    pub cursor_line: usize,
    pub cursor_col: usize,
    pub scroll_top: f64,
}

// ペイン情報
pub struct PaneInfo {
    pub tab_id: Option<String>,
    pub size_percent: f64,
}

// ペインレイアウト
pub struct PaneLayout {
    pub direction: String,   // "horizontal" | "vertical"
    pub panes: Vec<PaneInfo>,
}

// セッション (起動時復元用)
pub struct Session {
    pub open_tabs: Vec<TabInfo>,
    pub active_tab: usize,
    pub vault_path: Option<String>,
    pub view_mode: String,          // "editor" | "split" | "preview"
    pub sidebar_visible: bool,
    pub pane_layout: Option<PaneLayout>,
}

// 機能トグル
pub struct Features {
    pub ai_copilot: bool,
    pub diff_highlight: bool,
}

// アプリケーション設定
pub struct Config {
    pub theme: String,               // "dark" | "light"
    pub features: Features,
    pub font_size: u32,
    pub vim_mode: bool,
    pub openrouter_api_key: Option<String>,
}

// 暫定ファイル情報
pub struct TempFileInfo {
    pub original_path: String,
    pub temp_path: String,
    pub modified: String,            // UNIX epoch ミリ秒
}
```

### 設定/セッション保存場所

- **ディレクトリ**: `~/.config/markdown-editor/` (`dirs::config_dir()` を使用)
- **セッションファイル**: `~/.config/markdown-editor/session.json`
- **設定ファイル**: `~/.config/markdown-editor/config.json`
- ディレクトリが存在しない場合は `ensure_config_dir()` で自動作成

### Tauri コマンド一覧 (10個)

| # | コマンド | シグネチャ | 用途 | 動作 |
|---|---------|-----------|------|------|
| 1 | `read_file` | `(path: String) -> Result<String, String>` | ファイル読み込み | 指定パスのファイルを UTF-8 文字列として読み込む |
| 2 | `write_file` | `(path: String, content: String) -> Result<(), String>` | ファイル書き込み | 親ディレクトリが存在しなければ自動作成してから書き込む |
| 3 | `read_dir_tree` | `(path: String) -> Result<Vec<FileEntry>, String>` | ディレクトリツリー取得 | `.md` ファイルのみ再帰的に走査。隠しファイル (`.`始まり) をスキップ。空ディレクトリを除外。ディレクトリ優先でソート |
| 4 | `load_session` | `() -> Result<Option<Session>, String>` | セッション読み込み | `session.json` が存在すれば読み込み、なければ `None` を返す |
| 5 | `save_session` | `(session: Session) -> Result<(), String>` | セッション保存 | セッション情報を `session.json` に pretty-print JSON で保存 |
| 6 | `get_config` | `() -> Result<Config, String>` | 設定読み込み | `config.json` が存在すれば読み込み、なければデフォルト値を返す |
| 7 | `save_config` | `(config: Config) -> Result<(), String>` | 設定保存 | 設定を `config.json` に pretty-print JSON で保存 |
| 8 | `write_temp_file` | `(path: String, content: String) -> Result<(), String>` | 暫定ファイル書き込み | 元ファイルと同じディレクトリに `.~filename.md.tmp` 形式で保存 |
| 9 | `delete_temp_file` | `(path: String) -> Result<(), String>` | 暫定ファイル削除 | 対応する暫定ファイルが存在すれば削除。存在しなくてもエラーにならない |
| 10 | `check_temp_files` | `(paths: Vec<String>) -> Result<Vec<TempFileInfo>, String>` | 暫定ファイル確認 | 指定パスリストに対応する暫定ファイルの存在を確認。クラッシュ復旧用 |

### アプリ起動フロー

1. `main.rs`: `markdown_editor_lib::run()` を呼び出し
2. `lib.rs` の `run()`:
   - `tauri_plugin_dialog` と `tauri_plugin_cli` を登録
   - 10個のコマンドを `invoke_handler` に登録
   - `setup` で CLI 引数 (`path`) を解析し、500ms 後に `cli-args` イベントを emit
3. フロントエンドの `app.js` が `DOMContentLoaded` で `init()` を実行

### デフォルト値

- **Config**: `theme: "dark"`, `font_size: 14`, `vim_mode: false`, `ai_copilot: false`, `diff_highlight: true`
- **Session**: `open_tabs: []`, `active_tab: 0`, `vault_path: null`, `view_mode: "split"`, `sidebar_visible: true`, `pane_layout: null`

---

## 4. フロントエンドモジュール設計

### app.js - メインオーケストレーター

- **責務**: アプリ全体の初期化、グローバルキーバインド処理、モジュール間の連携、セッション保存スケジューリング
- **公開API**: なし (エントリポイント)
- **依存先**: backend.js, 全 core モジュール, settings.js
- **主要な状態**: `currentView` (EditorView), `viewMode`, `vaultPath`, `config`
- **初期化順序**:
  1. `backend.getConfig()` で設定読み込み
  2. `initTheme()` でテーマ適用
  3. `initPreview()` でプレビュー初期化
  4. `initPanes()` でペイン初期化
  5. `initSidebar()` でサイドバー初期化
  6. `setTabChangeCallback()` でタブ変更コールバック設定
  7. グローバルキーバインド登録 (`capture: true`)
  8. セッション復元 or ウェルカムタブ表示
  9. CLI引数イベントリスナー登録

### backend.js - Tauri invoke 抽象化レイヤー

- **責務**: Rust バックエンドとの通信を抽象化。Tauri 環境では `invoke()`、非 Tauri 環境では `fetch()` (HTTP fallback) を使用
- **公開API**:
  - `readFile(path)` / `writeFile(path, content)`
  - `writeTempFile(path, content)` / `deleteTempFile(path)` / `checkTempFiles(paths)`
  - `readDirTree(path)`
  - `saveSession(session)` / `loadSession()`
  - `getConfig()` / `saveConfig(config)`
- **依存先**: `@tauri-apps/api` (window.__TAURI__)
- **設計判断**: `window.__TAURI__` の存在で Tauri/HTTP を自動切替。WSL フォールバック時は `http://localhost:3030/api/` にリクエスト

### settings.js - 設定画面UI

- **責務**: モーダルオーバーレイとして設定画面を表示。テーマ、フォントサイズ、キーモード、機能トグル、API キーの変更
- **公開API**: `openSettings()`, `closeSettings()`
- **依存先**: backend.js, core/theme.js, core/editor.js, core/keymode.js
- **動作**: 開く→設定読み込み→UI生成→リアルタイムプレビュー (テーマ/フォント)→Save で config.json に永続化

### core/editor.js - CodeMirror 6 エディタ管理

- **責務**: CodeMirror 6 のインスタンス作成・破棄・状態管理。Vim モード切替、テーマ切替、Markdown 入力支援
- **公開API**:
  - `createEditor(container, content, onChange)` - エディタ作成 (前のインスタンスは destroy)
  - `setContent(view, content)` / `getContent(view)`
  - `setTheme(view, theme)` - Compartment で動的切替
  - `getCursor(view)` / `setCursor(view, from, to)`
  - `getScroll(view)` / `setScroll(view, scroll)`
  - `setFontSize(size)` / `getFontSize()`
  - `toggleVim(view, enable)` - Compartment で動的切替
  - `getCurrentView()`
- **依存先**: `@codemirror/*`, `@replit/codemirror-vim`
- **重要な設計判断**:
  - **EditorView は常に1つだけ**: タブ切替時に state (content, cursor, scroll) を保存→destroy→新しいインスタンスを再作成。メモリ効率を優先
  - **Compartment による動的切替**: `themeCompartment` (dark/light), `keymodeCompartment` (vim/normal) を使用し、再作成なしで拡張機能を差し替え
  - **Markdown 入力支援**: `autoListExtension()` で箇条書き自動継続 (`-`, `*`, `+`, `1.`)。空行で入力すると箇条書きを終了
  - **太字トグル**: `boldKeymap()` で `Ctrl+b` による `**` の挿入/解除。選択テキスト有無で挙動が変わる

### core/preview.js - Markdown プレビュー

- **責務**: markdown-it によるレンダリング、ローカル画像パス解決、Vim ライクキーボードナビゲーション
- **公開API**:
  - `initPreview(container)` - 初期化、カスタム画像レンダラー設定、キーボードイベント登録
  - `renderMarkdown(text, basePath)` - HTML 生成・表示
  - `setTheme(theme)` - CSS data-theme で処理 (関数内は空)
  - `setBasePath(path)`
- **依存先**: `markdown-it`
- **設計判断**:
  - 画像の相対パスを `asset://localhost/` プロトコルで解決 (Tauri のセキュリティモデル対応)
  - `gg` は `gPending` フラグ + 500ms タイムアウトで2回押し検出

### core/tabs.js - タブ管理

- **責務**: タブの開閉、切替、ダーティ状態管理、タブバー DOM 描画
- **公開API**:
  - `openTab(path, content)` - 新規タブ作成 (既存パスは切替)
  - `closeTab(id)` / `switchTab(id)` / `nextTab()` / `prevTab()`
  - `getActiveTab()` / `getAllTabs()`
  - `markDirty(id)` / `markClean(id)`
  - `updateTabContent(id, content)` / `updateTabCursor(id, cursor)` / `updateTabScroll(id, scroll)`
  - `setTabChangeCallback(callback)` - タブ変更時のコールバック設定
  - `getTabsForSession()` / `getActiveTabIndex()`
- **依存先**: なし (DOM のみ)
- **設計判断**:
  - タブオブジェクトに `content`, `cursor`, `scroll` を保持し、タブ切替時に EditorView の状態を保存・復元
  - 中クリック (button === 1) でタブを閉じる
  - ダーティ表示はドットアイコン、hover 時に閉じるボタンに変わる

### core/panes.js - ペイン分割管理

- **責務**: ワークスペースの縦/横分割、アクティブペインの管理・フォーカス移動
- **公開API**:
  - `initPanes()` - 初期化
  - `splitVertical()` / `splitHorizontal()` - ペイン追加
  - `closePane(id)` - ペイン削除 (最後の1つは削除不可)
  - `focusPane(direction)` - 矢印方向にフォーカス移動
  - `getActivePane()` / `getActivePaneEditorContainer()` / `getActivePanePreviewContainer()`
- **依存先**: なし (DOM のみ)
- **設計判断**: CSS flexbox で分割。アクティブペインは `outline` でハイライト

### core/sidebar.js - サイドバーファイルツリー

- **責務**: ディレクトリツリーの描画、ファイル選択イベント、アクティブファイルハイライト
- **公開API**:
  - `initSidebar(container, fileSelectCallback)` - 初期化
  - `loadDirectory(entries)` - ツリー描画
  - `toggleSidebar()` - 表示/非表示切替
  - `highlightFile(path)` - 選択ファイルのハイライト + 親ディレクトリ展開
- **依存先**: なし (DOM のみ)

### core/session.js - セッション保存/復元

- **責務**: セッションデータの保存 (2秒デバウンス) と復元
- **公開API**:
  - `scheduleSave(getSessionData)` - デバウンス付き保存スケジュール
  - `restoreSession()` - セッション読み込み
  - `saveSessionImmediate(session)` - 即時保存
- **依存先**: backend.js

### core/theme.js - テーマ管理

- **責務**: `data-theme` 属性と CodeMirror テーマの同期
- **公開API**:
  - `initTheme(savedTheme)` / `applyTheme(theme)` / `getCurrentTheme()` / `toggleTheme()`
- **依存先**: core/editor.js (`setTheme`, `getCurrentView`)

### core/autosave.js - 暫定ファイル自動保存

- **責務**: 編集内容の自動バックアップ (暫定ファイル) とクラッシュ復旧チェック
- **公開API**:
  - `onContentChange(path, content)` - 内容変更時に呼び出し (2秒デバウンスで暫定ファイル書き込み)
  - `triggerSave(path, content)` - 明示的保存 (本ファイル書き込み + 暫定ファイル削除)
  - `checkRecovery(paths)` - 暫定ファイルの存在確認
- **依存先**: backend.js
- **暫定ファイル命名規則**: `.~filename.md.tmp` (同一ディレクトリ、隠しファイル)

### core/keymode.js - キーボードモード管理

- **責務**: vim / emacs / normal モードの切替
- **公開API**:
  - `initKeymode(savedMode)` / `setMode(mode)` / `getMode()` / `reapplyMode()`
- **依存先**: core/editor.js (`toggleVim`, `getCurrentView`)
- **拡張ポイント**: `switch (mode)` に `case 'emacs':` のプレースホルダーあり

### features/ai-copilot.js - AI コパイロット (プレースホルダー)

- **責務**: OpenRouter 経由の AI 機能 (未実装)
- **公開API**: `initAICopilot(config)`, `enableCopilot()`, `disableCopilot()`
- **依存先**: なし (将来: backend.js)

### features/diff-highlight.js - 変更点強調表示 (プレースホルダー)

- **責務**: 変更箇所のガター表示 (未実装)
- **公開API**: `initDiffHighlight()`, `enableDiffHighlight()`, `disableDiffHighlight()`
- **依存先**: なし (将来: core/editor.js)

### モジュール依存関係図

```
app.js ─────┬──→ backend.js ──→ Tauri invoke / HTTP
            ├──→ settings.js ──→ backend.js, theme.js, editor.js, keymode.js
            ├──→ core/editor.js ──→ @codemirror/*, @replit/codemirror-vim
            ├──→ core/preview.js ──→ markdown-it
            ├──→ core/tabs.js (依存なし)
            ├──→ core/panes.js (依存なし)
            ├──→ core/sidebar.js (依存なし)
            ├──→ core/session.js ──→ backend.js
            ├──→ core/theme.js ──→ core/editor.js
            ├──→ core/autosave.js ──→ backend.js
            └──→ core/keymode.js ──→ core/editor.js

features/ai-copilot.js (動的import, 未実装)
features/diff-highlight.js (動的import, 未実装)
```

---

## 5. 機能一覧と実装状況

| 機能 | 状態 | 備考 |
|------|------|------|
| エディタ (CodeMirror 6) | 実装済み | Markdown 構文ハイライト、行番号、折り返し、bracketMatching |
| プレビュー (markdown-it) | 実装済み | 画像プレビュー対応 (asset://localhost/)、Vimナビ (j/k/d/u/gg/G) |
| ビューモード切替 | 実装済み | Ctrl+j (エディタのみ) / k (分割) / l (プレビューのみ) |
| Vim モード | 実装済み | @replit/codemirror-vim、Compartment で on/off 切替 |
| タブ | 実装済み | 開く/閉じる/切替/ダーティ表示/中クリックで閉じる |
| セッション復元 | 実装済み | JSON保存、起動時復元、2秒デバウンス |
| Undo/Redo | 実装済み | CodeMirror history() + historyKeymap |
| Markdown 入力支援 | 実装済み | 箇条書き自動継続 (-, *, +, 1.)、空行で終了 |
| 太字トグル | 実装済み | Ctrl+b、選択範囲の ** 挿入/解除 |
| サイドバーファイルツリー | 実装済み | .md ファイルのみ表示、ディレクトリ折り畳み、隠しファイルスキップ |
| ダーク/ライトテーマ | 実装済み | CSS 変数、設定画面で切替、VS Code 風配色 |
| ファイル内検索 | 実装済み | CodeMirror search (Ctrl+f) |
| 置換 | 実装済み | CodeMirror search (Ctrl+r) |
| ペイン分割 | 実装済み | Ctrl+\| 縦 / Ctrl+\\ 横 / Ctrl+矢印で移動 |
| 暫定ファイル自動保存 | 実装済み | 2秒デバウンス、.~filename.md.tmp、保存時に削除 |
| フォント拡大縮小 | 実装済み | Ctrl+-/+ (10px-32px) |
| 設定画面 | 実装済み | テーマ、フォント、キーモード、機能トグル、API キー |
| Obsidian Vault 対応 | 実装済み | ディレクトリを開くだけ (Ctrl+O) |
| CLI 引数対応 | 実装済み | `fude /path/to/dir` でディレクトリ or ファイルを開く |
| WSL フォールバック | 未実装 | backend.js に HTTP フォールバック準備済み (localhost:3030) |
| 変更点強調表示 | 未実装 | Phase1: 保存時点差分 → Phase2: git 連携 |
| AI コパイロット | 未実装 | OpenRouter 経由、チャット/Composer/インライン |
| Emacs キーバインド | 未実装 | keymode.js に拡張ポイント準備済み |

---

## 6. キーボードショートカット一覧

### グローバルショートカット (capture phase で登録)

全て `Ctrl` (Mac では `Cmd`) + キーの組み合わせ。`app.js` の `handleGlobalKeys` で処理。
CodeMirror のキーバインドより先にインターセプトするため、`capture: true` で登録。

| キー | 機能 | カテゴリ |
|------|------|---------|
| `Ctrl+j` | ビューモード: エディタのみ | ビュー |
| `Ctrl+k` | ビューモード: 分割 (エディタ + プレビュー) | ビュー |
| `Ctrl+l` | ビューモード: プレビューのみ | ビュー |
| `Ctrl+t` | 新規タブ | タブ |
| `Ctrl+Tab` | 次のタブ | タブ |
| `Ctrl+Shift+Tab` | 前のタブ | タブ |
| `Ctrl+w` | タブを閉じる | タブ |
| `Ctrl+b` | 太字トグル (**) | 編集 |
| `Ctrl+;` | サイドバー表示/非表示 | レイアウト |
| `Ctrl+s` | 保存 (暫定ファイル削除含む) | ファイル |
| `Ctrl+o` | フォルダを開く (ダイアログ) | ファイル |
| `Ctrl+n` | 新規ファイル (空タブ) | ファイル |
| `Ctrl+f` | ファイル内検索 (CodeMirror) | 検索 |
| `Ctrl+r` | 置換 (CodeMirror) | 検索 |
| `Ctrl+c` | コピー (ネイティブ) | クリップボード |
| `Ctrl+v` | ペースト (ネイティブ) | クリップボード |
| `Ctrl+x` | カット (ネイティブ) | クリップボード |
| `Ctrl+\|` | 縦分割 | ペイン |
| `Ctrl+\\` | 横分割 | ペイン |
| `Ctrl+-` | フォント縮小 (最小 10px) | 表示 |
| `Ctrl+=` / `Ctrl++` | フォント拡大 (最大 32px) | 表示 |
| `Ctrl+ArrowLeft` | 左ペインにフォーカス | ペイン |
| `Ctrl+ArrowRight` | 右ペインにフォーカス | ペイン |
| `Ctrl+ArrowUp` | 上ペインにフォーカス | ペイン |
| `Ctrl+ArrowDown` | 下ペインにフォーカス | ペイン |
| `Ctrl+,` | 設定画面を開く | 設定 |

### プレビューペインの Vim ナビゲーション

プレビューペインにフォーカスがある時 (tabindex="0"):

| キー | 機能 |
|------|------|
| `j` | 下スクロール (60px) |
| `k` | 上スクロール (60px) |
| `d` | 半ページ下スクロール (80% of viewport) |
| `u` | 半ページ上スクロール (80% of viewport) |
| `Space` / `PageDown` | ページ下スクロール (80% of viewport) |
| `PageUp` | ページ上スクロール (80% of viewport) |
| `gg` | 先頭にスクロール (500ms 以内に2回 g) |
| `G` | 末尾にスクロール |

---

## 7. データモデル

### Session JSON 構造

`~/.config/markdown-editor/session.json` に保存。

```json
{
  "open_tabs": [
    {
      "path": "/home/user/vault/notes/daily.md",
      "cursor_line": 0,
      "cursor_col": 0,
      "scroll_top": 120.5
    },
    {
      "path": "/home/user/vault/projects/design.md",
      "cursor_line": 0,
      "cursor_col": 0,
      "scroll_top": 0.0
    }
  ],
  "active_tab": 0,
  "vault_path": "/home/user/vault",
  "view_mode": "split",
  "sidebar_visible": true,
  "pane_layout": null
}
```

**備考**:
- `open_tabs` の `cursor_line` / `cursor_col` は現在フロントエンドでは常に 0 が設定される (カーソル位置は `from`/`to` オフセットとして Tab オブジェクト内で管理)
- `pane_layout` は将来のペイン永続化用。現在は常に `null`
- `path` が `null` のタブ (Untitled) はセッションに含まれない

### Config JSON 構造

`~/.config/markdown-editor/config.json` に保存。

```json
{
  "theme": "dark",
  "features": {
    "ai_copilot": false,
    "diff_highlight": true
  },
  "font_size": 14,
  "vim_mode": false,
  "openrouter_api_key": null
}
```

**フィールド説明**:
- `theme`: `"dark"` または `"light"`
- `features.ai_copilot`: AI コパイロット機能の有効/無効
- `features.diff_highlight`: 変更点強調表示の有効/無効
- `font_size`: エディタ/プレビューのフォントサイズ (10-32)
- `vim_mode`: Vim キーバインドの有効/無効
- `openrouter_api_key`: OpenRouter API キー (null で未設定)

---

## 8. 機能トグルシステム

### 仕組み

- `config.json` の `features` オブジェクトで各機能の on/off を管理
- `core/` ディレクトリのモジュールは**常にバンドルに含まれ、常にロード**される
- `features/` ディレクトリのモジュールは**動的 import** で必要時のみ読み込む
- 機能が off の場合、対応する JS コードは**一切読み込まれない** → 起動高速化

### 機能分類

| 分類 | モジュール | 重量 | 読み込み |
|------|----------|------|---------|
| コア | core/*.js | 軽量 | 常時 (esbuild バンドル) |
| 重量級 | features/ai-copilot.js | 重い (API通信, UI) | 動的 import |
| 中量級 | features/diff-highlight.js | 中程度 (差分計算) | 動的 import |

### 設定画面での制御

`settings.js` の設定画面で各機能のチェックボックスを操作し、`Save` ボタンで `config.json` に永続化。
次回起動時に `config.features` を参照して動的 import の要否を判断する。

---

## 9. 将来の実装計画

### Phase 6: 変更点強調表示

#### Phase 6a: 保存時点からの差分
- エディタのガター (行番号の横) に変更行をカラー表示
- 保存時点の内容をメモリに保持し、現在の内容と差分比較
- CodeMirror の `gutter` 拡張で実装

#### Phase 6b: git 連携
- `git diff` の出力をパースして変更行を表示
- Rust バックエンドに `git_diff` コマンドを追加
- Working tree の変更 (staged/unstaged) を色分け

#### Phase 6c: 任意コミット比較 UI
- コミット一覧から2つのコミットを選択して差分表示
- diff ビューアーの UI 実装

### Phase 7: AI コパイロット (OpenRouter 経由)

#### チャットサイドパネル
- `#ai-panel` (HTML に準備済み) を活用
- `#app.ai-panel-open` で CSS Grid のカラム幅を変更 (320px)
- メッセージ履歴表示、入力フォーム

#### Composer
- 選択テキストのリライト/要約/翻訳
- diff 表示で変更内容を確認 → Accept/Reject
- エディタに変更を適用

#### インライン補完 (Quick Ask)
- カーソル位置で短い質問・補完
- CodeMirror のインライン補完 API を活用

#### コンテキスト管理
- 開いているノートの全文
- 選択テキスト
- Vault フォルダ内の関連ファイル

#### チャット履歴の永続化
- `.md` ファイルとして Vault 内に保存
- フォーマット: Markdown (人間も読める)

#### API
- OpenRouter API (OpenAI 互換エンドポイント)
- API キーは `config.json` の `openrouter_api_key` に保存
- モデル選択: UI で切替可能に

### Phase 8: WSL フォールバック

#### 概要
- Tauri ウィンドウが使えない WSL 環境でもブラウザベースで動作
- `--wsl` フラグまたは `window.__TAURI__` の不在を検出

#### Rust HTTP サーバー
- axum または actix-web で軽量 HTTP サーバーを起動
- ポート: 3030 (デフォルト)

#### REST API エンドポイント

| メソッド | パス | 対応コマンド |
|---------|------|------------|
| POST | /api/read_file | read_file |
| POST | /api/write_file | write_file |
| POST | /api/read_dir_tree | read_dir_tree |
| GET | /api/load_session | load_session |
| POST | /api/save_session | save_session |
| GET | /api/get_config | get_config |
| POST | /api/save_config | save_config |
| POST | /api/write_temp_file | write_temp_file |
| POST | /api/delete_temp_file | delete_temp_file |
| POST | /api/check_temp_files | check_temp_files |

#### フロントエンド
- `backend.js` が自動で `fetch()` に切替 (既に実装済み)
- 静的ファイルも HTTP サーバーから配信

### その他将来機能

- **Emacs キーバインド**: `keymode.js` の `case 'emacs':` に実装を追加
- **Obsidian wikilink 記法**: `[[link]]` の解析とファイル間ジャンプ
- **機能トグルによる起動最適化の詳細制御**: 個別コア機能の遅延読み込み
- **プラグインシステム**: `features/` ディレクトリの仕組みを拡張し、外部プラグインの読み込みに対応

---

## 10. ビルドと開発

### コマンド一覧

| コマンド | 説明 |
|---------|------|
| `npm run build:frontend` | esbuild でフロントエンドをバンドル (`dist/bundle.js`)。`index.html` と `style.css` も `dist/` にコピー |
| `npm run dev:frontend` | esbuild の watch モード (開発用) |
| `npm run dev` | Tauri dev mode (フロントエンド自動ビルド + Rust ビルド + ウィンドウ起動) |
| `npm run build` | Tauri production build (リリースバイナリ生成) |
| `npm test` | vitest でテスト実行 |
| `npm run test:watch` | vitest の watch モード |
| `cargo build --manifest-path src-tauri/Cargo.toml` | Rust バックエンドのみビルド |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Rust テストのみ実行 |

### esbuild 設定

- **エントリポイント**: `src/js/app.js`
- **出力**: `dist/bundle.js`
- **フォーマット**: ESM
- **本番ビルド**: minify + tree-shaking 有効
- **開発ビルド**: sourcemap 有効

### Rust Release プロファイル

```toml
[profile.release]
strip = true     # デバッグシンボル除去
lto = true       # Link-Time Optimization
opt-level = "s"  # サイズ最適化
```

ターゲットバイナリサイズ: ~3MB

### バンドルターゲット

`tauri.conf.json` で指定:
- Linux: `.deb`, `.appimage`
- Windows: `.msi`, `.nsis`
- macOS: (アイコン設定済み、`.icns`)

### 依存関係

#### Rust (Cargo.toml)
- `tauri` 2.x - フレームワーク
- `tauri-plugin-dialog` 2.x - ネイティブダイアログ
- `tauri-plugin-cli` 2.x - CLI 引数解析
- `serde` 1.x + `serde_json` 1.x - シリアライズ/デシリアライズ
- `dirs` 5.x - OS 標準ディレクトリ取得
- `tempfile` 3.x (dev) - テスト用一時ディレクトリ

#### JavaScript (package.json)
- `@codemirror/*` - エディタコア
- `@replit/codemirror-vim` - Vim キーバインド
- `@tauri-apps/api` 2.x - Tauri JS API
- `@tauri-apps/plugin-dialog` 2.x - ダイアログ JS バインディング
- `@tauri-apps/plugin-cli` 2.x - CLI JS バインディング
- `codemirror` 6.x - CodeMirror メタパッケージ
- `markdown-it` 14.x - Markdown パーサー
- `esbuild` 0.27.x (dev) - バンドラー
- `@tauri-apps/cli` 2.x (dev) - Tauri CLI

---

## 11. テスト方針

### Rust テスト

`src-tauri/src/lib.rs` 内の `#[cfg(test)] mod tests` で実装。

| テスト | 検証内容 |
|-------|---------|
| `scan_dir_tree_finds_md_files` | .md ファイルのみが結果に含まれること |
| `scan_dir_tree_recurses_into_subdirs` | サブディレクトリ内の .md も再帰的に取得 |
| `scan_dir_tree_skips_hidden_files` | `.` 始まりのファイルがスキップされること |
| `scan_dir_tree_excludes_empty_dirs` | .md を含まないディレクトリが除外されること |
| `scan_dir_tree_sorts_dirs_before_files` | ディレクトリがファイルより先にソートされること |
| `config_default_values` | Config のデフォルト値が正しいこと |
| `session_default_values` | Session のデフォルト値が正しいこと |
| `session_serialization_roundtrip` | Session の JSON シリアライズ/デシリアライズの往復 |
| `config_serialization_roundtrip` | Config の JSON シリアライズ/デシリアライズの往復 |
| `temp_file_naming_convention` | 暫定ファイルの命名規則 (`.~filename.md.tmp`) |
| `temp_files_are_hidden_from_scan` | 暫定ファイルが scan_dir_tree で無視されること |

実行: `cargo test --manifest-path src-tauri/Cargo.toml`

### JavaScript テスト

`vitest` + `jsdom` 環境で実行。テストファイルは `src/js/__tests__/` に配置。

- `tabs.test.js` - タブ管理のユニットテスト
- `backend.test.js` - バックエンド抽象化レイヤーのテスト

実行: `npm test`

### 将来の E2E テスト

- **フレームワーク**: Playwright
- **対象**: Tauri ウィンドウまたはブラウザモードでの統合テスト
- **シナリオ例**:
  - ファイルを開いて編集→保存
  - セッション復元の動作確認
  - ビューモード切替
  - タブ操作のワークフロー
