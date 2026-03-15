# Fude (筆)

超軽量クロスプラットフォーム Markdown エディタ

[![GitHub release](https://img.shields.io/github/v/release/dobachi/fude)](https://github.com/dobachi/fude/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Build Status](https://img.shields.io/github/actions/workflow/status/dobachi/fude/build.yml?branch=main)](https://github.com/dobachi/fude/actions)

![Fude Screenshot](docs/screenshot.png)

[English README](README.en.md)

## 特徴

- **超軽量** - バイナリサイズ約3MB。Electron不使用、Tauri v2で高速起動
- **クロスプラットフォーム** - Windows, macOS, Linux, WSL対応
- **Vimモード** - `jj` / `jk` でインサートモード解除 (ESC代替)
- **リアルタイムMarkdownプレビュー** - エディタとプレビューの分割表示
- **ペイン分割** - VS Code風の縦・横分割
- **タブ管理 + セッション復元** - 前回の作業状態を自動復元
- **ダーク/ライトテーマ** - VS Code風の配色
- **暫定ファイル自動保存 + クラッシュ復元** - 編集内容を自動バックアップ、クラッシュ時に復旧
- **Obsidian Vault対応** - ディレクトリを開くだけで`.md`ファイルをツリー表示
- **AIコパイロット** - OpenRouter経由のAI支援 (将来機能)
- **自動アップデート** - Tauri Updaterによるアプリ更新
- **WSLブラウザモード** - 日本語IME対応のブラウザベースUI (`http://localhost:3000`)
- **WSLリモートモード** - Windows版Fudeを自動取得して起動
- **フレームワーク不使用** - Vanilla JSで実装、高速かつ軽量

## インストール

### Windows

GitHub Releasesから最新版をダウンロードしてください。

- **exe**: `Fude_x.x.x_x64-setup.exe` (NSISインストーラー)
- **msi**: `Fude_x.x.x_x64.msi` (MSIインストーラー)

### macOS

GitHub Releasesから`.dmg`ファイルをダウンロードしてインストールしてください。

### Linux (deb)

```bash
# GitHub Releasesからダウンロード
sudo dpkg -i Fude_x.x.x_amd64.deb
```

### Linux (AppImage)

```bash
chmod +x Fude_x.x.x_amd64.AppImage
./Fude_x.x.x_amd64.AppImage
```

### WSL

debパッケージでインストール後、3つの起動モードが利用できます。

```bash
fude             # ネイティブGUI (WSLg)
fude-browser     # ブラウザモード (http://localhost:3000) - 日本語IME対応
fude-remote      # Windows版を自動取得して起動
```

## 使い方

### 基本操作

1. **起動** - アプリを起動するとウェルカムタブが表示されます
2. **フォルダを開く** - `Ctrl+O` でMarkdownファイルが格納されたディレクトリを選択
3. **ファイル編集** - サイドバーからファイルを選択してエディタで編集
4. **プレビュー確認** - `Ctrl+K` で分割表示に切り替えてリアルタイムプレビュー
5. **保存** - `Ctrl+S` でファイルを保存 (暫定ファイルも自動削除)

### CLI引数

```bash
fude /path/to/vault    # ディレクトリを指定して起動
fude /path/to/file.md  # ファイルを指定して起動
```

### ビューモード

| モード | 説明 | ショートカット |
|--------|------|---------------|
| エディタのみ | エディタだけを表示 | `Ctrl+J` |
| 分割表示 | エディタ + プレビューを並べて表示 | `Ctrl+K` |
| プレビューのみ | プレビューだけを表示 | `Ctrl+L` |

### 設定

`Ctrl+,` で設定画面を開き、以下を変更できます。

- テーマ (ダーク/ライト)
- フォントサイズ
- キーモード (Normal/Vim)
- 機能トグル (AIコパイロット、変更点強調表示)
- OpenRouter APIキー

設定は `~/.config/fude/config.json` に保存されます。

## キーボードショートカット

### グローバルショートカット

| キー | 機能 |
|------|------|
| `Ctrl+J` | エディタのみ表示 |
| `Ctrl+K` | 分割表示 |
| `Ctrl+L` | プレビューのみ表示 |
| `Ctrl+T` | 新規タブ |
| `Ctrl+N` | 新規ファイル |
| `Ctrl+W` | タブを閉じる |
| `Ctrl+Tab` | 次のタブ |
| `Ctrl+Shift+Tab` | 前のタブ |
| `Ctrl+S` | 保存 |
| `Ctrl+Shift+S` | 名前を付けて保存 |
| `Ctrl+O` | フォルダを開く |
| `Ctrl+B` | 太字トグル (`**`) |
| `Ctrl+E` | サイドバー表示/非表示 |
| `Ctrl+F` | 検索・置換 |
| `Ctrl+\|` / `Ctrl+Shift+D` | 縦分割 |
| `Ctrl+\` / `Ctrl+Shift+H` | 横分割 |
| `Ctrl+Shift+W` | 分割ペインを閉じる |
| `Ctrl+矢印` | ペイン移動 |
| `Ctrl+-` | 文字縮小 |
| `Ctrl++` | 文字拡大 |
| `Ctrl+Shift+M` | Vimモード切替 |
| `jj` / `jk` | Vimインサートモード解除 (ESC代替) |
| `Ctrl+,` | 設定 |
| `Ctrl+?` | ヘルプ表示 |

### プレビューペインのVimナビゲーション

プレビューペインにフォーカスがある時に使用できます。

| キー | 機能 |
|------|------|
| `j` | 下スクロール (60px) |
| `k` | 上スクロール (60px) |
| `d` | 半ページ下スクロール |
| `u` | 半ページ上スクロール |
| `Space` / `PageDown` | ページ下スクロール |
| `PageUp` | ページ上スクロール |
| `gg` | 先頭にスクロール |
| `G` | 末尾にスクロール |

## ビルド方法

### 前提条件

- **Node.js** 22以上
- **Rust** (stable)
- **Linux追加パッケージ**:
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev
  ```

### ビルドコマンド

```bash
git clone https://github.com/dobachi/fude.git
cd fude
make setup       # 依存関係を一括インストール
make dev         # 開発モード (Tauri dev)
make build       # プロダクションビルド
make browser     # ブラウザモード (WSL向け)
make test        # 全テスト実行 (JS + Rust)
make lint        # 全lint実行 (ESLint + Clippy)
make format      # 全フォーマット実行 (Prettier + cargo fmt)
make check       # lint + format + test + build (CI向け)
make remote      # WSLからWindows版Fudeを起動
make clean       # ビルド成果物を削除
```

## 技術スタック

| カテゴリ | 技術 |
|----------|------|
| フレームワーク | [Tauri v2](https://tauri.app/) (Rust) |
| エディタ | [CodeMirror 6](https://codemirror.net/) |
| Vimキーバインド | [@replit/codemirror-vim](https://github.com/replit/codemirror-vim) |
| Markdownパーサー | [markdown-it](https://github.com/markdown-it/markdown-it) |
| フロントエンド | Vanilla JS (フレームワークなし) |
| バンドラー | [esbuild](https://esbuild.github.io/) |
| テスト (JS) | [Vitest](https://vitest.dev/) + jsdom |
| テスト (Rust) | cargo test |
| Lint | ESLint + Clippy |
| フォーマッター | Prettier + cargo fmt |

## 将来の計画

- **変更点強調表示** - エディタのガターに変更行をカラー表示 (git連携)
- **AIコパイロット** - OpenRouter経由のチャット、Composer、インライン補完
- **Emacsキーバインド** - keymode.jsに拡張ポイント準備済み
- **Obsidian wikilink対応** - `[[link]]` 記法によるファイル間ジャンプ
- **プラグインシステム** - 外部プラグインの読み込み対応

## ライセンス

MIT License

## 貢献

バグ報告や機能要望は [Issues](https://github.com/dobachi/fude/issues) からお願いします。

プルリクエストも歓迎です。大きな変更の場合は、先にIssueで議論してから着手してください。

### 開発の流れ

1. リポジトリをフォーク
2. フィーチャーブランチを作成 (`git checkout -b feature/my-feature`)
3. 変更をコミット (`git commit -m '機能追加: ...'`)
4. ブランチをプッシュ (`git push origin feature/my-feature`)
5. プルリクエストを作成
