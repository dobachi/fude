# Fude ターミナルモード / リモート GUI 設計

> 最終更新: 2026-10-10
> ステータス: 草案（実装前）

---

## 1. 目的と位置づけ

GUI の無い環境（SSH 先のサーバ、GUI ライブラリを入れていないマシン、tmux の中）でも
`fude file.md` と打てば**いつもの Fude と同じ頭で**編集できるようにする。

このために 2 つのモードを追加する。どちらも「リモートに置く小さな Rust バイナリ」を
共有するので、ひとつの設計として扱う。

| モード | 何が起きるか | 主な用途 |
| --- | --- | --- |
| **リモート GUI** | リモートで `fude file.md` を実行すると、操作側 PC の Fude GUI にタブが開く。リモート側のプロセスはタブが閉じるまで待つ | `git commit` / Claude Code など `$EDITOR` を呼ぶもの、ssh 先での手編集 |
| **TUI** | 端末の中で ratatui 製の Fude が起動する | 操作側に GUI が無い、転送が張れていない、素早く 1 ファイル直す |

目指さないもの:

- vim / helix の代替。差別化は **Markdown 構造の操作**（リスト・チェックボックス・表・アウトライン）、
  **プレビュー**、**GUI 版と共通の設定・セッション・暫定保存**
- X11 転送 / waypipe のような画面転送。ラグと IME の問題を持ち込むので採らない

既存の WSL 向けフォールバック（`fude-browser` / `fude-remote`）と同じく、
ユーザは `fude` としか打たず、環境に応じて自動で分岐する。

---

## 2. 全体像

### 2.1 起動時の分岐

リモート/ローカルを問わず、`fude <path>` の分岐は 1 本にする。

```
fude [--wait] [--gui|--tui] [--new-window] <path...>
  │
  ├─ 画面がある（DISPLAY / WAYLAND_DISPLAY / Windows / macOS）
  │     └─ ネイティブ GUI（既存。single-instance で既存ウィンドウに合流）
  ├─ 転送された GUI ソケットが見つかる（§4）
  │     └─ リモート GUI: 操作側の Fude にタブを開き、エージェントとして待つ
  └─ どちらも無い
        └─ TUI（§5）
```

`--gui` / `--tui` で強制できる。`--wait` は分岐に関係なく「タブが閉じるまで戻らない」。

### 2.2 バイナリ構成

```
fude（Tauri, 既存）            ← GUI。webkit/GTK に動的リンクする
fude-cli（新規, 静的バイナリ）  ← リモート GUI のエージェント役 + TUI。musl ビルド可
fude-core（新規, ライブラリ）    ← 両者が共有するロジック
```

- リモート GUI の主用途は「webkit の無いマシン」なので、Tauri バイナリとは**別の実行ファイル**が必須
  （動的リンク失敗で起動すらできないため）
- deb / dmg / exe には両方を同梱し、`fude` ランチャーが分岐する。サーバには `fude-cli` だけ
  `curl` で落とす運用も可（`fude` 名のシンボリックリンクを張れば同じ分岐が働く）

### 2.3 `fude-core` に切り出すもの

現在 `src-tauri/src/lib.rs`（約 2,600 行）に同居している Tauri 非依存のロジックを分離する。

| 既存（lib.rs） | fude-core へ |
| --- | --- |
| `read_file` / `write_file` / `read_dir_tree` / `rename_path` / `delete_path` / `create_file` / `create_directory` | ファイル操作 |
| `load_session` / `save_session`、`Session` / `TabInfo` / `PaneLayout` | セッション |
| `get_config` / `save_config`、`Config` / `ConfigResponse` | 設定 |
| `write_temp_file` / `delete_temp_file` / `check_temp_files`、`temp_file_path` | 暫定保存 |
| `file_watcher.rs` | 外部変更検知 |
| `resolve_cli_path` / `parse_open_args` | CLI 引数 |

Tauri コマンドは薄いラッパーとして残す（`#[tauri::command] fn read_file(...) { fude_core::read_file(...) }`）。
`key_storage.rs`（keyring）、拡張機能のインストール、AI、画像関連は GUI 専用のまま。

実装（2026-10-10）: `src-tauri/Cargo.toml` をワークスペースにし、`src-tauri/crates/fude-core/` に
`paths` / `config` / `session` / `files` / `temp` / `browse` / `cli` / `ipc` の各モジュールとして切り出した。
`cargo test --workspace --lib` で両クレートのテストが走る（Makefile / CI / docker も更新済み）。
`file_watcher.rs` は AppHandle に emit する構造のため未移動（Step 2 でコールバック化してから移す）。

さらに、いま JS 側にある Markdown の純粋ロジックのうち TUI が必要とするものを Rust に移植する
（§5.4、§7 のテスト方針とセット）。

---

## 3. ローカル `--wait`（最初の一歩）

リモート GUI の前に、**同じプロトコルをローカルで**動かす。ローカルの Claude Code や
`git commit` が `fude --wait` を呼んだとき、起動中の Fude にタブを足して閉じるまで待つ。

- 既存の `tauri_plugin_single_instance` ハンドラ（`lib.rs` の `run()` 内）は argv を受け取って
  `cli-args` イベントを emit するだけで、呼び出し元はすぐ終了する。`--wait` では終了せず、
  GUI からの `closed` を待ってから終了する
- single-instance の argv 転送は一方向なので、戻りの通知には §4.3 と同じ**ソケット**を使う。
  GUI は `~/.config/fude/gui.sock`（`config_dir()/gui.sock`、`FUDE_GUI_SOCK` で上書き可。
  Windows は名前付きパイプ）で listen し、`fude --wait` はそこへ `open{wait:true}` を送って
  `closed` を待つ
- 「タブが閉じる」の定義: タブを閉じる操作（Ctrl+Shift+W）、ウィンドウを閉じる、
  または未保存のまま閉じて破棄を選んだ場合。いずれも `closed{saved: bool}` を返し、
  呼び出し元は保存されなかった場合に終了コード 1 を返す（`git commit` が中断扱いにできる）
- `.md` 以外（`COMMIT_EDITMSG`、`crontab` の一時ファイル等）も開く。言語判定は `core/file-lang.js` が既にある

実装（2026-10-10）:

| ファイル | 役割 |
| --- | --- |
| `src-tauri/src/ipc.rs` | メッセージ型（`hello` / `open` / `opened` / `closed` / `error` / `bye`）、JSON Lines の encode/decode、ソケットの場所 |
| `src-tauri/src/gui_server.rs` | GUI 側。`ConnState`（接続ごとのプロトコル状態、純粋）、`WaitRegistry`（パス → 待っている接続）、`interprocess` のリスナ |
| `src-tauri/src/wait_client.rs` | `fude --wait`。接続できなければ GUI を起動して再試行（20 秒）、`WaitState` で `closed` を集計、終了コード |
| `src/js/core/wait-tracker.js` | フロント側。待たれているタブを追跡し、閉じたときに `wait_tab_closed(path, saved)` を呼ぶ。「名前を付けて保存」のリネームにも追随 |

- GUI は JS 側が `cli-args` のリスナを登録した後に `gui_ready` を呼び、そこで初めてソケットを開く。
  起動直後に `open` が届いて取りこぼす競合を構造的に避ける
- `--wait` で存在しないパスを指定した場合は、そのパスに紐づく空タブを開く（保存すると作られる）
- GUI が終了して接続が切れた場合、開いていたパスは「保存済み」として扱い終了コード 0
  （終了時に未保存の確認は GUI が済ませている）
- 終了コード: 0 = 全タブが保存済み/無変更で閉じた、1 = 破棄して閉じた/開けなかったパスがある、2 = 接続・起動の失敗

ここで決めたプロトコルを、そのままリモートに伸ばす。

---

## 4. リモート GUI

### 4.1 仕組み

リモートの `fude-cli` は**エディタではなくファイル係**。開いたファイル（またはディレクトリ）の
読み書きと監視を担当する一時的なエージェントになり、GUI でタブが閉じられたら終了する。

```
[操作側 PC]                                      [リモート]
Fude GUI (Tauri)                                 $ fude --wait notes.md   ← git / Claude Code が $EDITOR として起動
  │ listen: ~/.local/share/fude/gui.sock               │
  │                                                    │ ~/.cache/fude/gui/*.sock を走査して接続
  └──────── ssh -R（unix socket 逆転送）────────────────┘
       ←  open{paths, wait, cursor}
       →  read_file / write_file / read_dir_tree / watch_subscribe
       ←  file_changed{path}（notify イベント）
       →  closed{saved}        → リモートの fude-cli が終了
```

- キー入力・描画・プレビューは操作側で完結する。ネットワークを渡るのは保存・読み込み・変更通知だけ
- 常駐デーモンは不要。起動した `fude-cli` の数だけ接続があり、閉じれば消える
- VS Code の `code file` と違い、`fude-cli` 自身がファイル係なので、`--wait` 無しでも
  プロセスはタブが閉じるまで生きている必要がある
  - `fude notes.md` → 自分を fork して端末から切り離し、即座にプロンプトへ戻る。タブが閉じたら裏で終了
  - `fude --wait notes.md` → 前面に残り、閉じるまで戻らない（`$EDITOR` 用）
  - 切り離した後の標準出力は捨て、ログは `~/.cache/fude/agent.log` へ
- 操作側 GUI の「外部変更の自動リロード」「保存競合（`core/save-conflict.js`）」「暫定保存」は
  そのまま効く。リモートで Claude Code が同じファイルを書き換えても、dirty ならバナー、
  clean なら自動反映、という既存の挙動になる

### 4.2 接続の張り方

ユーザ操作をゼロにするため、ssh の `RemoteForward` を使う。`~/.ssh/config` に 1 行足すだけで、
普段の `ssh` が逆転送を張る。

```
Host dev
  RemoteForward ~/.cache/fude/gui/%C.sock ~/.local/share/fude/gui.sock
```

- `%C` は接続ごとに異なるハッシュ。同じパスだと 2 本目の ssh の bind が失敗し、
  1 本目が切れた後に誰も再 bind しないため、**接続ごとに別名**にする
- リモートの `fude-cli` は `~/.cache/fude/gui/*.sock` を走査し、接続できたものを使う。
  `ECONNREFUSED` のものは stale とみなして unlink し、1 つも無ければ TUI へ
- 環境変数 `FUDE_GUI_SOCK` があればそれを優先（走査しない）
- 操作側で GUI が起動していないと、ssh は転送先に繋げず接続を即閉じる。`fude-cli` は
  `hello` の応答が無いことで「GUI 無し」と判断し TUI へ。操作側で GUI を自動起動したければ、
  Linux は systemd のソケットアクティベーション（`fude-gui.socket`）、macOS は launchd で
  ソケットを先に握らせておく（§9）
- tmux の中や後から開いたシェルからも、ソケットはファイルシステム上にあるので見つかる
- sshd 側に `StreamLocalBindUnlink yes` があると stale の掃除が楽になるが、無くても動くようにする

#### TCP フォールバック

Windows の OpenSSH クライアントでは unix socket の転送が安定しないため、TCP も残す。

```
Host dev
  RemoteForward 47821 localhost:47821
```

TCP の場合は browser mode と同じ**トークン必須**（`src/js/browser-token.js` /
`~/.config/fude/browser-token` の仕組みを流用）。`fude-cli` は `FUDE_GUI_ADDR=127.0.0.1:47821` と
`FUDE_GUI_TOKEN` を見る。unix socket はユーザ権限（0600）で守られるのでトークン不要。

### 4.3 プロトコル

1 接続 = 1 セッション。改行区切りの JSON（JSON Lines）、各メッセージに `id` を持つ request/response と、
`id` 無しの notification。コマンド名は既存の Tauri コマンド / `scripts/serve.js` の `/api/<cmd>` と
揃え、`backend.js` の第 3 経路として扱えるようにする。

| 方向 | メッセージ | 内容 |
| --- | --- | --- |
| cli → gui | `hello` | `{protocol: 1, host, user, cwd, cli_version}` |
| cli → gui | `open` | `{paths: [...], wait: bool, cursor?: {line, col}, new_window?: bool}` |
| gui → cli | `read_file` / `write_file` / `read_dir_tree` / `rename_path` / `delete_path` / `create_file` / `create_directory` | 既存コマンドと同じ引数・戻り値 |
| gui → cli | `watch_subscribe` / `watch_unsubscribe` | `{path}` |
| cli → gui | `file_changed` | `{path, kind}`（`file_watcher.rs` のイベントをそのまま） |
| gui → cli | `closed` | `{path, saved: bool}`。`wait` だった場合、全パスが閉じたら cli は終了 |
| 双方 | `ping` / `bye` | 生存確認と明示的終了 |

GUI 側の実装:

- Rust（Tauri）側がソケットを accept し、セッションを `remote:<session-id>` という
  名前空間で保持する。JS からは `invoke("remote_read_file", {session, path})` のように呼ぶ
- `backend.js` は「このパスはどの経路か」を判断する。タブの `path` を
  `remote://<session-id>/<abs path>` 形式にしておけば、既存の `read_file(path)` 呼び出しを
  置き換えずに経路を切り替えられる

### 4.4 切断・再接続

| 事象 | GUI 側の振る舞い |
| --- | --- |
| cli が Ctrl+C / ssh 切断で死ぬ | タブを「切断」表示（読み取り専用ではなく編集は続けられる）。未保存の内容を操作側の暫定ファイルに退避 |
| 同じ host+path で再接続 | 暫定ファイルがあれば復元を提案（既存のクラッシュ復元 UI を流用） |
| GUI 側を終了 | 全セッションに `bye`。`--wait` 中の cli は `closed{saved}` を受けて終了 |

暫定ファイルは**操作側**に `host + path` をキーにして保存する（リモートが落ちても残る方を優先）。
`temp_file_path` のキー生成に host を含める拡張が必要。

### 4.5 セッション

`session.json` の `TabInfo.path` にリモートのタブは `remote://<host>/<abs path>` で保存する
（session-id は接続ごとに変わるので host で保存）。復元時にその host への接続が無ければ
灰色タブとして置いておき、接続が来たら中身を読む。

### 4.6 守るべき不変条件

- ソケット越しの要求で GUI が触ってよいのは**その接続が差し出したリモートのファイルだけ**。
  リモートからの要求で操作側のローカルファイルを読み書きしない（名前空間を分けることで構造的に防ぐ）
- `fude-cli` が公開する範囲は、起動時に渡されたパスに限定する。ファイルなら親ディレクトリ、
  ディレクトリならその配下（browser mode の `--root` と同じ考え方）。範囲外の `read_file` は拒否
- unix socket は 0600、TCP はトークン必須。`hello` で protocol 番号を照合し、不一致なら切る

---

## 5. TUI

### 5.1 技術選定

| 項目 | 選定 | 理由 |
| --- | --- | --- |
| フレームワーク | ratatui + crossterm | 事実上の標準。kitty keyboard protocol、マウス、OSC 8 に対応 |
| Markdown パーサ | comrak | GFM の表・タスクリスト、front matter、wikilink 拡張があり、`sourcepos` が取れるのでスクロール連動に使える |
| エディタウィジェット | v1: `tui-textarea` → 不足したら ropey ベースに自作 | まず Normal キーモードで出す。Vim は `edtui` を評価してから決める |
| 文字幅 | unicode-width + unicode-segmentation | 日本語（全角）と書記素クラスタは必須 |
| シンタックスハイライト | syntect（オプション feature） | バイナリサイズと相談 |

日本語 IME は端末エミュレータ任せになるので、WSLg で問題になっていた変換ウィンドウの件は
TUI では起きない（`docs/WSL_IME.md` の問題は GUI 固有）。

### 5.2 画面構成

GUI 版と同じ配置にする。

```
┌ sidebar ─┬─ tabs ────────────────────────────────────────────┐
│ tree /   │ [notes.md*] [todo.md]                              │
│ outline  ├───────────────────┬────────────────────────────────┤
│          │ editor            │ preview                        │
│          │                   │                                │
├──────────┴───────────────────┴────────────────────────────────┤
│ notes.md  Ln 12, Col 4  split  [Vim: NORMAL]      ⟳ watching │
└───────────────────────────────────────────────────────────────┘
```

- 表示モード: エディタのみ / 分割 / プレビューのみ（GUI と同じ 3 つ）
- サイドバー: ファイルツリー（`.md` のみ、ディレクトリ折り畳み）とアウトラインを巡回
- ステータスバー: GUI の右下バッジと同じ文言でキーモードを表示

### 5.3 GUI 機能の取捨

| GUI の機能 | TUI で |
| --- | --- |
| 表示モード J/K/L、タブ、サイドバー、アウトライン | そのまま |
| キーモード Normal / Vim / Emacs + バッジ、`jj`/`jk` で ESC 代替 | そのまま（Vim/Emacs は v2） |
| 保存 / 名前を付けて保存 / 未保存警告 / 保存競合 | そのまま（fude-core 共有） |
| 外部変更の自動リロード、dirty 時バナー | そのまま。TUI の主役機能（隣のペインで AI が書き換えるのを見る） |
| 検索・置換 | 下部バー。Vim は `/` と `:%s` |
| 太字 / 箇条書き / 番号付きリストのトグル、リスト継続 | Rust に移植（§5.4） |
| プレビューのダブルクリック編集 | 置換: プレビュー側で `Enter` = ソースへジャンプ、`Space` = チェックボックス切替 |
| 表のセル編集・整形 | 整形は移植。セル編集はソース側で Tab / Shift+Tab のセル移動まで |
| ペイン分割 | v1 では落とす（tmux に任せる）。ratatui の Layout で後から足せる |
| 設定画面 | `~/.config/fude/config.json` をタブで開き、保存時に再読込 |
| テーマ | 既定は端末の 16 色パレット追従。truecolor が使えるときだけ Fude の dark/light を再現 |
| ズーム、印刷、画像貼り付け | 落とす |
| PlantUML / Mermaid / ArchiMate | 落とす。コードブロックのまま表示 |
| 画像 | Kitty / Sixel / iTerm2 対応端末でのみ `ratatui-image`（オプション） |
| AI コパイロット | v1 では入れない。隣のペインの CLI エージェントが代わり |
| リンク | OSC 8 ハイパーリンクで端末からクリック可能に |
| マウス | 有効化する（ツリー・プレビューのクリック、スクロール）が、無くても全操作できる |

### 5.4 JS から Rust に移植する純粋ロジック

| JS（`src/js/core/`） | 内容 |
| --- | --- |
| `list-nav.js` / `task-list.js` | リスト継続、箇条書き・番号付きトグル、チェックボックス切替 |
| `outline.js` | 見出し抽出 |
| `table.js` / `table-grid.js` | 表の整形、セル位置の計算 |
| `preview-blocks.js` | ソース行 ↔ ブロックの対応（スクロール連動、ジャンプ） |
| `line-diff.js` | 外部変更の差分（リロード時のカーソル維持） |
| `pathnorm.js` | パス正規化 |

JS 側は残す（GUI は引き続き JS で動く）。二重実装のコストはテストベクタの共有で抑える（§7）。

### 5.5 プレビューの描画

comrak の AST を ratatui の `Text` に変換する。

- 見出し: レベルごとに色と太字。`#` は消す
- リスト: ネストはインデント、折り返しはぶら下げ。タスクは `☐` / `☑`
- コードブロック: 枠無し、背景色、言語名を右上に。syntect があればハイライト
- 表: 罫線（box-drawing）で描く。全角幅を考慮して列幅を揃える
- 引用: 左に `▎`
- リンク: 下線 + OSC 8。画像は `[image: alt]`（対応端末では実画像）
- スクロール連動: `sourcepos` から「ソース行 → 描画行」の対応表を作り、エディタのカーソル行に合わせる

---

## 6. キーバインド

端末では **Ctrl+Shift+文字が存在しない**（Ctrl+S と Ctrl+Shift+S は同じバイト）。
Fude はアプリ系ショートカットを Ctrl+Shift に統一しているので、ここが TUI 設計の肝になる。

### 6.1 方針

1. **kitty keyboard protocol を有効化**する（crossterm `PushKeyboardEnhancementFlags`）。
   kitty / WezTerm / foot / Ghostty / Alacritty / 新しめの Windows Terminal・iTerm2 では
   GUI 版と**完全に同じ** Ctrl+Shift+X が通る。tmux は `set -s extended-keys on` が必要
2. **フォールバック規則は 1 本だけ**: `Ctrl+Shift+X ≡ Alt+X`。ESC プレフィックスなので
   どの端末・tmux でも届く。GUI のヘルプ（`src/js/help.js`）の一覧に機械的に対応する
3. **コマンドパレット**（Vim は `:`、他は `Alt+X Alt+X`）を全コマンドの最終手段にする。
   ヘルプのカテゴリ分けをそのまま流用する
4. 端末固有の制約: レガシーモードでは Ctrl+J = Enter、Ctrl+H = BS、Ctrl+I = Tab、Ctrl+M = Enter。
   raw mode なので Ctrl+S / Ctrl+Q は普通に使える（XON/XOFF は無効）

### 6.2 対応表（フォールバック時）

| GUI | TUI（レガシー端末） | 備考 |
| --- | --- | --- |
| Ctrl+Shift+J / K / L | Alt+J / K / L | 表示モード |
| Ctrl+Shift+E | Alt+E | サイドバー |
| Ctrl+Shift+T / N | Alt+T / N | 新規タブ |
| Ctrl+Tab / Ctrl+Shift+Tab | Alt+] / Alt+[ | タブ移動（Ctrl+Tab は端末に届かない） |
| Ctrl+S | Ctrl+S | 保存 |
| Ctrl+Shift+S | Alt+S | 名前を付けて保存 |
| Ctrl+Shift+O | Alt+O | フォルダを開く |
| Ctrl+Shift+W | Alt+W | タブを閉じる（Emacs モードは `C-x k`） |
| Ctrl+Shift+R | Alt+R | 再読込 |
| Ctrl+Shift+U | Alt+U | ファイラで場所を表示 |
| Ctrl+Shift+M | Alt+M | キーモード切替 |
| Ctrl+Shift+8 / 7 | Alt+8 / 7 | リストトグル |
| Ctrl+Shift+F / G | Alt+F / G | 表の整形 / 挿入（Emacs モードは `M-f` と衝突するためパレット経由） |
| Ctrl+B | Ctrl+B | 太字（Normal / Vim） |
| Ctrl+F | Ctrl+F | 検索（Normal / Vim） |
| Ctrl+, | `:config` | 設定ファイルをタブで開く |
| Ctrl+? | F1 / `:help` / Vim の `?`（NORMAL 時） | ヘルプ |
| Ctrl+Shift+D / H / Ctrl+\| / Ctrl+\ | （v1 では無し） | ペイン分割 |

Emacs モードで衝突するのは Alt+W（kill-ring-save）、Alt+D（kill-word）、Alt+F / Alt+B（単語移動）、
Alt+V（ページ前）。この 5 つは Emacs モード時のみ `C-x` プレフィックス（`C-x k` で閉じる等）に逃がす。

---

## 7. テスト方針

CLAUDE.md の「テストの無い変更は未完成」に従う。

- `fude-core` の切り出しは**挙動を変えないリファクタ**として、既存の `cargo test` が green のまま進める
- JS → Rust に移植するロジックは、既存の vitest（`src/js/__tests__/editor-list.test.js`、
  `outline.test.js`、`preview-blocks.test.js`、`line-diff.test.js` 等）の入出力を
  **JSON fixture に書き出し、vitest と cargo test の両方がそれを読む**。
  GUI と TUI で挙動がずれたら両方のテストが落ちる
- プロトコル（§4.3）はメッセージの encode/decode と状態遷移（`open → closed`、切断時の退避）を
  ソケット無しで単体テストできるように、I/O と分離して書く
- 接続の発見（§4.2）は一時ディレクトリに生きたソケット / stale ソケットを置いて検証する
- TUI の描画は ratatui の `TestBackend` でスナップショットを取る（全角幅の列揃え、折り返し）
- キーバインドは「kitty protocol あり / 無し × キーモード 3 種」の組み合わせを表駆動でテストする

---

## 8. ロードマップ

| 段階 | 内容 | 成果 |
| --- | --- | --- |
| 0 | ローカル `fude --wait`（§3）。GUI 側のソケット listen とプロトコル確定 | ローカルの Claude Code / git から Fude を `$EDITOR` にできる |
| 1 | `fude-core` 切り出し（§2.3）。既存テスト green を維持 | Tauri 非依存のライブラリ |
| 2 | `fude-cli` エージェント（§4）。unix socket 逆転送、`--root` 相当の範囲制限、切断時の退避 | ssh 先で `fude file.md` が操作側 GUI に開く |
| 3 | TUI ビューア: `fude-cli --tui --preview file.md`。描画 + 監視でライブ更新 | エージェントの出力を端末で眺められる |
| 4 | TUI エディタ v1: Normal キーモード、分割表示、ツリー、タブ、セッション、暫定保存、検索 | 転送が無くても編集できる |
| 5 | TUI v2: Vim / Emacs、リスト・チェックボックス・表、アウトライン | GUI と同じ操作感 |
| 6 | TUI v3: ペイン分割、画像、git ガター（`features/diff-highlight.js` の TUI 版） | |

0 → 2 がリモート GUI、3 → 6 が TUI。0 と 1 は両方の土台なので先に済ませる。

---

## 9. 未決事項

| 論点 | 現時点の案 |
| --- | --- |
| Vim エミュレーションを自作するか `edtui` を使うか | v1 を Normal で出してから判断 |
| Windows の操作側 GUI でのソケット | 名前付きパイプ。TCP + トークンで代替可 |
| `fude-cli` の配布 | deb / dmg / exe に同梱 + GitHub Releases に単体の静的バイナリ（`make release` の対象に追加） |
| 既存 `fude-browser` との関係 | 残す。「ブラウザを GUI にする」用途は別物。将来 `fude-cli` が serve.js の API を話せるようになれば統合候補 |
| リモート側の暫定ファイル | 操作側に置く（§4.4）。リモート側には置かない |
| 操作側 GUI の自動起動 | v1 は「GUI を起動しておく」が前提。後で Linux は systemd user socket（`fude-gui.socket`）、macOS は launchd のソケットアクティベーションを配布物に同梱する。Windows はログイン時起動で代替 |
