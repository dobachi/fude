# WSL(WSLg) で日本語入力がおかしい（候補がズレる / そもそも入力できない）

## 症状

WSLg 上で Linux 版 Fude（`fude` のネイティブ GUI）を使うと、日本語入力が次のどちらかの形で壊れる。

| パターン | 見え方 | 典型的な IM |
|---|---|---|
| **A: 候補位置ズレ** | 変換候補ウィンドウが入力位置から遠く離れた場所（画面左上寄り）に出る。**ウィンドウを画面左上隅に寄せると位置が合う** | fcitx4 |
| **B: 入力できない** | 未確定文字（下線部）が更新されない／1文字目しか出ない。変換候補ウィンドウがそもそも出ない・反応しない | uim |

どちらも**「重い」わけではありません**。プレビューを閉じてエディタのみ表示にしても改善しないなら、
描画コストではなく本ドキュメントの問題です。

## 原因

Fude や CodeMirror のバグではなく、**Wayland 非対応の入力メソッド(IM)を WSLg の Wayland
クライアントに組み合わせている**ことが原因です。2 段構えになっています。

1. **Wayland には通常のクライアント向けのグローバル座標系が無い**。Wayland クライアントは
   自分のウィンドウが画面のどこにあるかを知り得ないので、IM に渡せる caret 座標は実質
   ウィンドウ内相対になる。
2. **Wayland 非対応の IM は候補ウィンドウを X11 ウィンドウとしてスクリーン絶対座標に置こうとする**。
   そこへウィンドウ相対の座標が渡るため破綻する。
   - **fcitx4** は座標がズレた位置に候補を出す（パターン A）。
   - **uim** は Wayland 以前の実装で、`gtk_window_move()` が無効化される Wayland 下では
     候補ウィンドウを置けず、preedit の同期も維持できない。結果として「出ない・更新されない」
     というより重い壊れ方をする（パターン B）。

WSLg は `WAYLAND_DISPLAY` を設定するため、GTK3 アプリ（webkit2gtk = Fude もこれ）は既定で
Wayland クライアントとして起動します。そこに Wayland 非対応の IM を組み合わせると必ずこうなります。

## まず切り分ける

X11(XWayland) クライアントとして起動すると座標系が揃うので、直れば本件で確定です。

```bash
GDK_BACKEND=x11 fude
```

これで候補が正しい位置に出る／入力できるようになるなら、原因は IM 側の構成です。
恒久対策は次の fcitx5 移行になります。

## 解決策: fcitx5 へ移行する（推奨）

fcitx5 の GTK IM モジュールは、候補ウィンドウを**アプリのプロセス内でクライアント描画し、
アプリのウィンドウに紐づく子ポップアップとして出す**ため、グローバル座標が不要になります。
Wayland クライアントのままで位置が正しくなります。

```bash
sudo apt-get install fcitx5 fcitx5-mozc fcitx5-frontend-gtk3 fcitx5-module-wayland fcitx5-config-qt
```

> fcitx5 を入れると **fcitx4 は自動的に削除されます**（共存不可）。実行中の GUI アプリは
> 一度 IME を失うので、切り替え後に再起動してください。
>
> 一方 **uim とは共存できます**（パッケージが競合しない）。uim 環境から移る場合はアンインストール
> せず、環境変数の切り替えだけで移行するのが安全です。fcitx5 が動かなければ `~/.profile` を
> 戻すだけで uim に復帰できます。

### ⚠️ WSLg では wayland アドオンの無効化が必須

**fcitx5 は素で起動すると WSLg 上では即座に終了します。**

```
$ fcitx5
... All display connections are gone, exit now.
```

WSLg のコンポジタ（Weston）に対して fcitx5 の wayland アドオンが接続を維持できないためです
（Weston は `text-input-v1` / `zwp_input_method_v1` 止まりで、fcitx5 が期待する
`text-input-v3` / `zwp_input_method_v2` に達していない）。切り分け結果:

| 起動オプション | 結果 |
|---|---|
| `fcitx5 --disable=wayland,waylandim` | ✅ 正常に常駐 |
| `fcitx5 --disable=xcb,xim` | ❌ 即終了（Wayland 接続が維持できない） |

したがって **`--disable=wayland,waylandim` を付けて X 側だけで動かします**。これを付けないと
「fcitx5 を入れたのに日本語入力が全く効かない」状態になります。

### シェル設定

`~/.profile`（`~/.bashrc` にも同じ記述がある場合は両方）を次のようにします。

```bash
export GTK_IM_MODULE=fcitx5
export QT_IM_MODULE=fcitx5
export XMODIFIERS=@im=fcitx5
# fcitx4 固有の DefaultIMModule は不要なので削除する

# 自動起動（--disable=wayland,waylandim を必ず付ける）
(fcitx5 --disable=wayland,waylandim -d > /dev/null 2>&1 &)
```

fcitx5 公式は「Wayland ではネイティブの text-input-v3 に任せるため `GTK_IM_MODULE` を設定するな」
と案内していますが、**WSLg では Weston に text-input-v3 が無いので当てはまりません**。
ここでは明示的に `fcitx5` を指定するのが正解です。

設定反映後、GUI アプリは新しいシェルから起動し直してください。

## 代替策: X11(XWayland) のまま使い続ける

fcitx5 に移行できない場合、上の切り分けで使った `GDK_BACKEND=x11 fude` をそのまま常用しても
一応使えます。アプリ側が Wayland を降りることで座標系が揃うためです。

ただしこれは対症療法です。IM 側の構成は直らないので **他の Wayland アプリでは症状が残り**、
Wayland 側の利点（HiDPI・スケーリング・WSLg 統合）も失います。fcitx5 への移行を優先してください。

uim の場合、XWayland に逃がしても **preedit が二重に描かれる**ことがあります（エディタ内の
on-the-spot preedit と、IM 側が重ねて出す preedit ウィンドウ）。これも fcitx5 移行で解消します。

**Fude 本体はこの環境変数を自動設定しません。** 正しく構成された環境にまで X11 経路を
押し付けることになるためです。

## それでも直らないときの切り分け

| 手順 | 分かること |
|---|---|
| `GDK_BACKEND=x11 fude` で起動 | 直る＝Wayland 起因で確定 |
| ウィンドウを画面左上へ寄せて入力 | 位置が合う＝パターン A（座標系の不一致） |
| プレビューを閉じてエディタのみ表示にする | 変わらない＝描画コストではなく IM 側の問題 |
| `env \| grep -E 'GTK_IM_MODULE\|XMODIFIERS'` | どの IM が使われる構成かを確認（`uim` ならパターン B） |
| `ps -ef \| grep -E 'fcitx\|uim\|ibus'` | IM デーモンがそもそも起動しているか |
| `gedit` など素の GTK3 アプリで入力 | 同様に崩れる＝環境要因／Fude だけ崩れる＝アプリ側の疑い |
| マルチモニタ・表示スケーリングを変更 | 変化する＝WSLg のポップアップ座標問題（[wslg#551](https://github.com/microsoft/wslg/issues/551) / [wslg#1226](https://github.com/microsoft/wslg/issues/1226)）の寄与 |

上記をすべて試しても入力欄から離れる場合は、Tauri v2 + WebKitGTK 側の caret rect 報告の問題
（[tauri#11412](https://github.com/tauri-apps/tauri/issues/11412)、
[#8264](https://github.com/tauri-apps/tauri/issues/8264)、
[#5986](https://github.com/tauri-apps/tauri/issues/5986)）の可能性があります。

回避策として、Fude には `fude-browser`（ブラウザモード）と `fude-remote`（Windows 版を取得して起動）
も用意されています。

## 検証済み環境

いずれも Ubuntu 22.04 (ja_JP.UTF-8) / WSLg 1.0.73.2 / webkit2gtk 2.50.4 の実機です。

### パターン A（候補位置ズレ）— 2026-08-08

| 構成 | 変換候補の位置 |
|---|---|
| fcitx 4.2.9.8 + fcitx-mozc、Wayland クライアント | ❌ ウィンドウ位置ぶんズレる |
| fcitx 4.2.9.8 + `GDK_BACKEND=x11` | ✅ 正しい |
| fcitx5 5.0.14 + fcitx5-mozc + fcitx5-frontend-gtk3、Wayland クライアント | ✅ 正しい（**推奨構成**、`--disable=wayland,waylandim`） |

### パターン B（入力できない）— 2026-08-12

| 構成 | 入力の可否 |
|---|---|
| uim 1.8.8 + uim-mozc、Wayland クライアント | ❌ preedit が更新されない（1文字目のみ）／候補ウィンドウが出ない |
| uim 1.8.8 + uim-mozc、`GDK_BACKEND=x11` | ⚠️ 入力可・候補位置も正しいが、preedit が二重に描かれる |

なお同じ環境で `libEGL warning: failed to open /dev/dri/renderD128` が出る場合、ユーザーが
`render` グループに属しておらず WebKit が GPU を使えていません。IME とは無関係ですが体感速度に
効くので `sudo usermod -aG render $USER`（反映に `wsl --shutdown` が必要）で直せます。

## 参考

- [Using Fcitx 5 on Wayland — Fcitx](https://fcitx-im.org/wiki/Using_Fcitx_5_on_Wayland) — グローバル座標が無い件、クライアント側描画、コンポジタ別の対応状況、XWayland は X11 と同等である旨
- [WSLg Architecture — Windows Command Line](https://devblogs.microsoft.com/commandline/wslg-architecture/) — Weston + RDP RAIL 構成
- [fcitx5#303](https://github.com/fcitx/fcitx5/issues/303) / [fcitx5#604](https://github.com/fcitx/fcitx5/issues/604) — Wayland 上での候補位置不正
