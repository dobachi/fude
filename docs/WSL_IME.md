# WSL(WSLg) で日本語入力の変換候補が離れた場所に出る

## 症状

WSLg 上で Linux 版 Fude（`fude` のネイティブ GUI）を使うと、日本語入力中の**変換候補ウィンドウが入力位置から遠く離れた場所**（画面左上寄り）に表示される。

見分け方: **ウィンドウを画面の左上隅に寄せると候補が正しい位置に出る**なら、この問題です。
候補ウィンドウの位置がウィンドウの表示位置ぶんズレている、という状態です。

## 原因

Fude や CodeMirror のバグではなく、**入力メソッド(IM)側の構成**の問題です。2 段構えになっています。

1. **Wayland には通常のクライアント向けのグローバル座標系が無い**。Wayland クライアントは
   自分のウィンドウが画面のどこにあるかを知り得ないので、IM に渡せる caret 座標は実質
   ウィンドウ内相対になる。
2. **fcitx4 は Wayland 非対応**で、候補ウィンドウを X11 ウィンドウとしてスクリーン絶対座標に
   置こうとする。そこへウィンドウ相対の座標が渡るため、ウィンドウの表示位置ぶんズレる。

WSLg は `WAYLAND_DISPLAY` を設定するため、GTK3 アプリ（webkit2gtk = Fude もこれ）は既定で
Wayland クライアントとして起動します。そこに fcitx4 を組み合わせると必ずこの症状になります。

## 解決策: fcitx5 へ移行する（推奨）

fcitx5 の GTK IM モジュールは、候補ウィンドウを**アプリのプロセス内でクライアント描画し、
アプリのウィンドウに紐づく子ポップアップとして出す**ため、グローバル座標が不要になります。
Wayland クライアントのままで位置が正しくなります。

```bash
sudo apt-get install fcitx5 fcitx5-mozc fcitx5-frontend-gtk3 fcitx5-module-wayland fcitx5-config-qt
```

> fcitx5 を入れると **fcitx4 は自動的に削除されます**（共存不可）。実行中の GUI アプリは
> 一度 IME を失うので、切り替え後に再起動してください。

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

## 代替策: X11(XWayland) で起動する

fcitx5 に移行できない場合、Fude を XWayland クライアントとして起動しても直ります。
アプリ側が Wayland を降りることで座標系が揃うためです。

```bash
GDK_BACKEND=x11 fude
```

ただしこれは対症療法です。IM 側の構成は直らないので **他の Wayland アプリでは症状が残り**、
Wayland 側の利点（HiDPI・スケーリング・WSLg 統合）も失います。fcitx5 への移行を優先してください。

**Fude 本体はこの環境変数を自動設定しません。** 正しく構成された環境にまで X11 経路を
押し付けることになるためです。

## それでも直らないときの切り分け

| 手順 | 分かること |
|---|---|
| ウィンドウを画面左上へ寄せて入力 | 位置が合う＝本ドキュメントの症状（座標系の不一致） |
| `GDK_BACKEND=x11 fude` で起動 | 直る＝Wayland 起因で確定 |
| `gedit` など素の GTK3 アプリで入力 | 同様に崩れる＝環境要因／Fude だけ崩れる＝アプリ側の疑い |
| マルチモニタ・表示スケーリングを変更 | 変化する＝WSLg のポップアップ座標問題（[wslg#551](https://github.com/microsoft/wslg/issues/551) / [wslg#1226](https://github.com/microsoft/wslg/issues/1226)）の寄与 |

上記をすべて試しても入力欄から離れる場合は、Tauri v2 + WebKitGTK 側の caret rect 報告の問題
（[tauri#11412](https://github.com/tauri-apps/tauri/issues/11412)、
[#8264](https://github.com/tauri-apps/tauri/issues/8264)、
[#5986](https://github.com/tauri-apps/tauri/issues/5986)）の可能性があります。

回避策として、Fude には `fude-browser`（ブラウザモード）と `fude-remote`（Windows 版を取得して起動）
も用意されています。

## 検証済み環境

2026-08-08 に以下の実機で確認しました。

| 項目 | 値 |
|---|---|
| WSLg | 1.0.73.2 |
| ディストロ | Ubuntu 22.04 (ja_JP.UTF-8) |
| webkit2gtk | 2.50.4 |
| 問題があった構成 | fcitx 4.2.9.8 + fcitx-mozc |
| 解決した構成 | fcitx5 5.0.14 + fcitx5-mozc + fcitx5-frontend-gtk3（`--disable=wayland,waylandim`） |

確認結果:

| 構成 | 変換候補の位置 |
|---|---|
| fcitx4 + Wayland クライアント | ❌ ウィンドウ位置ぶんズレる |
| fcitx4 + `GDK_BACKEND=x11` | ✅ 正しい |
| fcitx5 + Wayland クライアント | ✅ 正しい（**推奨構成**） |

## 参考

- [Using Fcitx 5 on Wayland — Fcitx](https://fcitx-im.org/wiki/Using_Fcitx_5_on_Wayland) — グローバル座標が無い件、クライアント側描画、コンポジタ別の対応状況、XWayland は X11 と同等である旨
- [WSLg Architecture — Windows Command Line](https://devblogs.microsoft.com/commandline/wslg-architecture/) — Weston + RDP RAIL 構成
- [fcitx5#303](https://github.com/fcitx/fcitx5/issues/303) / [fcitx5#604](https://github.com/fcitx/fcitx5/issues/604) — Wayland 上での候補位置不正
