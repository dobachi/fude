# 使い方: `fude --wait` / `fude-cli` / ターミナルモード

> 設計の経緯は [TUI_DESIGN.md](TUI_DESIGN.md)。ここは**使い方だけ**をまとめた案内です。

## 登場するもの

| 名前 | どこで動く | 何をするか |
| --- | --- | --- |
| **Fude（GUI）** | 画面のあるマシン | いつものエディタ。起動すると「開いてほしい」という依頼を受ける口を開けて待つ |
| **`fude --wait`** | GUI と同じマシン | 「このファイルを開いて、タブを閉じるまで待て」と GUI に頼むコマンド。`git commit` や Claude Code が `$EDITOR` として呼ぶ用 |
| **`fude-cli`** | 画面のないマシン（ssh 先など）| 同じ依頼を**ネットワーク越し**に GUI へ送り、そのファイルの読み書きを代行する。GUI が見つからなければ端末内ビューアになる |

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
 │ ② fude-cli setup k16 ← 初回だけ │─── ssh/scp ──────▶│  （setup が鍵と fude-cli を置く）│
 │                              │                   │                              │
 │ タブ「k16:/home/you/notes.md」 │                   │  /home/you/notes.md          │
 │   編集・保存 ──────────────────┼── 書き戻し ───────▶│                              │
 └──────────────────────────────┘                   └──────────────────────────────┘

 実行するコマンドは 3 つ:
   手元   ①  fude                   （いつも通り起動しておく）
   手元   ②  fude-cli setup k16     （そのホストにつき 1 回。~/.ssh/config・鍵・fude-cli を整える）
   k16    ③  ssh k16 → fude-cli notes.md   （毎回これだけ。--wait を付けると $EDITOR になる）
```

同じマシンの中だけなら ②③ は要らない: `fude --wait file.md` で ① に直接頼む（git / Claude Code 用）。
画面が無く手元の Fude にも届かないときは、③ は端末内ビューア（`--tui`）に切り替わる。

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

### 端末内で Markdown を読む

```bash
fude-cli --tui README.md     # 整形して表示。ファイルの変更に追従する
```

| キー | 動作 |
| --- | --- |
| `q` / Esc / Ctrl+C | 終了 |
| `j` `k` ↑ ↓ | 1 行スクロール |
| Ctrl+D / Ctrl+U | 半ページ |
| Space / PageDown、PageUp | 1 ページ |
| `g` / `G` | 先頭 / 末尾 |
| `r` | 再読込 |
| マウスホイール | スクロール |

いまのところ閲覧のみ（編集機能は今後）。

## 2. ssh 先のファイルを手元の Fude で編集する

### 初回だけ: 手元で 1 コマンド

手元で Fude を起動した状態で:

```bash
fude-cli setup k16           # k16 は ~/.ssh/config のホスト名（無ければブロックが追加される）
```

これで次が終わる:

1. `~/.ssh/config` の `Host k16` に `RemoteForward 47821 ~/.config/fude/gui.sock` を追記
   （元のファイルは `~/.ssh/config.fude-bak` に退避）
2. k16 に `~/.config/fude/gui-token`（手元の Fude が作った鍵）と `~/.local/bin/fude-cli` を配置
   （手元と同じ OS/CPU なら手元のバイナリをコピー、違えば GitHub Releases から取得）
3. ssh 越しに接続確認（`✓ check: Fude 0.8.0 answers via tcp://127.0.0.1:47821`）

### 毎回

```bash
ssh k16                      # 普通にログインする（この時点で裏で転送が張られる）
fude-cli notes.md            # 手元の Fude に「k16:/home/you/notes.md」のタブが開く。プロンプトはすぐ戻る
fude-cli --wait notes.md     # タブを閉じるまで待つ（k16 側の $EDITOR にするならこちら）
fude-cli --check             # 手元の Fude にどの経路で届いているか確認
```

- ssh セッションを閉じると転送も閉じるので、`fude-cli` はログインしている間だけ使える
  （`ssh k16 'fude-cli x.md'` のようなワンショットは、コマンド終了と同時に切れる）
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
  # GUI 側（起動前に環境変数）: 全インタフェースで待ち受け。鍵が無い接続は拒否される
  FUDE_GUI_TCP=0.0.0.0:47821 fude
  # 相手側: 鍵（~/.config/fude/gui-token）を置いた上で
  FUDE_GUI_ADDR=100.64.0.5:47821 fude-cli notes.md
  ```

  通信は暗号化されないので、Tailscale/WireGuard のように経路が守られている場合に限る。
  インターネット越しは ssh を使うこと。

## 4. Windows 版 Fude で受ける

Windows の Fude は名前付きパイプに加えて `127.0.0.1:47821` の TCP でも待ち受ける（0.8.0 以降）。
鍵は `%APPDATA%\fude\gui-token`。

- **Windows の ssh からサーバへ**: Windows の `~/.ssh/config` に `RemoteForward 47821 127.0.0.1:47821`
  （パイプには転送できないので TCP を使う）。サーバ側は §2 と同じ
- **WSL から Windows の Fude へ**: WSL2 の既定（NAT）では Windows の localhost に届かないので、
  Windows 側を `FUDE_GUI_TCP=0.0.0.0:47821` で起動し（`setx FUDE_GUI_TCP 0.0.0.0:47821` 後に再起動）、
  WSL 側は `FUDE_GUI_ADDR="$(ip route | awk '/default/{print $3}'):47821"` を設定して `fude-cli notes.md`。
  鍵は WSL の `~/.config/fude/gui-token` と `%APPDATA%\fude\gui-token` を同じ内容にしておく。
  `.wslconfig` で `networkingMode=mirrored` なら `127.0.0.1` のままで届く

## 5. 環境変数

| 変数 | どちら側 | 意味 |
| --- | --- | --- |
| `FUDE_GUI_TCP` | GUI | TCP の待ち受けアドレス（既定 `127.0.0.1:47821`、`off` で無効） |
| `FUDE_GUI_SOCK` | GUI / fude-cli | Unix ソケットの場所（既定 `~/.config/fude/gui.sock`） |
| `FUDE_GUI_ADDR` | fude-cli | 繋ぎに行く TCP アドレス（指定すると他の候補は探さない） |
| `FUDE_GUI_TOKEN` | fude-cli | 鍵（指定が無ければ `~/.config/fude/gui-token`） |
| `FUDE_HOST` | fude-cli | GUI に名乗るホスト名（既定はマシンのホスト名。タブに `host:/path` と出る） |

`fude-cli` が GUI を探す順: `FUDE_GUI_SOCK` → `FUDE_GUI_ADDR` → `~/.cache/fude/gui/*.sock`（Unix ソケット転送）→
`127.0.0.1:47821` → ローカルの `~/.config/fude/gui.sock`。

## 6. 困ったとき

| 症状 | 見るところ |
| --- | --- |
| `fude-cli` が端末内ビューアになってしまう | 手元で Fude が起動しているか。`fude-cli --check` で経路を確認 |
| `remote agents must present the GUI token` | 鍵が違う。`fude-cli setup <host>` をやり直すか `~/.config/fude/gui-token` を手元のものと揃える |
| `tcp://127.0.0.1:47821: Connection refused` | ssh の転送が張られていない。`~/.ssh/config` の `RemoteForward` 行と、`ssh` でログインし直したか |
| `remote port forwarding failed for listen port 47821` | k16 側で別のものが 47821 を使っている。`fude-cli setup k16 --port 47822` で別ポートに |
| Fude 側に「k16 との接続が切れました」 | ssh を閉じた／`fude-cli` を止めた。タブは残り、未保存分は暫定保存にある。繋ぎ直してもう一度開く |
| `fude --wait` が戻らない | そのタブを閉じる（Ctrl+Shift+W）。Fude を終了しても戻る |
