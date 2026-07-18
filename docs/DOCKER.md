# Docker での動作確認（安全・隔離）

ホストを汚さずに Fude の動作確認を行うための隔離環境です。

## 方針（安全性）

- **ホストのファイルシステムをマウントしない**自己完結イメージ（ソースはビルド時に COPY）。
- 非root ユーザで実行。
- 編集・保存などの操作は、コンテナ内の**使い捨てサンドボックス**(`~/sandbox`)上だけで行う。
- 設定とセッション（`~/.config/fude`）もコンテナ内に閉じるので、**ホストの設定を書き換えない**。
- GUI はコンテナ内の仮想ディスプレイ(Xvfb)で描画し、**noVNC(ブラウザ)** で確認する。ホストの X サーバや GPU には触れない。

## 前提

- Docker（WSL の場合は Docker Desktop の WSL 統合を有効化）。
- 初回の `build` は Tauri 依存のコンパイルを含むため時間がかかります（数分〜十数分）。以降はキャッシュされます。

## 使い方

### GUI で動作確認（noVNC）

```bash
make docker-gui          # = docker compose up --build
# 起動ログに従い、ブラウザで以下を開く:
#   http://localhost:6080/vnc.html
```

ブラウザに Fude のウィンドウが表示され、サンドボックスのサンプル文書が開きます。

サンドボックス (`~/sandbox`) には確認用の題材を入れてあります。

- `index.md` — ファイル間リンク（同階層・下位・上位・アンカー付き・空白入りパス・
  存在しないファイル・外部リンク）、表
- `docs/diagram.md` — Mermaid（同じ図を2つ = キャッシュ経路）と PlantUML。
  拡張が未導入なら描画されないだけで、確認の妨げにはなりません
- `.hidden.md` — 隠しファイル

編集・保存はコンテナ内で完結し、**ホストの `~/.config/fude`（設定・セッション）にも
触れません**。

停止: `Ctrl+C`、または別端末で `docker compose down`。

### ヘッドレスでテスト（GUIなし）

```bash
make docker-test         # Vitest + cargo test
make docker-check        # prettier + eslint + fmt + clippy + 全テスト（CI相当）
```

### コンテナ内シェル

```bash
make docker-shell
```

## モード（entrypoint 引数）

`docker compose run --rm fude <mode>` の `<mode>`:

| mode          | 内容                                           |
| ------------- | ---------------------------------------------- |
| `gui`（既定） | Xvfb + noVNC で GUI 起動、サンドボックスを開く |
| `test`        | Vitest + cargo test                            |
| `check`       | lint + format + clippy + 全テスト              |
| `shell`       | bash                                           |

## トラブルシュート

- **ウィンドウが出ない/真っ黒**: WebKitGTK のヘッドレス描画の問題のことがあります。イメージでは
  `WEBKIT_DISABLE_COMPOSITING_MODE=1` / `WEBKIT_DISABLE_DMABUF_RENDERER=1` / `LIBGL_ALWAYS_SOFTWARE=1` を設定済みです。
  それでも出ない場合は `docker compose run --rm fude shell` で入り `cat /tmp/xvfb.log /tmp/x11vnc.log` を確認してください。
- **日本語が化ける（豆腐）**: コンテナに `fonts-noto-cjk` を導入済みです。古いイメージのままなら `make docker-build` で再ビルドしてください。
- **キーボードが効かない**: Xvfb のキーマップ設定(`setxkbmap us`)・`x11vnc -xkb`・起動後の `xdotool` フォーカスを設定済みです。それでも効かない場合は、**noVNC のウィンドウ内を一度クリック**してフォーカスを与えてください。`cat /tmp/xkb.log /tmp/focus.log` も参考になります。
- **ポート競合**: `6080` が使用中なら `docker-compose.yml` の ports を変更してください。
- **コード変更を反映**: イメージはソースを COPY するため、変更後は `make docker-build`（再ビルド）が必要です。
