# 使い方: `fude --wait` / `fude-cli` / ターミナルモード

> 設計の経緯は [TUI_DESIGN.md](TUI_DESIGN.md)。ここは**使い方だけ**をまとめた案内です。

## 登場するもの

| 名前 | どこで動く | 何をするか |
| --- | --- | --- |
| **Fude（GUI）** | 画面のあるマシン | いつものエディタ。起動すると「開いてほしい」という依頼を受ける口を開けて待つ |
| **`fude --wait`** | GUI と同じマシン | 「このファイルを開いて、タブを閉じるまで待て」と GUI に頼むコマンド。`git commit` や Claude Code が `$EDITOR` として呼ぶ用 |
| **`fude-cli`** | 画面のないマシン（ssh 先など）| 同じ依頼を**ネットワーク越し**に GUI へ送り、そのファイルの読み書きを代行する。GUI が見つからなければ端末内エディタになる。Fude に同梱され、手元では `fude setup` / `fude tui` / `fude check` として呼べる |

考え方は一つだけ: **ファイルのある場所で `fude-cli` を打つと、手元の Fude にタブが開く。** 編集は手元の Fude で普通に行い、保存すると元の場所に書き戻される。

## 全体図: どこで何を動かすか

```
 手元の PC（画面がある）                              ssh 先 k16（画面がない）
 ┌──────────────────────────────┐                   ┌──────────────────────────────┐
 │ ① fude            ← 起動しておく │                   │                              │
 │    Fude GUI                   │                   │  ③ fude-cli notes.md         │
 │    ・ ~/.config/fude/gui.sock  │◀──── ssh の転送 ────│     ・127.0.0.1:47821 に接続  │
 │    ・ 127.0.0.1:47821 (TCP)    │  (RemoteForward)   │     ・鍵 gui-token を提示     │
 │    ・ 鍵 ~/.config/fude/gui-token│                   │     ・notes.md を読み書き代行 │
 │                              │                   │        タブが閉じたら終了     │
 │ ② fude setup k16  ← 初回だけ    │─── ssh/scp ──────▶│  （setup が鍵と fude-cli を置く）│
 │                              │                   │                              │
 │ タブ「k16:/home/you/notes.md」 │                   │  /home/you/notes.md          │
 │   編集・保存 ──────────────────┼── 書き戻し ───────▶│                              │
 └──────────────────────────────┘                   └──────────────────────────────┘

 実行するコマンドは 3 つ:
   手元   ①  fude                   （いつも通り起動しておく）
   手元   ②  fude setup k16         （そのホストにつき 1 回。~/.ssh/config・鍵・fude-cli を整える）
   k16    ③  ssh k16 → fude-cli notes.md   （毎回これだけ。--wait を付けると $EDITOR になる）
```

同じマシンの中だけなら ②③ は要らない: `fude --wait file.md` で ① に直接頼む（git / Claude Code 用）。
画面が無く手元の Fude にも届かないときは、③ は端末内エディタ（`--tui`）に切り替わる。

```
 git commit ──▶ fude --wait COMMIT_EDITMSG ──▶ Fude にタブ ──▶ 閉じる ──▶ commit 続行
                 （同じ PC、ssh 不要）
```

## 1. 手元のマシンで（ssh 不要）

### `git commit` や Claude Code から Fude を開く

```bash
export EDITOR="fude --wait"          # ~/.bashrc などに
git config --global core.editor "fude --wait"
```

`git commit` を打つと Fude にタブが開く。書いて保存し、タブを閉じると commit が進む。
未保存の変更を捨てて閉じた場合は終了コード 1 になり、git はコミットを中止する。
Fude が起動していなければ自動で起動する。

### 端末内で編集する（ターミナルモード）

```bash
fude tui README.md           # ファイルをタブで開く（fude-cli --tui でも同じ。複数ファイル可）
fude tui ~/notes             # ディレクトリならファイル一覧から選ぶ
```

GUI と同じ配置（ファイル一覧 / エディタ / プレビュー / ステータスバー）を端末に描く。
手元の Fude に届かないとき `fude-cli notes.md` は自動でこれになる。

| キー | 動作 |
| --- | --- |
| 文字入力、矢印、Backspace など | そのまま編集（既定の EDIT モード。設定が Vim モードなら i / Esc / u / `/` などの Vim 操作） |
| Ctrl+S | 保存 |
| Enter | リストの行では次の項目のマーカーを続ける（空の項目で Enter するとリストを抜ける） |
| Ctrl+Z / Ctrl+Y | 元に戻す / やり直す（EDIT モード） |
| Ctrl+F | 検索（Enter で次へ、Esc で戻る） |
| Alt+J / Alt+K / Alt+L | エディタのみ / 分割 / プレビューのみ（GUI の Ctrl+Shift+J/K/L） |
| Alt+E | ファイル一覧を開いて移動（j/k、Enter で開く、Tab か Esc でエディタへ戻る） |
| Alt+T / Alt+W / Alt+] / Alt+[ | 新規タブ / タブを閉じる / 次 / 前のタブ |
| Alt+R | ディスクから読み直す（外部で変わったときはステータスバーに出る。未編集なら自動で追従） |
| F1 | キー一覧 |
| Alt+Q / Ctrl+Q | 終了（未保存があれば確認） |

編集中の内容は GUI と同じ暫定保存（`~/.config/fude/tmp/`）に 2 秒おきに逃がすので、落ちても次に開いたときに復元を聞かれる。
GUI の Ctrl+Shift+X は端末では区別できないため Alt+X に置き換えている（kitty / WezTerm などでも同じ）。

## 2. ssh 先のファイルを手元の Fude で編集する

### 初回だけ: 手元で 1 コマンド

手元で Fude を起動した状態で:

```bash
fude setup k16               # k16 は ~/.ssh/config のホスト名（無ければブロックが追加される）
```

これで次が終わる:

1. `~/.ssh/config` の `Host k16` に `RemoteForward 47821 ~/.config/fude/gui.sock` を追記
   （元のファイルは `~/.ssh/config.fude-bak` に退避）
2. k16 に `~/.config/fude/gui-token`（手元の Fude が作った鍵）と `~/.local/bin/fude-cli` を配置
   （手元と同じ OS/CPU なら手元のバイナリをコピー、違えば GitHub Releases から取得）
3. ssh 越しに接続確認（`✓ check: Fude 0.8.0 answers via tcp://127.0.0.1:47821`）

あわせて、そのホストへの **ssh の接続共有**（`ControlMaster auto` / `ControlPath ~/.ssh/fude-%C` /
`ControlPersist 10m`）を `Host k16` に足す。転送用のポートを持てる ssh 接続は 1 本だけなので、共有しないと
「最初に開いたセッションだけが Fude に届き、それを閉じると他のセッションも届かなくなる」。共有すると
何本 `ssh k16` しても同じ接続に相乗りし、最後のセッションを閉じても 10 分は接続が残る（2 本目以降のログインも速くなる）。
すでに `ControlMaster` などを自分で設定している場合は触らない。不要なら `fude setup k16 --no-share`、
共有中の接続を切るには `ssh -O exit k16`。Windows の OpenSSH は接続共有に対応していないので Windows では足さない。

### 毎回

```bash
ssh k16                      # 普通にログインする（この時点で裏で転送が張られる）
fude-cli notes.md            # 手元の Fude に「k16:/home/you/notes.md」のタブが開く。プロンプトはすぐ戻る
fude-cli --wait notes.md     # タブを閉じるまで待つ（k16 側の $EDITOR にするならこちら）
fude-cli --check             # 手元の Fude にどの経路で届いているか確認
```

コマンド名は `fude-cli`（ハイフン）。ssh 先にも Fude 本体（0.8.5 以降）を入れてある場合は、画面が無いことを検出して
`fude notes.md` が `fude-cli notes.md` と同じ動きになる（`fude cli notes.md` と空白で打っても同じ）。
古い Fude 本体が入っているホストで `fude FILE` と打つと、ウィンドウを開こうとして `Failed to initialize GTK` で落ちる。

- 転送は ssh の接続に付いている。接続共有が入っていれば、どのセッションからでも届き、全部閉じても 10 分は残る
- 公開されるのは `fude-cli` に渡したファイルの親ディレクトリ（ディレクトリを渡した場合はその配下）だけ
- 手元の Fude が起動していないと `fude-cli notes.md` は端末内ビューアに切り替わる

### 仕組み（知らなくても使える）

ssh が k16 のループバック 47821 番ポートを手元の `~/.config/fude/gui.sock` へ転送する。
k16 の `fude-cli` はそのポートに繋ぎ、鍵（`gui-token`）を見せてから「このファイルを開いて」と頼む。
以後、手元の Fude からの読み書き要求に `fude-cli` が答える。47821 番は k16 上の他のユーザからも
繋げるので、鍵が合わない接続は GUI が拒否する。

## 3. ssh を使わない構成

ssh は「k16 から手元の GUI に届く経路」を作るためだけに使っている。経路が別にあれば ssh は不要:

```
 ssh あり:   k16 の fude-cli ─▶ 127.0.0.1:47821 ═══ ssh の転送 ═══▶ 手元の gui.sock
 ssh なし:   k16 の fude-cli ─▶ 100.64.0.2:47821（Tailscale 経由で手元に直接）─▶ 手元の Fude（FUDE_GUI_TCP=0.0.0.0:47821）
```

**Tailscale SSH でも問題ない**（k16 がまさに Tailscale SSH で、本書の手順はそこで検証した）。
TCP の `RemoteForward` と `scp` はそのまま通る。Unix ソケットの転送だけは Tailscale SSH（root 動作）が
ソケットを root 所有で作るため使えず、それが TCP を既定にした理由でもある。

- **同じマシン**: `fude-cli notes.md` はローカルの `~/.config/fude/gui.sock` にも繋ぐ（ssh 不要）
- **Tailscale / VPN / LAN で直接届く場合**: GUI 側を外から繋げる口で起動し、相手側は宛先を指定する

  ```bash
  # GUI 側（起動前に環境変数）: TCP は既定では開いていない。全インタフェースで待ち受け。鍵が無い接続は拒否される
  FUDE_GUI_TCP=0.0.0.0:47821 fude
  # 相手側: 鍵（~/.config/fude/gui-token）を置いた上で
  FUDE_GUI_ADDR=100.64.0.5:47821 fude-cli notes.md
  ```

  通信は暗号化されないので、Tailscale/WireGuard のように経路が守られている場合に限る。
  インターネット越しは ssh を使うこと。

## 4. Windows 版 Fude で受ける（WSL を使っている場合）

> Fude 0.8.3 以降（Windows 版・WSL 側とも）。WSL のファイルと k16 のファイルを Windows の Fude で開き、
> 編集・保存・書き戻しまで実機で確認済み。

WSL で作業しつつ、表示は Windows の Fude にしたい場合。**WSL で 1 コマンド**、PowerShell からの ssh も
ファイアウォールの設定も要らない:

```bash
fude bridge            # WSL で実行（fude-cli bridge でも同じ）。起動したままにする
```

```
 Windows                                   WSL                                  ssh 先 k16
 ┌───────────────────┐               ┌──────────────────────────┐           ┌─────────────────┐
 │ Fude（Windows 版） │◀─ 名前付き ─── │ fude-cli.exe pipe         │           │                 │
 │   を起動しておく    │    パイプ      │   ▲ 標準入出力（WSL interop）│           │                 │
 │                   │               │ fude bridge               │◀─ ssh 転送 ─│ fude-cli a.md   │
 │ タブ:             │               │   ~/.config/fude/gui.sock │           │                 │
 │  home-wsl:/…/n.md │               │   ▲                       │           │                 │
 │  k16:/…/a.md      │               │ fude-cli n.md             │           │                 │
 └───────────────────┘               └──────────────────────────┘           └─────────────────┘
```

- `fude bridge` は WSL の Fude が待ち受けるはずの `~/.config/fude/gui.sock` を代わりに握り、来た接続を
  Windows 側の `fude-cli.exe pipe` に標準入出力で渡す。そこから Windows の Fude の名前付きパイプへ繋がる
- だから WSL で打つ `fude-cli notes.md` も、WSL から `ssh k16` した先の `fude-cli` も（転送先が同じソケットなので）
  そのまま Windows の Fude に開く。`fude setup k16` をやり直す必要もない
- 初回は鍵を `%APPDATA%\fude\gui-token` に書くので、そのとき Windows の Fude が起動中なら一度だけ再起動する
- `fude-cli.exe` は Fude のインストール先か `~/.cache/fude/` から探し、無ければ GitHub Releases から取得する
  （`--exe PATH` / `FUDE_CLI_EXE` で指定可）
- WSL の Fude と `fude bridge` は同じソケットを使うので**どちらか一方**。「WSL から開いたものをどちらの
  ウィンドウに出すか」の切り替えになる（両方起動しようとすると後から起動したほうが断る）
- WSL のローカルな `fude --wait` は使えない（Windows の Fude は WSL のパスを直接読めない）。`fude-cli --wait` を使う。
  `$EDITOR` には `fude-cli --wait` を設定しておけば、WSL の Fude でも Windows の Fude でも動く

### Windows だけで完結させる場合（PowerShell から ssh する）

Windows の Fude は名前付きパイプに加えて `127.0.0.1:47821` の TCP でも待ち受ける（ssh はパイプへ転送できないため）。
PowerShell で `fude-cli.exe setup k16`（インストール先の `fude-cli.exe`）を実行すると、Windows の
`~/.ssh/config` に `RemoteForward 47821 127.0.0.1:47821` を足し、鍵と `fude-cli` を k16 に置く。

## 5. 環境変数

| 変数 | どちら側 | 意味 |
| --- | --- | --- |
| `FUDE_GUI_TCP` | GUI | TCP の待ち受けアドレス。Windows は既定で `127.0.0.1:47821`、Linux / macOS / WSL は既定で**待ち受けない**（ソケットで足りる。指定すると有効、`off` で無効） |
| `FUDE_CLI_EXE` | fude bridge | Windows 側の `fude-cli.exe` の場所 |
| `FUDE_GUI_SOCK` | GUI / fude-cli | Unix ソケットの場所（既定 `~/.config/fude/gui.sock`） |
| `FUDE_GUI_ADDR` | fude-cli | 繋ぎに行く TCP アドレス（指定すると他の候補は探さない） |
| `FUDE_GUI_TOKEN` | fude-cli | 鍵（指定が無ければ `~/.config/fude/gui-token`） |
| `FUDE_HOST` | fude-cli | GUI に名乗るホスト名（既定はマシンのホスト名。タブに `host:/path` と出る） |

`fude-cli` が GUI を探す順: `FUDE_GUI_SOCK` → `FUDE_GUI_ADDR` → `~/.cache/fude/gui/*.sock`（Unix ソケット転送）→
`127.0.0.1:47821` → ローカルの `~/.config/fude/gui.sock`。

## 6. 困ったとき

| 症状 | 見るところ |
| --- | --- |
| `fude-cli` が端末内エディタになってしまう | 手元で Fude が起動しているか（Windows の Fude で受けるなら WSL で `fude bridge` が動いているか）。`fude-cli --check` で経路を確認 |
| `fude bridge`: `gui.sock is in use` | WSL の Fude（または別の bridge）が動いている。どちらか一方にする |
| `fude bridge` 経由で `no Fude GUI on Windows answers` | Windows の Fude が起動していない |
| `remote agents must present the GUI token` | 鍵が違う。`fude setup <host>` をやり直すか `~/.config/fude/gui-token` を手元のものと揃える |
| `tcp://127.0.0.1:47821: Connection refused` | ssh の転送が張られていない。`~/.ssh/config` の `RemoteForward` 行と、`ssh` でログインし直したか |
| `remote port forwarding failed for listen port 47821` | 接続共有が無い状態で同じホストへ ssh を複数本張ると出る（転送を持てるのは最初の 1 本だけ）。`fude setup k16` をやり直すと接続共有が入り、解消する。共有を入れる前から開いていたセッションは閉じて入り直す。他人や別のソフトが 47821 を使っている場合は `fude setup k16 --port 47822` で別ポートに |
| Fude 側に「k16 との接続が切れました」 | ssh を閉じた／`fude-cli` を止めた。タブは残り、未保存分は暫定保存にある。繋ぎ直してもう一度開く |
| ssh 先で `Failed to initialize gtk backend` | `fude`（GUI 本体）を画面の無いホストで起動した。`fude-cli FILE` を使う（Fude 0.8.5 以降の `fude FILE` は自動で `fude-cli` に切り替わる） |
| `fude --wait` が戻らない | そのタブを閉じる（Ctrl+Shift+W）。Fude を終了しても戻る |
