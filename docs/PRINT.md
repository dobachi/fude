# Fude (筆) - 印刷機能 設計ドキュメント

> 最終更新: 2026-07-20
> ステータス: ドラフト（未実装）
> 関連: プレビュー描画は `src/js/core/preview.js`、キーバインドは `src/js/core/open-shortcuts.js`

---

## 1. 目的とスコープ

「**エディタ / プレビューの見た目通りに印刷したい**」。物理プリンタへの出力と PDF 保存の両方をカバーする。

- **主対象は2つ**: (a) レンダリング済み**プレビュー**の印刷、(b) **エディタ**（ソース＋シンタックスハイライト）の印刷
- **出力**: OS のネイティブ印刷ダイアログを開く方式。プリンタ直と PDF 保存を**同一導線**で賄う（§2 参照）。専用 PDF 生成バックエンドは作らない
- **段階導入（案1）**: まず (a) プレビュー印刷を完成させ、次に (b) エディタ印刷を足す。難所（エディタ側）を後段に置く

---

## 2. 技術方針の根拠（調査結果）

### window.print() は Linux でも動く / PDF も出せる

- Tauri の WebView 層 wry では、**Rust 側 `WebView::print()`（ネイティブ印刷ダイアログ呼び出し）は macOS のみ**。一方 **JS の `window.print()` は全プラットフォームで動作**し、Linux では WebKitGTK 経由で **GTK 印刷ダイアログ**が開く
- GTK 印刷ダイアログには標準で「**ファイルに出力（Print to File）= PDF**」があり、cairo の PDF バックエンドを使うため**プリンタ0台でも PDF を出力できる**。よって「プリンタ直の導線＝PDF 対応」が成立する
- GitHub [tauri#3066](https://github.com/tauri-apps/tauri/issues/3066)（`window.print()` クラッシュ）は **macOS ネイティブ呼び出し**の話でクローズ済み。JS `window.print()` 経路とは別問題
- サイレント印刷・用紙細制御が要る場合のみ `tauri-plugin-printer-v2` 等を検討（本機能では不要）

出典: [wry `WebView::print`](https://docs.rs/wry/latest/wry/struct.WebView.html) / [tauri#4917](https://github.com/tauri-apps/tauri/issues/4917) / [tauri#5330](https://github.com/tauri-apps/tauri/issues/5330)

**残リスク**: WSLg 上で GTK 印刷ダイアログが正しく描画されるか。GTK ダイアログ全般は WSLg で動作するため問題ない見込みだが、実装後に実機で1回確認する（§12）。

---

## 3. 設計原則

| # | 原則 | 理由 |
|---|---|---|
| PR-1 | **ライブ DOM を直接印刷しない**。隠し iframe に「印刷専用ドキュメント」を組み立て、その `contentWindow.print()` を呼ぶ | アプリのメニュー/サイドバー/タブを除外でき、CodeMirror の仮想スクロール（§6.2）を回避でき、ページ分割・余白・背景を専用ドキュメント側だけで制御できる |
| PR-2 | 印刷ドキュメントの**組み立ては純粋関数**（文字列生成）に切り出す | 既存 `core/line-diff.js` / `open-shortcuts.js` と同じ流儀。jsdom でテスト可能 |
| PR-3 | **印刷前に非同期描画（図・ハイライト）の完了を待つ** | 図は placeholder（⏳）→ SVG に遅延置換される。待たずに snapshot すると placeholder が印刷される（§9） |
| PR-4 | 印刷は**常にライトテーマ**で出す | 紙/PDF で暗背景は不適。`data-theme="light"` を強制 |
| PR-5 | プレビュー印刷とエディタ印刷は**同じ印刷パイプラインの入力違い**にする | body の HTML を差し替えるだけで両対応（§5） |

---

## 4. アーキテクチャ

### 4.1 モジュール構成

```
src/js/
  core/
    print-document.js   印刷ドキュメント HTML 文字列の組み立て（純粋・テスト対象）
    open-shortcuts.js   isPrintShortcut を追加（純粋述語）
  features/print/       ← 副作用側。動的 import で遅延ロード
    print.js            オーケストレーション（オフスクリーン描画・iframe 生成・print 呼び出し）
```

`print-document.js`（純粋・DI）:

```js
/**
 * 印刷用の完全な HTML ドキュメント文字列を返す。副作用なし。
 * @param {{ bodyHtml: string, title: string, cssHref?: string, extraCss?: string }} o
 * @returns {string}  <!doctype html> ... の完全文字列
 */
export function buildPrintDocument({ bodyHtml, title, cssHref, extraCss }) { ... }
```

`features/print/print.js`（副作用・DI 可能に）:

```js
createPrinter({
  renderPreviewInto,  // (content, basePath, container, filePath) => Promise<void>  … preview.js の renderPreview
  awaitEnhance,       // (container) => Promise<void>  … 図/ハイライトの完了待ち（§9）
  highlightCode,      // (text, lang) => Promise<string>  … エディタ印刷用（v2）
  doc,                // document
  cssHref,            // 'style.css'
})
// → { printPreview(tab), printEditor(tab) }
```

### 4.2 印刷フロー（プレビュー, v1）

```
ユーザー: Ctrl+P（normalモード） or メニュー「印刷」
        ▼
printPreview(activeTab)
        ▼
オフスクリーンの <div> を生成（画面外・非表示だが実サイズ）      … PR-1
        ▼
renderPreview(tab.content, dirname(tab.path), offscreen, tab.path)  … 常に描画（editorモードでも）
        ▼
awaitEnhance(offscreen)  ← 図(SVG)・コードハイライトの遅延解決を待つ  … PR-3 / §9
        ▼
bodyHtml = offscreen.innerHTML   （この時点でインライン SVG + tok-* span が確定）
        ▼
html = buildPrintDocument({ bodyHtml, title: tab.name, cssHref, extraCss: PRINT_CSS })
        ▼
隠し <iframe> を生成 → srcdoc=html → load 完了を待つ
        ▼
iframe.contentWindow.focus(); iframe.contentWindow.print();
        ▼
afterprint（or フォールバックのタイマ）で iframe とオフスクリーンを破棄
```

---

## 5. プレビュー印刷 (v1)

- **描画元**: `pane.previewContainer.innerHTML` を**当てにしない**。エディタ専用モードではプレビューが未描画（空）だから。必ず自前のオフスクリーン `<div>` に `renderPreview(tab.content, basePath, offscreen, tab.path)` して作る
- **basePath**: 画像の相対パス解決に必要。`tab.path` のディレクトリを渡す（`convertFileSrc` により画像は `asset:` URL 化済みなので iframe でも表示可）
- **図**: Mermaid/PlantUML はこの時点でインライン `<svg>`。iframe に clone しても再現される。ただし §9 の待ち合わせが前提
- **コードハイライト**: `enhancePreview` が `tok-*` span を付与済み。色は `--code-*` CSS 変数で出るので、印刷ドキュメントに `style.css` を読み込ませれば同じ配色になる

---

## 6. エディタ印刷 (v2)

### 6.1 「見た目通り」の程度（要割り切り）

CodeMirror のテーマを厳密再現（`@lezer/highlight` で全行トークン化し CM のスタイルに一致）はコストが高い。**v2 初版は近似**とする:

- エディタバッファ全文を、プレビューが fenced code に使うのと**同じ `highlightCode(text, lang)`** に通して `tok-*` span 化し、等幅フォント・行の折り返し設定で出す
- 言語は現在のドキュメント種別（拡張子）から判定。Markdown なら `markdown` として色付け
- これは「エディタと同系統のハイライト」であり、CM テーマの完全一致ではない。完全一致は将来課題（§16 PR-Q3）

### 6.2 仮想スクロール対策

CodeMirror 6 は**可視行しか DOM に無い**。したがってライブ DOM の clone は不可。`highlightCode` に**バッファ全文**を渡して静的 HTML を自前生成する（PR-1 の iframe 方式が前提）。行番号は任意（オプション）。

### 6.3 オプション

- 行番号 on/off、折り返し on/off は将来の印刷設定に。v2 初版は「折り返しあり・行番号なし」を既定にする

---

## 7. 印刷用ドキュメントと CSS

`buildPrintDocument` が返す骨格:

```html
<!doctype html>
<html data-theme="light">           <!-- PR-4: 常にライト -->
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <link rel="stylesheet" href="${cssHref}" />   <!-- .preview-pane / tok-* / --code-* を流用 -->
    <style>${PRINT_CSS}</style>
  </head>
  <body>
    <div class="preview-pane print-root">${bodyHtml}</div>
  </body>
</html>
```

`PRINT_CSS`（要点）:

```css
@page { margin: 16mm; }
html, body { background: #fff; }
.print-root { max-width: 100%; }

/* 色・背景を紙にも出す（図の塗り、コード背景など） */
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

/* ページ分割の制御 */
pre, .mermaid-diagram, .puml-diagram, img, table { break-inside: avoid; }
h1, h2, h3 { break-after: avoid; }        /* 見出し直後の孤立を防ぐ */
.mermaid-diagram svg, .puml-diagram svg { max-width: 100%; height: auto; }
```

- `style.css` を読み込むのは、`.preview-pane` 配下のタイポグラフィ・`tok-*` 配色・`--code-*` を再利用するため。アプリchrome の CSS も含まれるが、body には `.preview-pane` 内容しか置かないため影響しない
- 背景色を紙に出すか（コードブロックの淡い背景など）は `print-color-adjust: exact` で制御。ユーザー設定で「背景なし印刷」を後で足せる（§16 PR-Q2）

---

## 8. キーバインド・メニュー

### キー

- **`Ctrl+P`（normal モードのみ）** をアプリの印刷にインターセプトする。既存 `isOpenFileShortcut`（`Ctrl+O` を normal 限定で奪う）と**完全に同じ流儀**
  - normal モードでは素の `Ctrl+P` は現状エディタ/ブラウザに素通り。放置するとブラウザが**アプリ全体**を印刷してしまうので、`preventDefault` して自前の `printPreview` に振る
  - **vim / emacs モードでは奪わない**。`Ctrl+P` はエディタキー（emacs=previous-line）。両モードはメニューから印刷する
- `Ctrl+Shift+P` は「パスを開く」で使用済みのため**印刷には使わない**
- 述語 `isPrintShortcut(e, mode)` を `core/open-shortcuts.js` に追加（`mode === 'normal'` 条件込み）

> 補足: emacs には印刷の定番キーが存在せず、メニュー（File → Print 相当）から呼ぶのが慣習。上記の「normal のみキー、vim/emacs はメニュー」はこの慣習とも整合する。

### メニュー

`buildMenuDefinition()` のファイル(F)メニューに追加（全モードから到達＝キーボード/マウス等価）:

```
{ label: '印刷', shortcut: 'Ctrl+P', action: () => printActive() },
```

将来「プレビューを印刷 / エディタを印刷」を分けるなら、表示(V)メニューにサブ項目化する案もある（§16 PR-Q1）。v1 は「現在のビューに応じて印刷対象を決める」= 1項目で開始。

---

## 9. 非同期の待ち合わせ（最重要）

図とコードハイライトは**遅延解決**する（`renderMermaidBlocks`/`renderPlantumlBlocks` は placeholder を先に置き、SVG を後から差し込む。`renderChain` で直列化）。印刷前に完了を待たないと **⏳ プレースホルダが印刷される**。

対策:

- `awaitEnhance(container)` を用意する。`enhancePreview` が返す描画 Promise 群（または renderChain の完了）を待てる形にする。既存コードが Promise を返していなければ、印刷向けに「この container の全 puml/mermaid ブロックが `<svg>` を持つまで待つ」ポーリング/監視を実装する
- タイムアウトを設ける（例 10s）。超過時は placeholder のまま印刷せず、トーストで「図の描画待ちでタイムアウト」を通知して中断
- 図/ハイライトが**無効設定**（既定オフ）のときは待ち不要 → 即 snapshot

---

## 10. テーマ

- 印刷ドキュメントのルートに `data-theme="light"` を固定（PR-4）。現在の画面テーマがダークでも紙はライトで出す
- 図の SVG は描画時のテーマ色を持つ場合がある（Mermaid/PlantUML はテーマごとにキャッシュ）。v1 は「現在テーマで描画済みの SVG をそのまま出す」。ダークテーマで描いた図をライト紙に出すと視認性が落ちうる → §16 PR-Q4 で「印刷時はライトで再描画」を検討

---

## 11. エラー・異常系

| 状況 | 挙動 |
|---|---|
| 空ドキュメント | 見出しのみ/空で印刷（ブロックしない） |
| 図の描画タイムアウト | 印刷中断＋トースト通知（§9） |
| `window.print()` が無反応（WSLg でダイアログ出ない等） | §12 の実機確認事項。フォールバックとして「ブラウザ印刷（アプリ全体）」やプラグイン方式を将来検討 |
| 巨大ドキュメント | オフスクリーン描画のコスト。進捗/スピナーを出す |
| afterprint が発火しない環境 | iframe 破棄はタイマ併用でリーク防止 |

---

## 12. WSLg 実機確認事項（実装後に必ず）

1. `Ctrl+P` → GTK 印刷ダイアログが**表示される**か
2. ダイアログに「**ファイルに出力（PDF）**」があり、PDF が生成されるか
3. 物理プリンタ（あれば）に出力できるか
4. 図（SVG）・コード配色・日本語フォントが紙/PDF で崩れないか
5. `iframe.contentWindow.print()` が iframe 内容のみを印刷するか（アプリ全体でなく）

---

## 13. テスト方針

プロジェクト方針（テストの無い変更は未完成）に従う。

### JS (Vitest)

| ファイル | 対象 |
|---|---|
| `print-document.test.js` | `buildPrintDocument` の純粋テスト: doctype/ライトテーマ/title エスケープ/cssHref 埋め込み/`PRINT_CSS` 適用/bodyHtml がそのまま入ること |
| `open-shortcuts.test.js`（追記） | `isPrintShortcut`: normal で `Ctrl+P` 一致、vim/emacs で不一致、Shift/Alt 付きや他キーで不一致 |
| `print.test.js` | `createPrinter` を全 deps スタブで駆動。**待ち合わせ**を最重要ケースに: `awaitEnhance` が解決してから snapshot されること、タイムアウトで print が呼ばれないこと |

`window.print` / iframe は jsdom で実挙動を検証できないため、`contentWindow.print` はスタブし「呼ばれた/呼ばれない」を確認する。実描画は §12 の手動確認で担保。

---

## 14. 段階導入

| 版 | 内容 |
|---|---|
| **v1** | プレビュー印刷。`Ctrl+P`(normal)＋メニュー。iframe 方式・印刷用 CSS・図/ハイライト待ち合わせ・ライト強制。§12 実機確認 |
| **v2** | エディタ印刷（`highlightCode` で全文ハイライト近似）。印刷対象の選択（現在ビュー準拠 or 明示選択） |
| **v3 以降** | 印刷設定（背景あり/なし・行番号・用紙余白）、印刷時の図ライト再描画、CM テーマ厳密一致 |

---

## 15. 実装チェックリスト（v1）

- [ ] `core/print-document.js` + テスト
- [ ] `core/open-shortcuts.js` に `isPrintShortcut(e, mode)` + テスト
- [ ] `features/print/print.js`（`createPrinter`）+ テスト
- [ ] `awaitEnhance` 相当（preview.js 側に描画完了を待てる口を用意 or 監視実装）
- [ ] `app.js`: 動的 import で printer 初期化、`Ctrl+P`(normal) 配線、メニュー「印刷」追加
- [ ] `style.css` は流用（印刷専用 CSS は `print-document.js` 内の `PRINT_CSS` に閉じる）
- [ ] `make check` green
- [ ] §12 実機（WSLg）確認

---

## 16. Open Issues

| ID | 内容 | 暫定 |
|---|---|---|
| PR-Q1 | 印刷メニューは1項目（現在ビュー準拠）か、「プレビュー印刷 / エディタ印刷」を分けるか | v1 は1項目。将来サブ項目化 |
| PR-Q2 | コードブロック等の**背景色を紙に出す**か | 既定=出す（`print-color-adjust: exact`）。設定で切替を将来 |
| PR-Q3 | エディタ印刷を CM テーマに厳密一致させるか | v2 は近似。厳密一致は v3 |
| PR-Q4 | ダークで描いた図を印刷時に**ライトで再描画**するか | v1 は現状 SVG 流用。視認性問題が出れば再描画 |
| PR-Q5 | `awaitEnhance` を preview.js が Promise で公開するか、印刷側で SVG 出現を監視するか | 実装時に判断（preview.js 改修が軽ければ前者） |
