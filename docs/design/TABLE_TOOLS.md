# 表の支援機能（Table Tools） - デザインドキュメント

## 背景

現在の表機能は「入力・整形」に特化しており、既にモデル層が分離されている:

- **`src/js/core/table.js`**: DOM/CodeMirror 非依存の純粋関数群。モデルは `{ header: string[], align: (null|'left'|'center'|'right')[], rows: string[][] }`。
  - `findTableAt(docText, lineIndex)` → カーソル位置の表ブロック `{ startLine, endLine, model }`
  - `parseTableBlock(lines)` / `formatTable(model)` / `formatTableText(model)`
  - `cellIndexInLine(line, colInLine)` → 行内文字オフセットからセル列番号
  - `navigateTable()`（Tab/Enter セル移動）、`delimitedToModel()`（TSV/CSV ペースト）
- **`src/js/core/editor.js`**: `tableBlockRange(state)` で表ブロックの文字範囲を取得し、`view.dispatch` で置換する薄いラッパ。`tableFormat()` が「整形して差し替え」の既存パターン。
- **`src/js/app.js`**: `openTableGridPicker` / `insertTable`（メニュー「表…」/ Ctrl+Shift+G）。
- **`src/js/core/menu.js`**: `showMenu(x, y, items)`。`items` は `{ label, action, danger?, shortcut?, separator? }`。
- **`src/js/settings.js` + `app.js`**: `config.features.<flag>` によるオプション機能の ON/OFF 機構（`ai_copilot` / `diff_highlight` / `code_highlight` 等と同一パターン）。

### 現在できないこと

- 列単位の並べ替え
- 行のフィルタ（条件に合う行だけ残す）
- 列削除・行削除（モデル経由の安全な削除）

---

## 目的とスコープ

カーソルが表内にあるとき、**破壊的テキスト変換**として以下を提供する。すべて `table.js` の純粋関数として実装し、`editor.js` の既存差し替えパターンで本文へ反映する。

| 機能 | 種別 | 備考 |
|------|------|------|
| 列で並べ替え（昇順/降順） | 破壊的 | 数値/文字列を自動判定して比較。CJK 対応。 |
| 列削除 | 破壊的 | 対象列をモデルから除去して再整形。 |
| 行削除 | 破壊的 | 1 行削除だが、モデル経由で整合を保つ。 |
| フィルタ | 破壊的（**行の一括削除**） | 条件に合わない行を本文から削除。undo で復元可能と割り切る。 |

**オプション化**: `config.features.table_tools`（既定 OFF）で全体を ON/OFF。OFF のときはコンテキストメニューに表操作項目を出さない。既存の表入力・整形（Tab/Enter/整形）は本フラグに関係なく従来通り常時有効。

**非スコープ**: 非破壊プレビュー絞り込み、列の並べ替え（列順の入れ替え）、セル結合、複数条件フィルタ。将来拡張として末尾に記載。

---

## 設計

### 1. `table.js` に追加する純粋関数

いずれも入力 `model` を変更せず新しい `model` を返す（イミュータブル）。列/行インデックスが範囲外なら元と同型のモデルをそのまま返す（no-op）。

```js
/** 指定列を除去した新モデル。最後の1列は削除しない（表が壊れるため no-op）。 */
export function deleteColumn(model, colIdx) { /* ... */ }

/** 指定データ行（0始まり、header は対象外）を除去した新モデル。 */
export function deleteRow(model, rowIdx) { /* ... */ }

/**
 * 指定列で data 行を安定ソートした新モデル。header は動かさない。
 * dir: 'asc' | 'desc'。
 * 比較規則: 両セルが数値としてパース可能なら数値比較、片方でも非数値なら
 *          displayWidth 非依存の localeCompare（CJK 込み）。空セルは常に末尾。
 */
export function sortByColumn(model, colIdx, dir) { /* ... */ }

/**
 * フィルタ述語にマッチする data 行だけ残した新モデル（header は保持）。
 * predicate(cellValue, row, rowIdx) => boolean。
 * UI からは下記 buildRowFilter で生成した predicate を渡す。
 */
export function filterRows(model, predicate) { /* ... */ }

/**
 * フィルタ UI の入力から predicate を生成するヘルパ（これも純粋・テスト可能）。
 * op: 'contains' | 'equals' | 'not_contains' | 'gt' | 'lt' | 'nonempty'
 * 数値比較（gt/lt）は両辺が数値のときのみ真、非数値行は除外。
 * contains/equals は既定で大文字小文字無視（caseSensitive オプションで切替）。
 */
export function buildRowFilter(colIdx, op, value, opts) { /* ... */ }
```

補助（内部関数、export 不要）:

```js
// 数値パース: 前後空白と桁区切りカンマを許容。'' や非数値は null。
function toNumber(s) { /* ... */ }
```

### 2. `editor.js` の配線

既存の `tableFormat(view)` と同じ「範囲取得 → 変換 → dispatch」を踏襲した薄いラッパを追加する。カーソルのセル/行位置は既存関数から求める。

```js
// tableBlockRange(state) は既存。block.model と from/to、cursor を返す。
// カーソルの列: cellIndexInLine(cursorLine, colInLine)
// カーソルのデータ行: ブロック内行番号から header(0)/separator(1) を除いて算出
//   （navigateTable の editRow 算出ロジックを小関数に切り出して共用する）

function tableApply(view, transform) {
  const range = tableBlockRange(view.state);
  if (!range) return false;
  const next = formatTableText(transform(range.block.model));   // 変換後モデルを整形
  if (next !== view.state.sliceDoc(range.from, range.to)) {
    view.dispatch({ changes: { from: range.from, to: range.to, insert: next } });
  }
  return true;
}
```

`app.js` からはカーソル位置（列 index・行 index）を引数に、`tableApply(view, (m) => deleteColumn(m, colIdx))` のように呼ぶ公開関数を `editor.js` に用意する:

```js
export function tableDeleteColumnAtCursor(view) { /* colIdx を算出して tableApply */ }
export function tableDeleteRowAtCursor(view) { /* rowIdx を算出して tableApply */ }
export function tableSortByCursorColumn(view, dir) { /* ... */ }
export function tableFilterByCursorColumn(view, op, value, opts) { /* ... */ }
export function getCursorTableContext(view) {
  // 表内なら { colIdx, rowIdx, numCols, header } を、表外なら null を返す。
  // コンテキストメニュー生成の可否判定と、列名の表示に使う。
}
```

### 3. UI: 表内コンテキストメニュー

`showMenu` を使う。カーソル（またはクリック位置）が表内にあるときだけ表操作項目を追加する。

- **導線**: エディタ上の右クリックで `contextmenu` ハンドラを追加。`features.table_tools` が ON かつ `getCursorTableContext(view)` が非 null のとき、表操作項目を **先頭ブロック**として差し込み、`{ separator: true }` の後に既存の項目（あれば）を続ける。
  - 右クリック位置のセルにカーソルを合わせてから文脈を取ると列判定が直感的（`view.posAtCoords` → 選択更新 → `getCursorTableContext`）。
- **メニュー項目**（列名 `header[colIdx]` を差し込んで分かりやすく）:

```
「<列名>」で並べ替え ▲ 昇順
「<列名>」で並べ替え ▼ 降順
──────────────
「<列名>」でフィルタ…            → サブUIで op/value を入力
──────────────
「<列名>」列を削除               (danger)
この行を削除                    (danger)
```

- **フィルタ入力 UI**: `table-grid.js` と同様の小さなポップオーバー（`table-filter.js` 新規）。
  - 演算子セレクト（含む/一致/含まない/> /< / 空でない）＋値入力＋大小区別チェック。
  - Enter で確定 → `tableFilterByCursorColumn`、Esc で閉じる。Grid ピッカーと同じ「外側クリック/Esc/blur/scroll で閉じる」挙動を流用。
- **最後の列/全行削除の防止**: 列が 1 列のときは列削除を無効化（グレーアウト or 非表示）。フィルタで 0 行になる場合は header + separator は残す（`filterRows` は header を必ず保持）。

### 4. 設定画面

`settings.js` の Features セクションにチェックボックスを 1 つ追加（既存パターン踏襲）:

```html
<label><input type="checkbox" id="setting-table-tools"
  ${config.features?.table_tools ? 'checked' : ''} /> Table Tools（表の並べ替え・フィルタ・列削除）</label>
```

`collectSettings()` に `table_tools: document.querySelector('#setting-table-tools')?.checked` を追加。`app.js` 側は `features` フラグを読むだけ（`plantuml` 等のように `setXxxEnabled` を経由してもよいが、メニュー生成時に `config.features?.table_tools` を直接見れば十分）。Rust 側の `config.rs` に `table_tools` を追加（他フラグと同じ Serde 既定 false）。

---

## テスト方針（CLAUDE.md「テスト必須」準拠）

純粋関数はすべて `src/js/__tests__/table-tools.test.js`（新規）でカバーする。

- `deleteColumn`: 中間列/先頭/末尾、1 列のとき no-op、align も同時に除去されること。
- `deleteRow`: 中間/先頭/末尾、範囲外 no-op、header は不変。
- `sortByColumn`:
  - 文字列昇順/降順、数値列の数値ソート（`"10" > "9"`）、混在列は文字列比較にフォールバック、空セルは末尾、**安定ソート**（同値行の相対順維持）。
  - CJK を含む列で `localeCompare` が破綻しないこと。
- `buildRowFilter` + `filterRows`: contains/equals/not_contains/gt/lt/nonempty、大小区別 ON/OFF、0 行結果でも header/separator が残ること、数値演算で非数値行が除外されること。
- 変換結果が `formatTable` で再整形され、列幅・整列が保たれること（往復テスト: parse→transform→format→parse で構造一致）。

UI/DOM 依存部（メニュー生成・フィルタポップオーバー）は jsdom で軽く検証（`features.table_tools` OFF のとき項目が出ないこと、列名がラベルに入ること）。`editor.js` の `getCursorTableContext` の列/行算出は `navigateTable` 系の既存テストに倣ってオフセット→(colIdx,rowIdx) の単体テストを追加。

---

## 実装ステップ（設計合意後）

1. `table.js`: 純粋関数 5 本 + `toNumber` を追加、`table-tools.test.js` を先に書く（赤→緑）。
2. `editor.js`: `tableApply` と `getCursorTableContext` / `tableXxxAtCursor` を追加。位置算出の単体テスト。
3. `menu` 配線: エディタ `contextmenu` ハンドラ + 表操作項目の生成。
4. `table-filter.js`: フィルタ入力ポップオーバー。
5. `settings.js` / Rust `config.rs`: `features.table_tools` フラグ。
6. `help.js`: ショートカット/操作の説明追記。`make check` green を確認。

---

## 将来拡張（非スコップ・メモ）

- 列順の入れ替え（左右移動）、行の上下移動。
- 非破壊プレビュー絞り込み（`preview.js` にフィルタ状態を渡すオーバーレイ）。
- 複数条件フィルタ（AND/OR）、正規表現フィルタ。
- 列の一括整形（trim / 大文字化など）。
