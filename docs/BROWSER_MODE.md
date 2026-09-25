# ブラウザモードのセキュリティ

`fude-browser` / `make browser` / `fude-remote` が起動する HTTP サーバ
（`scripts/serve.js`）は、Tauri 版と**同じ権限でファイルを読み書きする API** を
公開します。`read_file` / `write_file` には任意の絶対パスを渡せるので、この
エンドポイントに到達できる相手は、そのまま**あなたのホームディレクトリを
読み書きできる**ということです。

以下はその前提で設計された防御です。

## 既定の動作

| 項目                 | 既定値（ローカル）          | 変更方法                        |
| -------------------- | --------------------------- | ------------------------------- |
| バインドアドレス     | `127.0.0.1`（ループバック） | `--listen` / `FUDE_HOST`        |
| ポート               | `3000`                      | `--port` / `FUDE_PORT`          |
| API 認証             | トークン必須                | `FUDE_TOKEN`                    |
| 接続を許す範囲       | ループバックのみ            | `--allow` / `FUDE_ALLOW`        |
| ファイルアクセス範囲 | 制限なし（Tauri 版と同等）  | `--root` / `FUDE_ROOT`          |
| 許可するホスト名     | IP リテラルと `localhost`   | `--allowed-hosts`               |
| TLS                  | 無効（ループバックのため）  | `--tls` / `--tls-cert`          |

`fude-browser --help` で全オプションが出ます。

### 1. ループバックのみにバインドする

既定では `127.0.0.1` だけで待ち受けます。同じ Wi-Fi にいる端末からは接続
できません。WSL の `localhost` 転送を使う `fude-remote` はこの設定のままで
動作します。

### 2. すべての `/api/*` にトークンを要求する

起動時にサーバがセッショントークンを発行し、URL に載せて表示します。

```
  Fude (browser mode) running at:

    http://localhost:3000/?token=9f2c...（64桁）
```

**この URL をそのまま開いてください。** フロントエンドはトークンを
`sessionStorage` に移し、アドレスバーからは削除します（履歴や Referer に
残さないため）。以降のリクエストは `X-Fude-Token` ヘッダで送られます。

トークンは `~/.config/fude/browser-token`（パーミッション 0600）に保存され、
再起動しても変わりません。ブックマークした URL はそのまま使えます。
無効化したいときはこのファイルを削除して再起動してください。

`FUDE_TOKEN` を設定すると、その値が使われます（`fude-remote` はこの方法で
起動前にトークンを決めています）。

### 3. 別サイト・DNS リバインディングを拒否する

- レスポンスに `Access-Control-Allow-Origin: *` を付けません。以前は付いて
  いたため、閲覧中の**任意の Web サイト**が `localhost:3000` の API を呼んで
  結果を読めました。
- `Origin` ヘッダがある場合、`Host` と一致しなければ 403 を返します。
- `Host` ヘッダのホスト名は、IP リテラル（リバインドできない）と `localhost`
  のみ許可します。攻撃者が用意したドメイン名は 403 になります。
- `/api/*` は POST のみ。`<img>` や `<script>` からの GET では何も起きません。

### 4. 静的ファイルは `dist/` の外に出さない

`/../../../../etc/hostname` のようなパスは 403 になります。

## リモート公開（スマホなど別端末から開く）

**範囲（どこから）**と**鍵（誰が）**を別々に指定します。両方を満たさないと
1バイトも返しません。

```bash
# LAN のプライベートアドレス範囲から、~/notes だけを開く
fude-browser --listen 0.0.0.0 --allow lan --root ~/notes

# 範囲を具体的に絞る
fude-browser --listen 0.0.0.0 --allow 192.168.1.0/24 --root ~/notes

# Tailscale 経由のみ
fude-browser --listen 0.0.0.0 --allow tailscale --root ~/notes
```

`make browser-lan ROOT=~/notes` / `make browser-tailscale ROOT=~/notes` でも
同じことができます。

### 起動が拒否される条件

うっかり全開放が起きないよう、**構造的に**塞いであります。

| 状況 | 結果 |
| ---- | ---- |
| `--listen` が非ループバックで `--allow` が無い | 起動拒否 |
| `--listen` が非ループバックで `--root` が無い | 起動拒否（`--i-know-what-im-doing` で明示的に外せる） |
| `--allow` に解釈できない値がある | 起動拒否（黙って無視しない） |
| `--key` が16文字未満 | 起動拒否 |

### 5つの関門

| # | 関門 | 通らないとき |
| - | ---- | ------------ |
| 1 | 接続元IPが `--allow` の範囲内か | **TCPレベルで切断**（HTTPを喋る前。ポートが開いているようにも見えない） |
| 2 | `Host` ヘッダ検証 | 403 |
| 3 | `Origin` 同一性 | 403 |
| 4 | **リモート接続は `--key` のみ受理** | 401 |
| 5 | IP単位の失敗ロックアウト | 429（`Retry-After` 付き） |

関門1は `X-Forwarded-For` を**信用しません**。TCP接続の実際の送信元だけを見ます。
設定ミスで誰も繋がらないときのために、拒否した接続はサーバ側のコンソールに
出ます（同一IPにつき最大1分に1回）。

```
  rejected 10.255.255.254 (not in --allow)
  rejected 192.168.1.50 (bad key)
```

関門4が重要です。`~/.config/fude/browser-token`（ローカル用の永続トークン）は
**リモート接続では一切受理しません**。ディスク上に残り続ける長寿命の秘密が
一度漏れただけで恒久的なリモートアクセス権になる、という事態を防ぐためです。
リモート鍵は永続化せず、プロセスが終われば無効になります。

### `--allow` の書き方

- CIDR: `192.168.1.0/24`, `10.0.0.5/32`, `fd00::/8`
- 素のアドレス（= `/32` や `/128` 扱い）: `192.168.1.42`
- カンマ区切りで併記: `--allow 192.168.1.0/24,tailscale`
- プリセット:
  - `lan` — `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `fc00::/7`, `fe80::/10`
  - `tailscale` — `100.64.0.0/10`, `fd7a:115c:a1e0::/48`
  - `localhost` — `127.0.0.0/8`, `::1/128`

IPv4クライアントがデュアルスタックのソケットに `::ffff:192.168.1.5` として
現れても、IPv4のルールで正しく照合します。

### 鍵の渡し方

```bash
# 推奨: 省略すると1回だけ表示される鍵が自動生成される（ps に残らない）
fude-browser --listen 0.0.0.0 --allow lan --root ~/notes

# ファイルから
fude-browser ... --key-file ~/.fude-key

# 標準入力から
pass show fude/key | fude-browser ... --key -

# 直接指定（同一マシンの他ユーザに ps で見えるため警告が出ます）
fude-browser ... --key "$(openssl rand -hex 24)"

# 環境変数
FUDE_KEY="$(openssl rand -hex 24)" fude-browser ...
```

最低16文字。短い鍵は `--allow` の中にいる相手に総当たりされるので起動を拒否します。

### TLS

リモートでは**既定でHTTPS**です。鍵も本文もネットワークを流れるので、平文では
同じ網にいる相手に両方渡ってしまいます。

証明書が無ければ自己署名証明書を自動生成し、`~/.config/fude/cert.pem` に
保存します（SAN にこの端末の全アドレスと `localhost` を含めます）。期限切れ間近か
アドレスが変わったときだけ作り直します。

```
  Certificate:    self-signed (newly generated).
                  Your browser will warn once. Check this first:
                  SHA-256 32:06:97:D5:1D:47:...
```

スマホ側は初回だけ「安全でない接続」の警告が出ます。**この指紋を確認してから**
許可してください。自前の証明書を使うなら `--tls-cert` / `--tls-key`、
SSHトンネルや Tailscale の内側で使うなら `--no-tls` です。

`openssl` が無い環境では自動生成に失敗します。その場合は `--tls-cert` で
持ち込むか `--no-tls` + トンネルを使ってください。

### それでも一番安全なのはトンネル

自己署名証明書は「盗聴は防げるが、相手が本物かは指紋で自分が確認する」方式です。
信頼できないネットワークでは、公開せずにトンネルを張るほうが確実です。

```bash
# 手元の端末から
ssh -L 3000:127.0.0.1:3000 user@wsl-host
# その後 http://localhost:3000/?token=... をローカル同様に開く
```

Tailscale を使っているなら `--allow tailscale` が実質これに近く、
WireGuard で暗号化された経路だけに限定されます。

## 関連する実装

- `scripts/lib/guard.js` — 認可・パス解決の判定ロジック（純粋関数）
- `scripts/lib/netaccess.js` — CIDR照合とロックアウト（純粋関数＋時計注入）
- `scripts/lib/cli.js` — 引数解釈と起動拒否ルール（純粋関数）
- `scripts/lib/selfsigned.js` — 自己署名証明書の生成・再利用
- `scripts/serve.js` — サーバ本体
- `src/js/browser-token.js` — フロントエンド側のトークン受け取り
- `scripts/__tests__/serve-security.test.js` — 実サーバに対する攻撃の再現テスト
- `scripts/__tests__/serve-remote.test.js` — 非ループバック接続に対する関門のテスト
