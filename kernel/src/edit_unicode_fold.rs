//! Per-line unicode-fold for kernel edit repair — mirrors `apply-patch-parser.ts` `canonicalize`.

use unicode_normalization::UnicodeNormalization;

fn fold_char(c: char) -> char {
    match c {
        '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
        '\u{2018}' | '\u{2019}' | '\u{201a}' | '\u{201b}' | '\u{2032}' => '\'',
        '\u{201c}' | '\u{201d}' | '\u{201e}' | '\u{201f}' | '\u{2033}' => '"',
        '\u{00a0}' | '\u{202f}'
        | '\u{2000}'..='\u{200a}'
        | '\u{3000}' => ' ',
        other => other,
    }
}

fn unescape_backslash_quotes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(&next) = chars.peek() {
                if matches!(next, '`' | '\'' | '"') {
                    chars.next();
                    out.push(next);
                    continue;
                }
            }
        }
        out.push(c);
    }
    out
}

/// NFC + typographic fold + unescape `\``, `\'`, `\"` (single line, no newlines).
pub fn canonicalize_line(line: &str) -> String {
    let nfc: String = line.nfc().collect();
    let folded: String = nfc.chars().map(fold_char).collect();
    unescape_backslash_quotes(&folded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_like_apply_patch_parser() {
        assert_eq!(canonicalize_line("a\u{2014}b"), "a-b");
        assert_eq!(canonicalize_line("a\u{2212}b"), "a-b");
        assert_eq!(canonicalize_line("\u{2018}x\u{2019}"), "'x'");
        assert_eq!(canonicalize_line("\u{201c}x\u{201d}"), "\"x\"");
        assert_eq!(canonicalize_line("a\u{00a0}b"), "a b");
        assert_eq!(canonicalize_line("a\u{3000}b"), "a b");
        assert_eq!(canonicalize_line("\\`\\'\\\""), "`'\"");
    }
}
