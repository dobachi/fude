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

## 1.5 Fude の画面からリモートを開く（設定不要）

**メニュー「ファイル」→「リモート接続…」**（`Ctrl+Shift+X`。もう一度押すと閉じる）の一番上「開く」で、接続先とパスを入れて「開く」を押す。
ssh でログインしておく必要も、事前のセットアップも要らない。

```
開く      [ k16 ▾ ] [ ~/Sources/notes            ] [開く]
接続中    k16  /home/you/Sources/notes              [切断]
▸ ホストの端末から開けるようにする（任意の設定）
```

- **接続先**: 最近使ったホスト、セットアップ済みのホスト、`~/.ssh/config` にあるホスト名から選ぶ。
  「別のホストを入力…」で直接打つこともできる。「WSL 連携」でディストリビューションを選んである Windows 版では、
  WSL の中も接続先に出る
- **パス**: 入力中に候補が出る。`Tab` で補完（シェルと同じく、候補が一致するところまで）、`↑` `↓` で選択、
  `Enter` で開く。以前開いた場所も候補に出て、最後に開いた場所は最初から入っている。空欄はホーム
- **接続中**: いま繋がっている相手と、開いている場所。「切断」でその接続を終える。タブは残るが、
  もう一度開くまで保存はできない。端末から `fude FILE` で繋いできた相手もここに出る

リモートのフォルダを開いている間は、左のファイラの見出しがそれを示す。
そのフォルダで相手側のファイルが増えたり、消えたり、書き換わったりすると、ファイラは自動で追従する
（Fude 0.8.14 以降。相手側の `fude-cli` も 0.8.14 以降であること。古いままなら「セットアップ」の「更新」で入れ直す）。

- フォルダ名が `k16:notes` のように相手の名前つきで、色を変えて表示される
- `↑`（一つ上へ）は、相手のマシン上で一つ上のフォルダを開く
- 地球のボタン（リモートのときだけ出る）は、同じ相手の別の場所を開くために「リモート接続」画面を開く。
  接続先といまのフォルダが入った状態で始まる
- フォルダのボタンは「この PC のフォルダを開く」で、押すとリモートから離れる

必要なのは、相手に `fude-cli` があること（Fude を入れてあるか、下の「セットアップ」を一度実行してあれば入っている）と、
パスワード入力なしで `ssh HOST` できることだけ。無い・古い場合は、その旨と対処が表示される。

仕組み: Fude が自分で `ssh HOST fude-cli …`（WSL なら `wsl.exe … fude-cli …`）を起動し、その入出力で直接やり取りする。
ポートの転送も鍵も `~/.ssh/config` の変更も使わない。Fude を終了するか「切断」すると、相手側の `fude-cli` も終わる。

接続は、Fude を終了するか「切断」するまで続く。開いたファイルのタブを閉じても切れない（0.8.20 以降）。
ssh は 15 秒ごとに相手の生存を確かめ、スリープやネットワークの切り替えで回線が切れたことに 1 分以内に気づく。
そうして**回線が切れたときは、自動で繋ぎ直す**（0.8.20 以降）。1 秒後から始めて間隔を広げ、以後は 1 分おきに、
30 分ほど試す。繋ぎ直している間はタブもファイラもそのままで、戻れば保存もファイラの追従も元どおりになる。
繋ぎ直せなかったときはそう知らせるので、もう一度開く。相手が自分から終わった（`fude-cli` が別れを告げた）ときは繋ぎ直さない。

### 1 行で指定して開く（Tana と共通の書き方）

メニュー「ファイル」→「パスを開く」（`Ctrl+Shift+P`）の欄に、リモートの場所を 1 行で書いても開ける。
**クリップボードに 1 行指定があれば、欄に最初から入っている**ので、AI に出させた行をコピー → `Ctrl+Shift+P` → `Enter` で開ける。
ファイルならタブで、フォルダならファイラで開く（開き方は上の「開く」と同じ）。

| 書き方 | 例 | 意味 |
|---|---|---|
| `ssh://ホスト/絶対パス`（正式） | `ssh://k16/home/me/notes/a.md` | `sftp://`・`remote://` も同じ |
| `ssh://ホスト/~/パス` | `ssh://k16/~/notes` | ホーム基準 |
| `ssh://ホスト` | `ssh://k16` | ホーム |
| `ssh://user@ホスト/…` | `ssh://me@k16/srv` | ユーザー指定 |
| `ホスト:/絶対パス`・`ホスト:~/パス` | `k16:/srv/a.md`・`k16:~/notes` | scp と同じ簡易形（空白を含むパスも可） |

- ホストは `ssh ホスト` で入れる名前（`~/.ssh/config` の Host 名など）。**ポートは 22 以外を書けない**ので、`~/.ssh/config` に Host を作ってその名前で書く
- URL 形の `%20` などはデコードする。後ろの `#L42` のような `#…` は今は無視する
- 前後の空白・引用符・バッククォート・`<>`、行頭の `- ` / `1. `、```` ``` ```` の行は取り除く。複数行なら最初に読めた行を使う
- 簡易形は `/` か `~` で始まるパスだけ（`localhost:8080` や `Note: …` を誤読しないため）。`C:\…` のようなドライブ名も拾わない

AI への頼み方の例: 「開く場所は `ssh://ホスト名/絶対パス` の 1 行だけで、コードブロックに入れて出力して」

> 次の §2 は逆向き、つまり**ホストの端末で `fude FILE` と打って**手元の Fude に開くための設定。
> 画面から開くだけなら §2 は不要。

## 2. ssh 先のファイルを手元の Fude で編集する

### 初回だけ: 手元で 1 コマンド

手元で Fude を起動した状態で:

```bash
fude setup k16               # k16 は ~/.ssh/config のホスト名（無ければブロックが追加される）
```

これで次が終わる:

1. `~/.ssh/config` の `Host k16` に `RemoteForward <ポート> ~/.config/fude/gui.sock` を追記
   （元のファイルは `~/.ssh/config.fude-bak` に退避）。ポートは手元の PC ごとに決まる番号（47822〜48821 のどれか。
   `--port N` で指定も可）
2. k16 に `~/.config/fude/guis/<ポート>`（手元の Fude が作った鍵と、手元の PC の名前）と `~/.local/bin/fude-cli` を配置
   （手元と同じ OS/CPU なら手元のバイナリをコピー、違えば GitHub Releases から取得）
3. ssh 越しに接続確認（`✓ check: Fude 0.8.9 on home answers via tcp://127.0.0.1:47985`）

ポートと鍵が PC ごとに分かれているので、複数の PC から同じホストをセットアップしても互いを壊さない
（0.8.8 までは全 PC が 47821 番と 1 つの `gui-token` を共有していて、後からセットアップした PC が鍵を上書きし、
先に ssh した PC がポートを占有していた。0.8.9 以降でセットアップし直すと、その PC の分は自分のポートへ移る）。

あわせて、そのホストへの **ssh の接続共有**（`ControlMaster auto` / `ControlPath ~/.ssh/fude-%C` /
`ControlPersist 10m`）を `Host k16` に足す。転送用のポートを持てる ssh 接続は 1 本だけなので、共有しないと
「最初に開いたセッションだけが Fude に届き、それを閉じると他のセッションも届かなくなる」。共有すると
何本 `ssh k16` しても同じ接続に相乗りし、最後のセッションを閉じても 10 分は接続が残る（2 本目以降のログインも速くなる）。
すでに `ControlMaster` などを自分で設定している場合は触らない。不要なら `fude setup k16 --no-share`、
共有中の接続を切るには `ssh -O exit k16`。Windows の OpenSSH は接続共有に対応していないので Windows では足さない。

### コマンドを打たずに設定する（「リモート接続」画面）

同じことはアプリからもできる。**メニュー「ファイル」→「リモート接続…」→「ホストの端末から開けるようにする（任意の設定）」** を開き、ホスト名を入れて
「セットアップ」を押すと、`fude setup HOST` が裏で実行され、結果がその場に表示される。
成功したホストは一覧に残り、あとから次ができる。

| ボタン | すること |
| --- | --- |
| 接続確認 | そのホストの `fude-cli` がこの Fude に届くかだけを確かめる（何も変更しない。`fude setup HOST --check` と同じ） |
| 更新 | セットアップをやり直す。ホスト側の `fude-cli` も手元の版に入れ直される（Fude を更新したあとに押す）。そのホストをこの画面から開いていた接続は、いったん切って同じ場所を開き直し、新しい `fude-cli` で繋ぎ直す（0.8.18 以降。ホストの端末で打った `fude FILE` の接続には触らない） |
| × | 一覧から外す。`~/.ssh/config` やホスト側のファイルは消さない |

Fude より古い `fude-cli` を使っているホストが繋いでくると、Fude が「k16 の fude-cli（0.8.5）は…古い版です」と
知らせる（ホストごとに起動中 1 回）。そのときに「更新」を押せばよい。

パスワード入力なしで `ssh HOST` できること（鍵認証・Tailscale SSH など）が前提。画面からパスワードは聞けない。

### 毎回

```bash
ssh k16                      # 普通にログインする（この時点で裏で転送が張られる）
fude-cli notes.md            # 手元の Fude に「k16:/home/you/notes.md」のタブが開く。プロンプトはすぐ戻る
fude-cli --wait notes.md     # タブを閉じるまで待つ（k16 側の $EDITOR にするならこちら）
fude-cli --check             # 手元の Fude にどの経路で届いているか確認
```

開いた先は端末に出る（`fude-cli: opened in Fude 0.8.9 on home`）。Fude を開いたまま忘れていた別の PC に
開いてしまっても、ここで気づける。

#### 複数の PC の Fude が応答するとき

同じホストをセットアップした PC が 2 台以上あり、そのどれもが Fude を起動して ssh で繋いでいる場合、
`fude-cli` は一覧を出して番号を聞く。

```
fude-cli: Fude answers on 2 machines:
  1) gpdmd
  2) home
Open on which? [1-2, Enter = 1] (skip this with --to NAME or FUDE_TO=NAME):
```

- `fude-cli --to gpdmd notes.md` … 聞かれずにその PC へ開く
- `export FUDE_TO=gpdmd` … そのシェルではずっとその PC へ開く（`.bashrc` に書かず、セッションごとに決めるのが無難）
- 端末が無いとき（スクリプトから `$EDITOR` として呼ばれた等）は聞けないので、最後にセットアップした PC へ開き、その旨を出す
- 名前は各 PC のホスト名（セットアップ時に `as home` と表示される）。`fude-cli --check` で応答している PC を一覧できる

応答するのが 1 台だけなら、何も聞かずにその PC へ開く。どの PC から ssh したセッションかは、ホスト側からは
分からない（Tailscale SSH は接続元の情報をセッションに渡さない）ので、自動では選べない。

コマンド名は `fude-cli`（ハイフン）。ssh 先にも Fude 本体（0.8.5 以降）を入れてある場合は、画面が無いことを検出して
`fude notes.md` が `fude-cli notes.md` と同じ動きになる（`fude cli notes.md` と空白で打っても同じ）。
古い Fude 本体が入っているホストで `fude FILE` と打つと、ウィンドウを開こうとして `Failed to initialize GTK` で落ちる。

- 転送は ssh の接続に付いている。接続共有が入っていれば、どのセッションからでも届き、全部閉じても 10 分は残る
- 公開されるのは `fude-cli` に渡したファイルの親ディレクトリ（ディレクトリを渡した場合はその配下）だけ
- 手元の Fude が起動していないと `fude-cli notes.md` は端末内ビューアに切り替わる

### 仕組み（知らなくても使える）

ssh が k16 のループバックのポート（PC ごとの番号）を手元の `~/.config/fude/gui.sock` へ転送する。
k16 の `fude-cli` は `~/.config/fude/guis/` に登録された各 PC のポートに繋ぎ、その PC の鍵を見せてから
「このファイルを開いて」と頼む。以後、手元の Fude からの読み書き要求に `fude-cli` が答える。このポートは k16 上の他のユーザからも
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

**`tailscale ssh k16` で入る場合**も同じように使える。`tailscale ssh` は ssh に `k16` ではなく
MagicDNS 名（`k16.<tailnet>.`）を渡すので、`Host k16` の設定だけでは転送が効かない。
`fude setup k16` は Tailscale が動いていればその名前を調べ、同じ設定の `Host` ブロックをもう 1 つ書く。
以前の版でセットアップした場合は、`fude setup k16` をもう一度実行すれば追加される。

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

### `fude bridge` を打たずに済ませる（「リモート接続」画面の「WSL 連携」）

Windows 版の Fude に、この中継を任せることもできる（オプション、既定はオフ）。
**メニュー「ファイル」→「リモート接続…」→「ホストの端末から開けるようにする（任意の設定）」→「WSL 連携」** でディストリビューションを選ぶ。

- 選んだ時点と、以後 Fude を起動するたびに、Fude がその WSL の中で `fude bridge` を起動する。Fude を終了すると止まる。
  `fude bridge` を自分で打つ必要はなく、WSL を再起動したあとも Fude を起動し直せば戻る
- WSL に Fude をインストールしておく必要もない。Fude が自分と同じ版の `fude-cli` を GitHub Releases から
  `~/.cache/fude/fude-cli-<版>` に取得する（初回だけ。WSL から GitHub に出られることが前提）。
  WSL に `fude-cli` コマンドが無ければ `~/.local/bin/fude-cli` にリンクも張るので、WSL で `fude-cli FILE` と打てる
- オンの間は、同じ画面の「セットアップ」「接続確認」「更新」が **WSL の ssh**（WSL の `~/.ssh/config`）で実行される。
  ssh は WSL から張るものなので、設定もそちらに入る必要があるため
- 状態は選択欄の横に出る。「動作中」「準備中（取得中）」のほか、止まっている場合はその理由
  （例: `gui.sock is in use` = WSL の Fude か手動の `fude bridge` が動いている）
- 既定のディストリビューションとは限らないので、ふだん作業しているものを選ぶ（`wsl -l -v` で確認できる）
- Fude を起動すると WSL も起動する。WSL を使わないときにそれが困るならオフのままにして、必要なときに `fude bridge` を打つ

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
| `FUDE_GUI_TOKEN` | fude-cli | 鍵（指定が無ければ `~/.config/fude/guis/<ポート>` のもの、それも無ければ `~/.config/fude/gui-token`） |
| `FUDE_TO` | fude-cli | 複数の PC の Fude が応答するときに開く先の PC 名（`--to NAME` と同じ） |
| `FUDE_HOST` | fude-cli | GUI に名乗るホスト名（既定はマシンのホスト名。タブに `host:/path` と出る） |

`fude-cli` が GUI を探す順: `FUDE_GUI_SOCK` → `FUDE_GUI_ADDR` → `~/.cache/fude/gui/*.sock`（Unix ソケット転送）→
`127.0.0.1:47821` → ローカルの `~/.config/fude/gui.sock`。

## 6. 困ったとき

| 症状 | 見るところ |
| --- | --- |
| `fude-cli` が端末内エディタになってしまう | 手元で Fude が起動しているか（Windows の Fude で受けるなら WSL で `fude bridge` が動いているか）。`fude-cli --check` で経路を確認 |
| `fude bridge`: `gui.sock is in use` | WSL の Fude（または別の bridge）が動いている。どちらか一方にする。「リモート接続」画面の「WSL 連携」をオンにしているなら、手動の `fude bridge` は不要 |
| 「WSL 連携」が「停止中: curl: …」 | WSL から GitHub Releases を取得できない。ネットワークを確認するか、WSL に Fude を入れて `fude bridge` を使う |
| `fude bridge` 経由で `no Fude GUI on Windows answers` | Windows の Fude が起動していない |
| `remote agents must present the GUI token` | 鍵が違う。`fude setup <host>` をやり直すか `~/.config/fude/gui-token` を手元のものと揃える |
| `tcp://127.0.0.1:47821: Connection refused` | ssh の転送が張られていない。`~/.ssh/config` の `RemoteForward` 行と、`ssh` でログインし直したか。`tailscale ssh <host>` で入っているなら `fude setup <host>` をやり直す（Tailscale の名前用の設定が追加される） |
| セットアップで `Could not resolve hostname k16` | その PC の ssh が `k16` という名前を引けない（WSL が自前の DNS 設定を使っていて Tailscale の短い名前が通らない、など）。相手が Tailscale 上にいれば、Fude 0.8.8 以降の `fude setup` が `~/.ssh/config` の `Host k16` に `HostName`（Tailscale の名前、引けなければアドレス）を自動で足す。Tailscale 以外なら `Host k16` の下に `HostName <アドレス>` を自分で書く |
| セットアップで `Host key verification failed` | その PC の ssh が相手にまだ一度も繋いだことがなく、「この鍵を信用するか」の質問にセットアップが答えられない（`tailscale ssh` でしか入ったことがない PC で起きる）。端末で一度 `ssh k16` を実行して `yes` と答えてから、セットアップをやり直す。相手が Tailscale SSH を動かしていれば、Fude 0.8.9 以降の `fude setup` は Tailscale が保証するホスト鍵を `~/.ssh/known_hosts` に自動で登録する |
| 別の PC で開いてしまう／2 台目の PC から使うと TUI になる | 0.8.8 以前のセットアップは全 PC が同じポートと鍵を使う。使う PC すべてを 0.8.9 以降にして、それぞれでセットアップ（「リモート接続」画面の「更新」）をやり直す。以後は `fude-cli` が開いた先を表示し、複数応答するときは選べる |
| `remote port forwarding failed for listen port 47821` | 接続共有が無い状態で同じホストへ ssh を複数本張ると出る（転送を持てるのは最初の 1 本だけ）。`fude setup k16` をやり直すと接続共有が入り、解消する。共有を入れる前から開いていたセッションは閉じて入り直す。他人や別のソフトが 47821 を使っている場合は `fude setup k16 --port 47822` で別ポートに |
| Fude 側に「k16 との接続が切れました」 | ssh を閉じた／`fude-cli` を止めた。タブは残り、未保存分は暫定保存にある。繋ぎ直してもう一度開く（「リモート接続」画面から開いた接続は、回線が切れただけなら自動で繋ぎ直す） |
| ssh 先で `Failed to initialize gtk backend` | `fude`（GUI 本体）を画面の無いホストで起動した。`fude-cli FILE` を使う（Fude 0.8.5 以降の `fude FILE` は自動で `fude-cli` に切り替わる） |
| `fude --wait` が戻らない | そのタブを閉じる（Ctrl+Shift+W）。Fude を終了しても戻る |
