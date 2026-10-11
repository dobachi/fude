//! The F1 key list, laid out as titled groups with the keys in one aligned
//! column, so a binding is found by looking down a column instead of reading
//! a paragraph.

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;

/// (group title, [(keys, what they do)]).
pub type Section = (&'static str, &'static [(&'static str, &'static str)]);

pub const SECTIONS: &[Section] = &[
    (
        "ファイル",
        &[
            ("Ctrl+S", "保存"),
            ("Alt+T / Alt+N", "新しいタブ"),
            ("Alt+W", "タブを閉じる"),
            ("Alt+] / Alt+[", "次 / 前のタブ"),
            ("Alt+R", "ディスクから読み直す"),
            ("Alt+Q / Ctrl+Q", "終了"),
        ],
    ),
    (
        "表示",
        &[
            ("Alt+J", "エディタのみ"),
            ("Alt+K", "分割（エディタ + プレビュー）"),
            ("Alt+L", "プレビューのみ"),
            ("Alt+E", "ファイル一覧を出す / 隠す"),
            ("F1 / Alt+?", "このキー一覧"),
        ],
    ),
    (
        "編集",
        &[
            ("Ctrl+Z / Ctrl+Y", "元に戻す / やり直す"),
            ("Ctrl+F", "検索"),
            ("Enter", "リストの行頭記号を引き継ぐ"),
        ],
    ),
    (
        "プレビュー（プレビューのみ表示のとき）",
        &[
            ("j / k, ↓ / ↑", "1 行スクロール"),
            ("Ctrl+D / Ctrl+U", "10 行スクロール（PageDown / PageUp）"),
            ("g / G", "先頭 / 末尾（Home / End）"),
        ],
    ),
    (
        "ファイル一覧",
        &[
            ("j / k, ↓ / ↑", "上下に移動"),
            ("Enter / l / →", "ファイルを開く・フォルダを開閉"),
            ("h / ←", "フォルダを閉じる"),
            ("g / G", "先頭 / 末尾"),
            ("Tab / Esc", "エディタに戻る"),
        ],
    ),
    (
        "Vim モード（設定 key_mode = vim）",
        &[
            ("i / Esc", "挿入 / ノーマル"),
            ("u / Ctrl+R", "元に戻す / やり直す"),
            ("/", "検索"),
            ("v", "選択"),
        ],
    ),
];

/// Display width of the widest key cell, so every description starts in the
/// same column.
pub fn key_column_width(sections: &[Section]) -> usize {
    sections
        .iter()
        .flat_map(|(_, items)| items.iter())
        .map(|(keys, _)| UnicodeWidthStr::width(*keys))
        .max()
        .unwrap_or(0)
}

/// The key list as lines: a bold title per group, its bindings indented
/// under it with the keys padded to one column, and a blank line between
/// groups. `vim` says whether Vim mode is on, shown next to that group.
pub fn lines(vim: bool) -> Vec<Line<'static>> {
    let key_w = key_column_width(SECTIONS);
    let title = Style::default()
        .fg(Color::Yellow)
        .add_modifier(Modifier::BOLD);
    let key = Style::default().fg(Color::Cyan);
    let mut out = Vec::new();
    for (i, (name, items)) in SECTIONS.iter().enumerate() {
        if i > 0 {
            out.push(Line::default());
        }
        let mut heading = vec![Span::styled(*name, title)];
        if name.starts_with("Vim") {
            heading.push(Span::raw(if vim { "  ← 有効" } else { "  ← 無効" }));
        }
        out.push(Line::from(heading));
        for (keys, what) in items.iter() {
            let pad = key_w - UnicodeWidthStr::width(*keys);
            out.push(Line::from(vec![
                Span::raw("  "),
                Span::styled(*keys, key),
                Span::raw(" ".repeat(pad + 2)),
                Span::raw(*what),
            ]));
        }
    }
    out
}

/// The widest line of [`lines`], in terminal cells.
pub fn content_width(vim: bool) -> usize {
    lines(vim)
        .iter()
        .map(|l| {
            l.spans
                .iter()
                .map(|s| UnicodeWidthStr::width(s.content.as_ref()))
                .sum()
        })
        .max()
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(l: &Line) -> String {
        l.spans.iter().map(|s| s.content.as_ref()).collect()
    }

    #[test]
    fn every_group_has_a_title_then_its_bindings_then_a_gap() {
        let ls = lines(false);
        let total: usize = SECTIONS.iter().map(|(_, items)| items.len() + 1).sum();
        // One blank line between groups, none before the first or after the last.
        assert_eq!(ls.len(), total + SECTIONS.len() - 1);
        assert_eq!(text(&ls[0]), "ファイル");
        assert!(!text(ls.last().unwrap()).is_empty());
        let mut i = 0;
        for (n, (name, items)) in SECTIONS.iter().enumerate() {
            if n > 0 {
                assert_eq!(text(&ls[i]), "", "gap before {}", name);
                i += 1;
            }
            assert!(text(&ls[i]).starts_with(name));
            for (k, (keys, what)) in items.iter().enumerate() {
                let t = text(&ls[i + 1 + k]);
                assert!(t.starts_with(&format!("  {}", keys)), "{}", t);
                assert!(t.ends_with(what), "{}", t);
            }
            i += items.len() + 1;
        }
    }

    #[test]
    fn descriptions_start_in_one_column_whatever_the_key_text() {
        let key_w = key_column_width(SECTIONS);
        assert!(key_w >= "Ctrl+Z / Ctrl+Y".len());
        for l in lines(true) {
            if l.spans.len() != 4 {
                continue; // a title or a gap
            }
            // indent + keys + padding, measured in cells (arrows are 1 wide
            // by byte count 3, so bytes would not do).
            let before: usize = l.spans[..3]
                .iter()
                .map(|s| UnicodeWidthStr::width(s.content.as_ref()))
                .sum();
            assert_eq!(before, 2 + key_w + 2, "{}", text(&l));
        }
    }

    #[test]
    fn nothing_is_empty_and_the_vim_group_says_whether_it_applies() {
        for (name, items) in SECTIONS {
            assert!(!name.is_empty() && !items.is_empty());
            for (keys, what) in items.iter() {
                assert!(!keys.trim().is_empty() && !what.trim().is_empty());
            }
        }
        let find = |vim| {
            lines(vim)
                .iter()
                .map(text)
                .find(|t| t.starts_with("Vim"))
                .unwrap()
        };
        assert!(find(true).ends_with("有効"));
        assert!(find(false).ends_with("無効"));
        assert!(content_width(false) >= 2 + key_column_width(SECTIONS) + 2);
    }
}
