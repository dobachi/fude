//! Markdown list continuation on Enter, as the GUI editor does it
//! (src/js/core/list-nav.js): a line that starts with a list marker gets the
//! marker repeated on the new line; pressing Enter on an *empty* item ends
//! the list instead (the marker is removed).

/// What to do when Enter is pressed at the end of `line`.
#[derive(Debug, Clone, PartialEq)]
pub enum Continuation {
    /// Not a list line: a plain newline.
    Plain,
    /// Insert a newline followed by this marker (indent included).
    Marker(String),
    /// The item was empty: remove the marker (`chars` of it) and add a newline.
    EndList { chars: usize },
}

/// Parse `line` into (indent, marker, rest). The marker is the bullet or the
/// number with its delimiter and the following space, plus a task box.
fn split_marker(line: &str) -> Option<(&str, String, &str, Option<usize>)> {
    let indent_len = line.len() - line.trim_start().len();
    let (indent, body) = line.split_at(indent_len);
    // Bullets.
    for bullet in ["- ", "* ", "+ "] {
        if let Some(rest) = body.strip_prefix(bullet) {
            let (task, rest) = strip_task(rest);
            let marker = format!("{}{}", bullet, task);
            return Some((indent, marker, rest, None));
        }
    }
    // Ordered: digits followed by `.` or `)` and a space.
    let digits: String = body.chars().take_while(|c| c.is_ascii_digit()).collect();
    if !digits.is_empty() {
        let after = &body[digits.len()..];
        for delim in [". ", ") "] {
            if let Some(rest) = after.strip_prefix(delim) {
                let n: usize = digits.parse().unwrap_or(0);
                let (task, rest) = strip_task(rest);
                let marker = format!("{}{}{}", digits, delim, task);
                return Some((indent, marker, rest, Some(n)));
            }
        }
    }
    None
}

fn strip_task(rest: &str) -> (&'static str, &str) {
    for box_ in ["[ ] ", "[x] ", "[X] "] {
        if let Some(after) = rest.strip_prefix(box_) {
            return ("[ ] ", after);
        }
    }
    ("", rest)
}

pub fn continuation(line: &str) -> Continuation {
    let Some((indent, marker, rest, number)) = split_marker(line) else {
        return Continuation::Plain;
    };
    if rest.trim().is_empty() {
        return Continuation::EndList {
            chars: line.chars().count(),
        };
    }
    let next = match number {
        Some(n) => {
            // Keep the delimiter the user used.
            let delim = if marker.contains(") ") { ") " } else { ". " };
            let task = if marker.ends_with("[ ] ") { "[ ] " } else { "" };
            format!("{}{}{}", n + 1, delim, task)
        }
        None => marker.clone(),
    };
    Continuation::Marker(format!("{}{}", indent, next))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bullets_and_numbers_continue_with_indent() {
        assert_eq!(continuation("- item"), Continuation::Marker("- ".into()));
        assert_eq!(
            continuation("  * item"),
            Continuation::Marker("  * ".into())
        );
        assert_eq!(continuation("3. third"), Continuation::Marker("4. ".into()));
        assert_eq!(continuation("1) x"), Continuation::Marker("2) ".into()));
    }

    #[test]
    fn task_items_continue_unchecked() {
        assert_eq!(
            continuation("- [x] done"),
            Continuation::Marker("- [ ] ".into())
        );
        assert_eq!(
            continuation("2. [ ] todo"),
            Continuation::Marker("3. [ ] ".into())
        );
    }

    #[test]
    fn empty_items_end_the_list_and_prose_is_plain() {
        assert_eq!(continuation("- "), Continuation::EndList { chars: 2 });
        assert_eq!(continuation("  1. "), Continuation::EndList { chars: 5 });
        assert_eq!(continuation("- [ ] "), Continuation::EndList { chars: 6 });
        assert_eq!(continuation("plain text"), Continuation::Plain);
        assert_eq!(continuation("-not a list"), Continuation::Plain);
        assert_eq!(continuation(""), Continuation::Plain);
    }
}
