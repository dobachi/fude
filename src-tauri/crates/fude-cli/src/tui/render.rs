//! Markdown → styled terminal lines.
//!
//! Pure: takes the source and a width, returns lines already wrapped to that
//! width, each tagged with the source line it came from (for scroll sync and
//! "jump to source" later). Rendering goes through comrak's AST so the same
//! GFM dialect the GUI shows (tables, task lists, strikethrough, wikilinks,
//! front matter) is understood here.

use comrak::nodes::{AstNode, ListType, NodeValue, TableAlignment};
use comrak::{parse_document, Arena, Options};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;

/// One rendered line plus where it came from.
#[derive(Debug, Clone)]
pub struct RenderedLine {
    pub line: Line<'static>,
    /// 1-based line in the Markdown source, 0 for lines that belong to no
    /// block (blank separators).
    pub source_line: usize,
}

#[derive(Debug, Default, Clone)]
pub struct Rendered {
    pub lines: Vec<RenderedLine>,
}

impl Rendered {
    /// Plain text of every line (tests, search).
    #[cfg(test)]
    pub fn plain(&self) -> Vec<String> {
        self.lines
            .iter()
            .map(|l| l.line.spans.iter().map(|s| s.content.as_ref()).collect())
            .collect()
    }

    /// First rendered line at or after source line `n` (scroll sync with
    /// the editor, once there is one).
    #[allow(dead_code)]
    pub fn line_for_source(&self, n: usize) -> usize {
        self.lines
            .iter()
            .position(|l| l.source_line >= n && l.source_line != 0)
            .unwrap_or(self.lines.len().saturating_sub(1))
    }
}

/// The GFM flavour Fude's preview uses, as far as comrak has it.
pub fn options() -> Options<'static> {
    let mut o = Options::default();
    o.extension.strikethrough = true;
    o.extension.table = true;
    o.extension.tasklist = true;
    o.extension.autolink = true;
    o.extension.footnotes = true;
    o.extension.front_matter_delimiter = Some("---".into());
    o.extension.wikilinks_title_after_pipe = true;
    o.extension.math_dollars = true;
    o
}

pub fn render(markdown: &str, width: u16) -> Rendered {
    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &options());
    let mut r = Renderer {
        width: width.max(4) as usize,
        out: Rendered::default(),
    };
    r.blocks(root, &Ctx::default());
    // Drop trailing separator lines.
    while r
        .out
        .lines
        .last()
        .map(|l| l.source_line == 0)
        .unwrap_or(false)
    {
        r.out.lines.pop();
    }
    r.out
}

// ─── Styles ─────────────────────────────────────────────────

fn heading_style(level: u8) -> Style {
    let color = match level {
        1 => Color::Yellow,
        2 => Color::Green,
        3 => Color::Cyan,
        _ => Color::Blue,
    };
    Style::default().fg(color).add_modifier(Modifier::BOLD)
}

fn code_style() -> Style {
    Style::default().fg(Color::Yellow)
}

fn code_block_style() -> Style {
    Style::default().fg(Color::White).bg(Color::Rgb(40, 40, 48))
}

fn dim() -> Style {
    Style::default().add_modifier(Modifier::DIM)
}

fn link_style() -> Style {
    Style::default()
        .fg(Color::Blue)
        .add_modifier(Modifier::UNDERLINED)
}

// ─── Inline runs ────────────────────────────────────────────

/// A styled piece of text before wrapping. `Break` forces a new line.
#[derive(Debug, Clone)]
enum Run {
    Text(String, Style),
    Break,
}

fn collect_inlines<'a>(node: &'a AstNode<'a>, style: Style, runs: &mut Vec<Run>) {
    for child in node.children() {
        let data = child.data.borrow();
        match &data.value {
            NodeValue::Text(t) => runs.push(Run::Text(t.to_string(), style)),
            NodeValue::SoftBreak => runs.push(Run::Text(" ".into(), style)),
            NodeValue::LineBreak => runs.push(Run::Break),
            NodeValue::Code(c) => runs.push(Run::Text(c.literal.clone(), code_style())),
            NodeValue::Emph => collect_inlines(child, style.add_modifier(Modifier::ITALIC), runs),
            NodeValue::Strong => collect_inlines(child, style.add_modifier(Modifier::BOLD), runs),
            NodeValue::Strikethrough => {
                collect_inlines(child, style.add_modifier(Modifier::CROSSED_OUT), runs)
            }
            NodeValue::Underline => {
                collect_inlines(child, style.add_modifier(Modifier::UNDERLINED), runs)
            }
            NodeValue::Link(_) => collect_inlines(child, link_style(), runs),
            NodeValue::WikiLink(w) => {
                runs.push(Run::Text(format!("[[{}]]", w.url), link_style()));
            }
            NodeValue::Image(img) => {
                let mut alt = Vec::new();
                collect_inlines(child, style, &mut alt);
                let alt: String = alt
                    .iter()
                    .filter_map(|r| match r {
                        Run::Text(t, _) => Some(t.as_str()),
                        Run::Break => None,
                    })
                    .collect();
                let label = if alt.is_empty() { img.url.clone() } else { alt };
                runs.push(Run::Text(format!("[image: {}]", label), dim()));
            }
            NodeValue::Math(m) => runs.push(Run::Text(m.literal.clone(), code_style())),
            NodeValue::FootnoteReference(f) => {
                runs.push(Run::Text(format!("[^{}]", f.name), dim()));
            }
            NodeValue::HtmlInline(h) => runs.push(Run::Text(h.clone(), dim())),
            NodeValue::Escaped => collect_inlines(child, style, runs),
            NodeValue::Highlight | NodeValue::Insert => {
                collect_inlines(child, style.add_modifier(Modifier::REVERSED), runs)
            }
            NodeValue::Superscript | NodeValue::Subscript | NodeValue::SpoileredText => {
                collect_inlines(child, style, runs)
            }
            _ => collect_inlines(child, style, runs),
        }
    }
}

/// Greedy word wrap of styled runs into lines no wider than `width`
/// (display columns, so CJK counts double). Breaks at spaces when there is
/// one in reach, else inside the run.
fn wrap_runs(runs: &[Run], width: usize) -> Vec<Vec<Span<'static>>> {
    let mut lines: Vec<Vec<Span<'static>>> = Vec::new();
    let mut cur: Vec<(String, Style)> = Vec::new();
    let mut cur_w = 0usize;

    let flush = |cur: &mut Vec<(String, Style)>, lines: &mut Vec<Vec<Span<'static>>>| {
        let spans = cur
            .drain(..)
            .filter(|(t, _)| !t.is_empty())
            .map(|(t, s)| Span::styled(t, s))
            .collect();
        lines.push(spans);
    };

    for run in runs {
        match run {
            Run::Break => {
                flush(&mut cur, &mut lines);
                cur_w = 0;
            }
            Run::Text(text, style) => {
                let mut piece = String::new();
                for ch in text.chars() {
                    let cw = UnicodeWidthStr::width(ch.to_string().as_str());
                    if cur_w + cw > width {
                        // Try to break at the last space of this line.
                        cur.push((std::mem::take(&mut piece), *style));
                        if let Some((carry, carry_w)) = split_at_last_space(&mut cur) {
                            flush(&mut cur, &mut lines);
                            cur_w = carry_w;
                            for (t, s) in carry {
                                cur.push((t, s));
                            }
                        } else {
                            flush(&mut cur, &mut lines);
                            cur_w = 0;
                        }
                        if ch == ' ' && cur_w == 0 {
                            continue;
                        }
                    }
                    piece.push(ch);
                    cur_w += cw;
                }
                if !piece.is_empty() {
                    cur.push((piece, *style));
                }
            }
        }
    }
    flush(&mut cur, &mut lines);
    if lines.is_empty() {
        lines.push(Vec::new());
    }
    lines
}

/// Move everything after the last space in `cur` out, returning it with its
/// width. `None` when there is no space to break at.
fn split_at_last_space(cur: &mut Vec<(String, Style)>) -> Option<(Vec<(String, Style)>, usize)> {
    for i in (0..cur.len()).rev() {
        if let Some(pos) = cur[i].0.rfind(' ') {
            let mut carry: Vec<(String, Style)> = cur.drain(i + 1..).collect();
            let tail = cur[i].0.split_off(pos + 1);
            cur[i].0.truncate(pos); // drop the space itself
            let style = cur[i].1;
            if !tail.is_empty() {
                carry.insert(0, (tail, style));
            }
            let w = carry
                .iter()
                .map(|(t, _)| UnicodeWidthStr::width(t.as_str()))
                .sum();
            return Some((carry, w));
        }
    }
    None
}

// ─── Blocks ─────────────────────────────────────────────────

/// Where a block sits: indentation and the prefix repeated on each line.
#[derive(Debug, Clone, Default)]
struct Ctx {
    /// Prefix for the first line of the block (e.g. "• ") …
    first: String,
    /// … and for every following line (e.g. "  ").
    rest: String,
    quote_depth: usize,
    /// Inside a tight list item: blocks follow each other without blank lines.
    tight: bool,
}

impl Ctx {
    fn nested(&self, first: &str, rest: &str) -> Ctx {
        Ctx {
            first: format!("{}{}", self.rest, first),
            rest: format!("{}{}", self.rest, rest),
            quote_depth: self.quote_depth,
            tight: self.tight,
        }
    }

    fn quoted(&self) -> Ctx {
        let mut c = self.nested("▎ ", "▎ ");
        c.quote_depth += 1;
        c
    }

    fn prefix_width(&self) -> usize {
        UnicodeWidthStr::width(self.rest.as_str())
    }
}

struct Renderer {
    width: usize,
    out: Rendered,
}

impl Renderer {
    fn push(&mut self, prefix: &str, spans: Vec<Span<'static>>, source_line: usize) {
        let mut all = Vec::with_capacity(spans.len() + 1);
        if !prefix.is_empty() {
            all.push(Span::styled(prefix.to_string(), dim()));
        }
        all.extend(spans);
        self.out.lines.push(RenderedLine {
            line: Line::from(all),
            source_line,
        });
    }

    fn blank(&mut self) {
        if self
            .out
            .lines
            .last()
            .map(|l| l.source_line != 0)
            .unwrap_or(false)
        {
            self.out.lines.push(RenderedLine {
                line: Line::default(),
                source_line: 0,
            });
        }
    }

    /// Remove a trailing separator line (tight lists).
    fn pop_blank(&mut self) {
        while self
            .out
            .lines
            .last()
            .map(|l| l.source_line == 0)
            .unwrap_or(false)
        {
            self.out.lines.pop();
        }
    }

    /// Wrap `runs` into the block's area and emit them with the prefixes.
    fn emit_runs(&mut self, runs: &[Run], ctx: &Ctx, source_line: usize) {
        let inner = self.width.saturating_sub(ctx.prefix_width()).max(1);
        let lines = wrap_runs(runs, inner);
        for (i, spans) in lines.into_iter().enumerate() {
            let prefix = if i == 0 { &ctx.first } else { &ctx.rest };
            self.push(prefix, spans, source_line);
        }
    }

    fn blocks<'a>(&mut self, node: &'a AstNode<'a>, ctx: &Ctx) {
        let mut first_block = true;
        for child in node.children() {
            // Blocks after the first start on a fresh line with the "rest"
            // prefix (list item continuation etc.).
            let c = if first_block {
                ctx.clone()
            } else {
                Ctx {
                    first: ctx.rest.clone(),
                    rest: ctx.rest.clone(),
                    quote_depth: ctx.quote_depth,
                    tight: ctx.tight,
                }
            };
            self.block(child, &c, first_block);
            first_block = false;
        }
    }

    fn block<'a>(&mut self, node: &'a AstNode<'a>, ctx: &Ctx, first_in_parent: bool) {
        // Copy what we need out of the RefCell so the children can be
        // visited (they borrow the same arena) while we match on it.
        let (line, value) = {
            let d = node.data.borrow();
            (d.sourcepos.start.line, d.value.clone())
        };
        match &value {
            NodeValue::Document => {
                self.blocks(node, ctx);
            }
            NodeValue::FrontMatter(text) => {
                for (i, l) in text.trim_end().lines().enumerate() {
                    let spans = vec![Span::styled(l.to_string(), dim())];
                    self.push(&ctx.rest, spans, line + i);
                }
                self.blank();
            }
            NodeValue::Heading(h) => {
                if !first_in_parent && !ctx.tight {
                    self.blank();
                }
                let mut runs = Vec::new();
                let level = h.level;
                collect_inlines(node, heading_style(level), &mut runs);
                self.emit_runs(&runs, ctx, line);
                self.blank();
            }
            NodeValue::Paragraph => {
                if !first_in_parent && !ctx.tight {
                    self.blank();
                }
                let mut runs = Vec::new();
                collect_inlines(node, Style::default(), &mut runs);
                self.emit_runs(&runs, ctx, line);
                if !ctx.tight {
                    self.blank();
                }
            }
            NodeValue::BlockQuote | NodeValue::MultilineBlockQuote(_) => {
                if !first_in_parent && !ctx.tight {
                    self.blank();
                }
                let q = ctx.quoted();
                self.blocks(node, &q);
                self.blank();
            }
            NodeValue::Alert(a) => {
                if !first_in_parent && !ctx.tight {
                    self.blank();
                }
                let title = a
                    .title
                    .clone()
                    .unwrap_or_else(|| format!("{:?}", a.alert_type).to_uppercase());
                let q = ctx.quoted();
                self.push(
                    &q.first,
                    vec![Span::styled(
                        title,
                        Style::default().add_modifier(Modifier::BOLD),
                    )],
                    line,
                );
                let body = Ctx {
                    first: q.rest.clone(),
                    rest: q.rest.clone(),
                    quote_depth: q.quote_depth,
                    tight: false,
                };
                self.blocks(node, &body);
                self.blank();
            }
            NodeValue::List(list) => {
                if !first_in_parent && !ctx.tight {
                    self.blank();
                }
                let list = *list;
                let mut n = list.start;
                for item in node.children() {
                    let item_data = item.data.borrow();
                    let marker = match (&item_data.value, list.list_type) {
                        (NodeValue::TaskItem(t), _) => {
                            if t.symbol.is_some() {
                                "☑ ".to_string()
                            } else {
                                "☐ ".to_string()
                            }
                        }
                        (_, ListType::Ordered) => format!("{}. ", n),
                        (_, ListType::Bullet) => "• ".to_string(),
                    };
                    drop(item_data);
                    n += 1;
                    let pad = " ".repeat(UnicodeWidthStr::width(marker.as_str()));
                    let mut ic = ctx.nested(&marker, &pad);
                    ic.tight = list.tight;
                    if item.first_child().is_none() {
                        self.push(&ic.first, vec![], item.data.borrow().sourcepos.start.line);
                    }
                    self.blocks(item, &ic);
                    if list.tight {
                        self.pop_blank();
                    }
                }
                if !ctx.tight {
                    self.blank();
                }
            }
            NodeValue::Item(_) | NodeValue::TaskItem(_) => {
                // Reached only for items outside a list (never in practice).
                self.blocks(node, ctx);
            }
            NodeValue::CodeBlock(cb) => {
                if !first_in_parent && !ctx.tight {
                    self.blank();
                }
                let inner = self.width.saturating_sub(ctx.prefix_width()).max(1);
                if !cb.info.is_empty() {
                    let label = format!("{:>w$}", cb.info, w = inner);
                    self.push(&ctx.first, vec![Span::styled(label, dim())], line);
                }
                let literal = cb.literal.clone();
                let first = ctx.first.clone();
                let rest = ctx.rest.clone();
                let mut body: Vec<&str> = literal.lines().collect();
                while body.last().map(|l| l.is_empty()).unwrap_or(false) {
                    body.pop();
                }
                for (i, l) in body.iter().enumerate() {
                    let text = format!(" {}", l);
                    let w = UnicodeWidthStr::width(text.as_str());
                    let padded = if w < inner {
                        format!("{}{}", text, " ".repeat(inner - w))
                    } else {
                        text
                    };
                    let prefix = if i == 0 && cb.info.is_empty() {
                        &first
                    } else {
                        &rest
                    };
                    self.push(
                        prefix,
                        vec![Span::styled(padded, code_block_style())],
                        line + 1 + i,
                    );
                }
                self.blank();
            }
            NodeValue::HtmlBlock(h) => {
                if !first_in_parent && !ctx.tight {
                    self.blank();
                }
                for (i, l) in h.literal.trim_end().lines().enumerate() {
                    self.push(
                        if i == 0 { &ctx.first } else { &ctx.rest },
                        vec![Span::styled(l.to_string(), dim())],
                        line + i,
                    );
                }
                self.blank();
            }
            NodeValue::ThematicBreak => {
                if !first_in_parent && !ctx.tight {
                    self.blank();
                }
                let inner = self.width.saturating_sub(ctx.prefix_width()).max(1);
                self.push(
                    &ctx.first,
                    vec![Span::styled("─".repeat(inner), dim())],
                    line,
                );
                self.blank();
            }
            NodeValue::Table(t) => {
                if !first_in_parent && !ctx.tight {
                    self.blank();
                }
                let alignments = t.alignments.clone();
                self.table(node, &alignments, ctx, line);
                self.blank();
            }
            NodeValue::FootnoteDefinition(f) => {
                if !first_in_parent && !ctx.tight {
                    self.blank();
                }
                let marker = format!("[^{}]: ", f.name);
                let pad = " ".repeat(UnicodeWidthStr::width(marker.as_str()));
                let fc = ctx.nested(&marker, &pad);
                self.blocks(node, &fc);
                self.blank();
            }
            _ => {
                // Anything else: render its children as blocks.
                self.blocks(node, ctx);
            }
        }
    }

    fn table<'a>(
        &mut self,
        node: &'a AstNode<'a>,
        alignments: &[TableAlignment],
        ctx: &Ctx,
        line: usize,
    ) {
        // Collect cells as plain-ish spans first, then size the columns.
        let mut rows: Vec<(bool, Vec<Vec<Run>>, usize)> = Vec::new();
        for row in node.children() {
            let rd = row.data.borrow();
            let NodeValue::TableRow(header) = rd.value else {
                continue;
            };
            let row_line = rd.sourcepos.start.line;
            drop(rd);
            let mut cells = Vec::new();
            for cell in row.children() {
                let mut runs = Vec::new();
                let style = if header {
                    Style::default().add_modifier(Modifier::BOLD)
                } else {
                    Style::default()
                };
                collect_inlines(cell, style, &mut runs);
                cells.push(runs);
            }
            rows.push((header, cells, row_line));
        }
        let ncols = rows.iter().map(|r| r.1.len()).max().unwrap_or(0);
        if ncols == 0 {
            return;
        }
        let cell_text = |runs: &[Run]| -> String {
            runs.iter()
                .map(|r| match r {
                    Run::Text(t, _) => t.replace('\n', " "),
                    Run::Break => " ".into(),
                })
                .collect()
        };
        let mut widths = vec![1usize; ncols];
        for (_, cells, _) in &rows {
            for (i, c) in cells.iter().enumerate() {
                widths[i] = widths[i].max(UnicodeWidthStr::width(cell_text(c).as_str()));
            }
        }
        // Shrink the widest columns until the table fits.
        let inner = self.width.saturating_sub(ctx.prefix_width()).max(4);
        let total = |w: &[usize]| w.iter().sum::<usize>() + 3 * (w.len() - 1) + 4;
        while total(&widths) > inner {
            let (i, &max) = widths.iter().enumerate().max_by_key(|(_, w)| **w).unwrap();
            if max <= 3 {
                break;
            }
            widths[i] = max - 1;
        }
        let fit = |s: &str, w: usize, align: Option<&TableAlignment>| -> String {
            let mut out = String::new();
            let mut used = 0;
            for ch in s.chars() {
                let cw = UnicodeWidthStr::width(ch.to_string().as_str());
                if used + cw > w {
                    break;
                }
                out.push(ch);
                used += cw;
            }
            let pad = w - used;
            match align {
                Some(TableAlignment::Right) => format!("{}{}", " ".repeat(pad), out),
                Some(TableAlignment::Center) => {
                    format!(
                        "{}{}{}",
                        " ".repeat(pad / 2),
                        out,
                        " ".repeat(pad - pad / 2)
                    )
                }
                _ => format!("{}{}", out, " ".repeat(pad)),
            }
        };
        let border = |l: &str, m: &str, r: &str, widths: &[usize]| -> String {
            let mut s = String::from(l);
            for (i, w) in widths.iter().enumerate() {
                s.push_str(&"─".repeat(w + 2));
                s.push_str(if i + 1 == widths.len() { r } else { m });
            }
            s
        };
        let mut first = true;
        self.push(
            if first { &ctx.first } else { &ctx.rest },
            vec![Span::styled(border("┌", "┬", "┐", &widths), dim())],
            line,
        );
        first = false;
        let _ = first;
        for (header, cells, row_line) in &rows {
            let mut spans = vec![Span::styled("│ ".to_string(), dim())];
            for (i, width) in widths.iter().enumerate() {
                let text = cells.get(i).map(|c| cell_text(c)).unwrap_or_default();
                let style = cells
                    .get(i)
                    .and_then(|c| {
                        c.iter().find_map(|r| match r {
                            Run::Text(_, s) => Some(*s),
                            Run::Break => None,
                        })
                    })
                    .unwrap_or_default();
                spans.push(Span::styled(fit(&text, *width, alignments.get(i)), style));
                spans.push(Span::styled(
                    if i + 1 == ncols { " │" } else { " │ " }.to_string(),
                    dim(),
                ));
            }
            self.push(&ctx.rest, spans, *row_line);
            if *header {
                self.push(
                    &ctx.rest,
                    vec![Span::styled(border("├", "┼", "┤", &widths), dim())],
                    *row_line,
                );
            }
        }
        let last_line = rows.last().map(|r| r.2).unwrap_or(line);
        self.push(
            &ctx.rest,
            vec![Span::styled(border("└", "┴", "┘", &widths), dim())],
            last_line,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(md: &str, width: u16) -> Vec<String> {
        render(md, width).plain()
    }

    #[test]
    fn headings_lose_their_hashes_and_paragraphs_are_separated() {
        let out = plain("# Title\n\nSome text.\n\n## Sub\n\nMore.\n", 40);
        assert_eq!(out, vec!["Title", "", "Some text.", "", "Sub", "", "More."]);
        let r = render("# Title\n\nSome text.\n", 40);
        assert_eq!(r.lines[0].source_line, 1);
        assert_eq!(r.lines[1].source_line, 0);
        assert_eq!(r.lines[2].source_line, 3);
        assert_eq!(r.line_for_source(3), 2);
    }

    #[test]
    fn paragraphs_wrap_at_word_boundaries_and_cjk_counts_double() {
        let out = plain("alpha beta gamma delta epsilon", 12);
        assert_eq!(out, vec!["alpha beta", "gamma delta", "epsilon"]);
        // 6 double-width chars = 12 columns; width 8 fits 4 per line.
        let out = plain("日本語の文章です", 8);
        assert_eq!(out, vec!["日本語の", "文章です"]);
        // A word longer than the line is split rather than lost.
        let out = plain("abcdefghij", 4);
        assert_eq!(out, vec!["abcd", "efgh", "ij"]);
    }

    #[test]
    fn inline_styles_survive_wrapping() {
        let r = render("plain **bold** and `code` end", 80);
        let spans = &r.lines[0].line.spans;
        let bold = spans
            .iter()
            .find(|s| s.content == "bold")
            .expect("bold span");
        assert!(bold.style.add_modifier.contains(Modifier::BOLD));
        let code = spans.iter().find(|s| s.content == "code").unwrap();
        assert_eq!(code.style.fg, Some(Color::Yellow));
    }

    #[test]
    fn lists_get_bullets_numbers_and_task_boxes_with_hanging_indent() {
        let md = "- one\n- two that is long enough to wrap\n  - nested\n1. first\n2. second\n- [ ] todo\n- [x] done\n";
        let out = plain(md, 20);
        assert_eq!(out[0], "• one");
        assert_eq!(out[1], "• two that is long");
        assert_eq!(out[2], "  enough to wrap");
        assert_eq!(out[3], "  • nested");
        assert!(out.contains(&"1. first".to_string()));
        assert!(out.contains(&"2. second".to_string()));
        assert!(out.contains(&"☐ todo".to_string()));
        assert!(out.contains(&"☑ done".to_string()));
    }

    #[test]
    fn code_blocks_keep_their_lines_and_show_the_language() {
        let out = plain("```rust\nfn main() {}\n    indented\n```\n", 30);
        assert_eq!(out[0].trim(), "rust");
        assert_eq!(out[1].trim_end(), " fn main() {}");
        assert_eq!(out[2].trim_end(), "     indented");
        let r = render("text\n\n```\ncode\n```\n", 30);
        // The code line maps to its own source line (4), not the fence.
        assert_eq!(
            r.lines
                .iter()
                .find(|l| l.line.spans.iter().any(|s| s.content.contains("code")))
                .unwrap()
                .source_line,
            4
        );
    }

    #[test]
    fn block_quotes_are_prefixed_on_every_line() {
        let out = plain("> quoted text that wraps around\n>\n> second", 16);
        assert!(out.iter().all(|l| l.is_empty() || l.starts_with("▎ ")));
        assert_eq!(out[0], "▎ quoted text");
    }

    #[test]
    fn tables_are_drawn_with_box_characters_and_aligned_columns() {
        let md = "| name | n |\n|:-----|--:|\n| a | 1 |\n| 日本 | 22 |\n";
        let out = plain(md, 40);
        assert_eq!(out[0], "┌──────┬────┐");
        assert_eq!(out[1], "│ name │  n │");
        assert_eq!(out[2], "├──────┼────┤");
        assert_eq!(out[3], "│ a    │  1 │");
        assert_eq!(out[4], "│ 日本 │ 22 │");
        assert_eq!(out[5], "└──────┴────┘");
    }

    #[test]
    fn wide_tables_shrink_to_fit_and_rules_span_the_width() {
        let md = "| aaaaaaaaaaaaaaaaaaaa | bbbbbbbbbbbbbbbbbbbb |\n|---|---|\n| 1 | 2 |\n";
        let out = plain(md, 24);
        assert!(out.iter().all(|l| UnicodeWidthStr::width(l.as_str()) <= 24));
        let out = plain("a\n\n---\n\nb", 10);
        assert_eq!(out[2], "──────────");
    }

    #[test]
    fn images_links_and_front_matter_are_readable() {
        let out = plain(
            "---\ntitle: x\n---\n\n![diagram](d.png) and [site](http://x) and [[Note]]",
            60,
        );
        assert_eq!(out[0], "---");
        assert_eq!(out[1], "title: x");
        let body = out.last().unwrap();
        assert!(body.contains("[image: diagram]"));
        assert!(body.contains("site"));
        assert!(body.contains("[[Note]]"));
    }

    #[test]
    fn empty_input_renders_nothing_and_tiny_widths_do_not_panic() {
        assert!(render("", 40).lines.is_empty());
        let _ = render("# a\n\n| a | b |\n|---|---|\n| 1 | 2 |\n", 1);
        let _ = render("> > deep\n", 3);
    }
}
