# FILESナビバー改善 - デザインドキュメント

## 背景

現在のサイドバー（FILESナビバー）は最低限のファイルツリー表示のみ実装されており、以下の制約がある:

- **ファイルフィルタ**: `.md` ファイルのみ表示（Rust側 `scan_dir_tree` でハードコード）
- **ソート**: ディレクトリ優先→ファイル名の字句順のみ（変更手段なし）
- **ヘッダー**: "Files" タイトルのみ（設定ボタンなし）
- **設定**: `config.json` にサイドバー関連の設定項目なし

### 現在の実装箇所

| ファイル | 関連箇所 |
|---------|---------|
| `src-tauri/src/lib.rs` | `scan_dir_tree`関数（L193付近）: `.md`フィルタ、ソートロジック（L161-169） |
| `src/index.html` | サイドバーヘッダー（L12-14）: "Files"タイトルのみ |
| `src/js/core/sidebar.js` | フロントエンドのツリー描画ロジック |

---

## 改善要件

### 要件1: ファイル並び順の選択

ユーザーがファイルツリーの並び順を選択できるようにする。

**対応するソートオプション**:
- **名前順**（A-Z / Z-A）: 現在のデフォルト
- **更新日時順**（新しい順 / 古い順）
- **作成日時順**（新しい順 / 古い順）
- **サイズ順**（大きい順 / 小さい順）

すべてのソートで「ディレクトリ優先」は維持する。

### 要件2: 並び順設定の永続化

選択したソート設定を `config.json` に保存し、次回起動時に復元する。

### 要件3: Markdown以外のファイル表示対応

`.md` 以外のファイル（`.txt`, `.json`, `.yaml` 等）も表示可能にする。ただし、デフォルトは `.md` のみ表示を維持し、設定で切り替え可能にする。

### 要件4: FILESヘッダーへの設定ボタン追加

ヘッダーに設定アイコン（歯車またはスライダーアイコン）を追加し、ソートやフィルタの設定UIにアクセスできるようにする。

---

## 設計案

### 案A: ヘッダー内ポップオーバー方式

ヘッダーに設定ボタンを追加し、クリックでポップオーバーを表示。ソートとフィルタの設定をまとめて提供する。

**UI構成**:
```
┌─────────────────────────┐
│ Files              [⚙]  │  ← ヘッダー（設定ボタン追加）
├─────────────────────────┤
│ ┌─────────────────────┐ │
│ │ Sort by:            │ │  ← ポップオーバー
│ │ ○ Name (A-Z)        │ │
│ │ ○ Name (Z-A)        │ │
│ │ ○ Modified (newest)  │ │
│ │ ○ Modified (oldest)  │ │
│ │ ○ Created (newest)   │ │
│ │ ○ Created (oldest)   │ │
│ │ ○ Size (largest)     │ │
│ │ ○ Size (smallest)    │ │
│ │─────────────────────│ │
│ │ Show files:         │ │
│ │ ☑ Markdown (.md)    │ │
│ │ ☐ All files         │ │
│ └─────────────────────┘ │
│  📁 docs/               │
│  📄 README.md           │
│  📄 notes.md            │
└─────────────────────────┘
```

**メリット**:
- サイドバー幅に収まるコンパクトなUI
- 設定へのアクセスが直感的（ヘッダーの歯車ボタン）
- ポップオーバーはクリック外で自動閉じ
- Settings画面を肥大化させない

**デメリット**:
- ポップオーバーのCSS/JS実装が必要
- サイドバー幅が狭い場合、ポップオーバーが見切れる可能性

---

### 案B: Settings画面統合方式

既存のSettings画面にサイドバー設定セクションを追加する。

**UI構成**:
- Settings画面に「Sidebar」セクションを追加
- ソート順: ドロップダウン
- ファイルフィルタ: チェックボックス

**メリット**:
- 既存のSettings UIパターンに統一
- 実装がシンプル（既存パターンの踏襲）

**デメリット**:
- ソート変更のたびにSettings画面を開く必要があり、操作性が悪い
- ファイル一覧を見ながら設定を調整できない

---

### 案C: ハイブリッド方式（ポップオーバー + Settings連携）

ヘッダーのポップオーバーで頻繁に変更するソート順を操作し、Settings画面ではデフォルト値やフィルタの詳細を設定する。

**UI構成**:
- ヘッダーポップオーバー: ソート順の選択（即時反映）
- Settings画面: デフォルトソート順、ファイルフィルタ設定

**メリット**:
- 頻繁な操作（ソート変更）は手軽に
- 詳細設定はSettings画面でじっくり

**デメリット**:
- 同じ設定が2箇所に存在し、混乱の可能性
- 実装コストが最も高い

---

## 比較表

| 評価軸 | A: ポップオーバー | B: Settings統合 | C: ハイブリッド |
|--------|------------------|----------------|----------------|
| 実装コスト | ○ 中 | ◎ 小 | △ 大 |
| 操作性 | ◎ 直感的 | △ 遠い | ◎ 直感的 |
| UIの一貫性 | ○ 独自パターン | ◎ 既存踏襲 | △ 2箇所に分散 |
| 拡張性 | ◎ 将来の設定追加容易 | ○ Settings肥大化 | ○ 適切に分離 |
| 開発者体験 | ◎ ファイル一覧を見ながら調整 | △ 画面遷移必要 | ◎ ソートは即座 |

---

## 推奨案

**案A: ヘッダー内ポップオーバー方式**

理由:
1. ファイル一覧を見ながらソート・フィルタを切り替えられるため、操作性が高い
2. サイドバーヘッダーに設定ボタンを追加するだけでアクセスポイントが明確
3. 将来的に検索フィルタ等の設定項目を追加する際もポップオーバー内に統合可能
4. Settings画面の肥大化を避けられる

---

## 詳細設計（案A）

### Rust側の変更

#### `FileEntry` 構造体の拡張

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileEntry>>,
    // 追加フィールド
    pub modified: Option<u64>,   // Unix timestamp (seconds)
    pub created: Option<u64>,    // Unix timestamp (seconds)
    pub size: Option<u64>,       // bytes
}
```

#### `scan_dir_tree` の拡張

- `metadata()` から `modified`, `created`, `size` を取得して `FileEntry` に格納
- フィルタパラメータの追加: `show_all_files: bool`
- ソートはフロントエンド側で行う（Rust側はメタデータ提供のみ）

#### Config構造体の拡張

```rust
// config.json に追加
{
    "sidebar_sort": "name_asc",        // "name_asc" | "name_desc" | "modified_desc" | "modified_asc" | "created_desc" | "created_asc" | "size_desc" | "size_asc"
    "sidebar_show_all_files": false     // true: 全ファイル表示, false: .mdのみ
}
```

### フロントエンド側の変更

#### ソートロジック（`sidebar.js`）

```javascript
const SORT_OPTIONS = {
    name_asc:      { label: 'Name (A-Z)',          key: 'name',     order: 'asc' },
    name_desc:     { label: 'Name (Z-A)',          key: 'name',     order: 'desc' },
    modified_desc: { label: 'Modified (newest)',    key: 'modified', order: 'desc' },
    modified_asc:  { label: 'Modified (oldest)',    key: 'modified', order: 'asc' },
    created_desc:  { label: 'Created (newest)',     key: 'created',  order: 'desc' },
    created_asc:   { label: 'Created (oldest)',     key: 'created',  order: 'asc' },
    size_desc:     { label: 'Size (largest)',       key: 'size',     order: 'desc' },
    size_asc:      { label: 'Size (smallest)',      key: 'size',     order: 'asc' },
};
```

- ディレクトリ優先のソートは全オプションで維持
- ソート変更時に即座にツリーを再描画（Rustへの再リクエスト不要）

#### ポップオーバーUI（`index.html` + `style.css`）

- ヘッダーに `<button class="sidebar-settings-btn">` を追加
- ポップオーバー: `<div class="sidebar-settings-popover">` をヘッダー直下に配置
- ポップオーバー外クリックで閉じる（`document.addEventListener('click', ...)`)

#### 設定の永続化

- ソート順変更時に `invoke('save_config', ...)` でRust側に保存
- 起動時に `config.json` からソート順を読み込み、適用

### Markdown以外のファイル表示

#### フィルタ方式

- **デフォルト**: `.md` ファイルのみ表示（現行動作を維持）
- **全ファイル表示**: ポップオーバーのトグルで切り替え
- Rust側の `scan_dir_tree` にフィルタパラメータを追加

#### 非Markdownファイルの扱い

- 非Markdownファイルをクリックした場合: プレーンテキストとしてCodeMirrorで表示（Markdownプレビューは無効化）
- バイナリファイル: ツリーには表示するが、クリック時に「バイナリファイルは開けません」と通知
- アイコン: ファイル拡張子に応じたアイコン表示（将来拡張）

---

## 影響範囲

### 変更対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src-tauri/src/lib.rs` | `FileEntry`拡張（メタデータ追加）、`scan_dir_tree`のフィルタパラメータ追加、Config構造体拡張 |
| `src/index.html` | サイドバーヘッダーに設定ボタン追加、ポップオーバーHTML追加 |
| `src/style.css` | ポップオーバーのスタイル、設定ボタンのスタイル |
| `src/js/core/sidebar.js` | ソートロジック追加、ポップオーバーUI制御、設定の読み込み・保存 |
| `src/js/settings.js` | サイドバー設定の初期化（必要に応じて） |
| `src/js/app.js` | 起動時のサイドバー設定適用 |

---

## テスト方針

### 機能テスト

- 各ソートオプションでファイルツリーが正しく並ぶことを確認
- ディレクトリ優先ソートが全オプションで維持されることを確認
- ソート設定が `config.json` に保存・復元されることを確認
- 「全ファイル表示」トグルでMarkdown以外のファイルが表示されることを確認
- ポップオーバーの開閉動作を確認（ボタンクリック、外部クリック）

### エッジケース

- 空ディレクトリの表示
- ファイル名に特殊文字を含む場合のソート
- メタデータが取得できないファイル（`modified`/`created`がNone）のソート順
- 大量ファイル（1000+）でのソートパフォーマンス
- サイドバー幅が最小の場合のポップオーバー表示

### 対応プラットフォーム

- Windows / macOS / Linux で動作確認
- 特にファイルシステムのメタデータ（`created` タイムスタンプ）はOSによって挙動が異なるため注意
  - Linux（ext4）: `created`（birth time）が取得できない場合がある → `modified`にフォールバック
