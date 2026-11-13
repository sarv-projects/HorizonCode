//! Reduced kernel `fs.edit` repair (ruling **287**, **335**, **337**, **339**) — trim, per-line
//! trimEnd/trim/unicode-fold windows, newline normalisation.

use std::env;

#[derive(Debug, PartialEq, Eq)]
pub enum EditResolveFail {
    NotFound,
    Ambiguous,
}

#[derive(Debug, PartialEq, Eq)]
pub struct EditResolveOk {
    pub start: usize,
    pub end: usize,
}

pub fn effect_host_edit_repair_enabled() -> bool {
    match env::var("HZ_EFFECT_HOST_EDIT_REPAIR") {
        Ok(v) => {
            let t = v.trim().to_ascii_lowercase();
            t == "1" || t == "true" || t == "yes"
        }
        Err(_) => false,
    }
}

fn count_occurrences(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    let mut count = 0usize;
    let mut from = 0usize;
    while let Some(rel) = haystack[from..].find(needle) {
        count += 1;
        from += rel + needle.len();
    }
    count
}

fn unique_span(haystack: &str, needle: &str) -> Option<(usize, usize)> {
    if count_occurrences(haystack, needle) != 1 {
        return None;
    }
    let start = haystack.find(needle)?;
    Some((start, start + needle.len()))
}

fn newline_norm(s: &str) -> String {
    s.replace("\r\n", "\n")
}

fn span_in_original_from_normalized(
    original: &str,
    norm_start: usize,
    norm_len: usize,
) -> Option<(usize, usize)> {
    let mut norm_idx = 0usize;
    let mut start: Option<usize> = None;
    let mut end: Option<usize> = None;
    let mut i = 0usize;
    while i <= original.len() {
        if norm_idx == norm_start && start.is_none() {
            start = Some(i);
        }
        if norm_idx == norm_start + norm_len {
            end = Some(i);
            break;
        }
        if i < original.len() && original[i..].starts_with("\r\n") {
            norm_idx += 1;
            i += 2;
            continue;
        }
        if i < original.len() {
            norm_idx += 1;
            i += 1;
            continue;
        }
        if norm_idx == norm_start + norm_len {
            end = Some(i);
        }
        break;
    }
    let start = start?;
    let end = end?;
    Some((start, end))
}

fn trim_end_line(s: &str) -> String {
    s.trim_end_matches(|c: char| matches!(c, ' ' | '\t' | '\r' | '\u{000b}' | '\u{000c}'))
        .to_string()
}

fn trim_line(s: &str) -> String {
    s.trim().to_string()
}

fn to_file_lines(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = text.replace("\r\n", "\n").split('\n').map(String::from).collect();
    if (text.ends_with('\n') || text.ends_with("\r\n"))
        && lines.last().map(String::is_empty).unwrap_or(false)
    {
        lines.pop();
    }
    lines
}

fn find_unique_trim_end_line_window(file_lines: &[String], want: &[String]) -> Option<usize> {
    let n = want.len();
    if n == 0 || n > file_lines.len() {
        return None;
    }
    let mut found: Option<usize> = None;
    for s in 0..=(file_lines.len() - n) {
        let window = &file_lines[s..s + n];
        let ok = window
            .iter()
            .zip(want.iter())
            .all(|(a, b)| trim_end_line(a) == trim_end_line(b));
        if ok {
            if found.is_some() {
                return None;
            }
            found = Some(s);
        }
    }
    found
}

fn fold_unicode_line(s: &str) -> String {
    crate::edit_unicode_fold::canonicalize_line(s)
}

fn find_unique_unicode_fold_line_window(file_lines: &[String], want: &[String]) -> Option<usize> {
    let n = want.len();
    if n == 0 || n > file_lines.len() {
        return None;
    }
    let mut found: Option<usize> = None;
    for s in 0..=(file_lines.len() - n) {
        let window = &file_lines[s..s + n];
        let ok = window
            .iter()
            .zip(want.iter())
            .all(|(a, b)| fold_unicode_line(a) == fold_unicode_line(b));
        if ok {
            if found.is_some() {
                return None;
            }
            found = Some(s);
        }
    }
    found
}

fn find_unique_trim_line_window(file_lines: &[String], want: &[String]) -> Option<usize> {
    let n = want.len();
    if n == 0 || n > file_lines.len() {
        return None;
    }
    let mut found: Option<usize> = None;
    for s in 0..=(file_lines.len() - n) {
        let window = &file_lines[s..s + n];
        let ok = window
            .iter()
            .zip(want.iter())
            .all(|(a, b)| trim_line(a) == trim_line(b));
        if ok {
            if found.is_some() {
                return None;
            }
            found = Some(s);
        }
    }
    found
}

fn line_starts(original: &str) -> Vec<usize> {
    let mut starts = vec![0usize];
    let bytes = original.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'\r' && bytes[i + 1] == b'\n' {
            i += 2;
            if i <= bytes.len() {
                starts.push(i);
            }
            continue;
        }
        if bytes[i] == b'\n' {
            i += 1;
            if i <= bytes.len() {
                starts.push(i);
            }
            continue;
        }
        i += 1;
    }
    starts
}

fn span_for_line_window(original: &str, start_line: usize, line_count: usize) -> Option<EditResolveOk> {
    let starts = line_starts(original);
    let file_lines = to_file_lines(original);
    if line_count == 0 || start_line + line_count > file_lines.len() {
        return None;
    }
    let start = *starts.get(start_line)?;
    let mut end = if start_line + line_count < starts.len() {
        starts[start_line + line_count]
    } else {
        original.len()
    };
    if end > start {
        if end >= 2 && original.as_bytes()[end - 2] == b'\r' && original.as_bytes()[end - 1] == b'\n' {
            end -= 2;
        } else if original.as_bytes()[end - 1] == b'\n' {
            end -= 1;
        }
    }
    Some(EditResolveOk { start, end })
}

fn resolve_trim_end_line_window_unique(content: &str, old: &str) -> Option<EditResolveOk> {
    let want = to_file_lines(old);
    if want.is_empty() {
        return None;
    }
    let file_lines = to_file_lines(content);
    let start_line = find_unique_trim_end_line_window(&file_lines, &want)?;
    span_for_line_window(content, start_line, want.len())
}

fn resolve_trim_line_window_unique(content: &str, old: &str) -> Option<EditResolveOk> {
    let want = to_file_lines(old);
    if want.is_empty() {
        return None;
    }
    let file_lines = to_file_lines(content);
    let start_line = find_unique_trim_line_window(&file_lines, &want)?;
    span_for_line_window(content, start_line, want.len())
}

fn resolve_unicode_fold_line_window_unique(content: &str, old: &str) -> Option<EditResolveOk> {
    let want = to_file_lines(old);
    if want.is_empty() {
        return None;
    }
    let file_lines = to_file_lines(content);
    let start_line = find_unique_unicode_fold_line_window(&file_lines, &want)?;
    span_for_line_window(content, start_line, want.len())
}

fn count_trim_end_line_windows(file_lines: &[String], want: &[String]) -> usize {
    let n = want.len();
    if n == 0 || n > file_lines.len() {
        return 0;
    }
    let mut hits = 0usize;
    for s in 0..=(file_lines.len() - n) {
        let window = &file_lines[s..s + n];
        let ok = window
            .iter()
            .zip(want.iter())
            .all(|(a, b)| trim_end_line(a) == trim_end_line(b));
        if ok {
            hits += 1;
        }
    }
    hits
}

fn count_trim_line_windows(file_lines: &[String], want: &[String]) -> usize {
    let n = want.len();
    if n == 0 || n > file_lines.len() {
        return 0;
    }
    let mut hits = 0usize;
    for s in 0..=(file_lines.len() - n) {
        let window = &file_lines[s..s + n];
        let ok = window
            .iter()
            .zip(want.iter())
            .all(|(a, b)| trim_line(a) == trim_line(b));
        if ok {
            hits += 1;
        }
    }
    hits
}

fn count_unicode_fold_line_windows(file_lines: &[String], want: &[String]) -> usize {
    let n = want.len();
    if n == 0 || n > file_lines.len() {
        return 0;
    }
    let mut hits = 0usize;
    for s in 0..=(file_lines.len() - n) {
        let window = &file_lines[s..s + n];
        let ok = window
            .iter()
            .zip(want.iter())
            .all(|(a, b)| fold_unicode_line(a) == fold_unicode_line(b));
        if ok {
            hits += 1;
        }
    }
    hits
}

fn resolve_normalized_unique(content: &str, old: &str) -> Option<EditResolveOk> {
    let norm_content = newline_norm(content);
    let norm_old = newline_norm(old);
    if norm_old.is_empty() {
        return None;
    }
    let span = unique_span(&norm_content, &norm_old)?;
    let (start, end) = span_in_original_from_normalized(content, span.0, norm_old.len())?;
    Some(EditResolveOk { start, end })
}

pub fn resolve_kernel_fs_edit_old_string(
    content: &str,
    old_string: &str,
) -> Result<EditResolveOk, EditResolveFail> {
    if let Some((start, end)) = unique_span(content, old_string) {
        return Ok(EditResolveOk { start, end });
    }
    if count_occurrences(content, old_string) > 1 {
        return Err(EditResolveFail::Ambiguous);
    }

    if !effect_host_edit_repair_enabled() {
        return Err(EditResolveFail::NotFound);
    }

    let trimmed = old_string.trim();
    if trimmed != old_string && !trimmed.is_empty() {
        if let Some((start, end)) = unique_span(content, trimmed) {
            return Ok(EditResolveOk { start, end });
        }
        if count_occurrences(content, trimmed) > 1 {
            return Err(EditResolveFail::Ambiguous);
        }
    }

    if let Some(ok) = resolve_trim_end_line_window_unique(content, old_string) {
        return Ok(ok);
    }
    let want_lines = to_file_lines(old_string);
    if !want_lines.is_empty() {
        let hits = count_trim_end_line_windows(&to_file_lines(content), &want_lines);
        if hits > 1 {
            return Err(EditResolveFail::Ambiguous);
        }
    }

    if let Some(ok) = resolve_trim_line_window_unique(content, old_string) {
        return Ok(ok);
    }
    let want_trim = to_file_lines(old_string);
    if !want_trim.is_empty() {
        let hits = count_trim_line_windows(&to_file_lines(content), &want_trim);
        if hits > 1 {
            return Err(EditResolveFail::Ambiguous);
        }
    }

    if let Some(ok) = resolve_unicode_fold_line_window_unique(content, old_string) {
        return Ok(ok);
    }
    let want_fold = to_file_lines(old_string);
    if !want_fold.is_empty() {
        let hits = count_unicode_fold_line_windows(&to_file_lines(content), &want_fold);
        if hits > 1 {
            return Err(EditResolveFail::Ambiguous);
        }
    }

    if let Some(ok) = resolve_normalized_unique(content, old_string) {
        return Ok(ok);
    }
    let norm_old = newline_norm(old_string);
    if count_occurrences(&newline_norm(content), &norm_old) > 1 {
        return Err(EditResolveFail::Ambiguous);
    }
    Err(EditResolveFail::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    /// Unit tests mutate process env; serialize them so parallel cargo threads
    /// cannot leave `HZ_EFFECT_HOST_EDIT_REPAIR` set across cases.
    fn edit_repair_env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    struct ClearEditRepairEnv;
    impl Drop for ClearEditRepairEnv {
        fn drop(&mut self) {
            std::env::remove_var("HZ_EFFECT_HOST_EDIT_REPAIR");
        }
    }

    #[test]
    fn trim_repair_requires_flag() {
        let _guard = edit_repair_env_lock().lock().unwrap();
        let _clear = ClearEditRepairEnv;
        std::env::remove_var("HZ_EFFECT_HOST_EDIT_REPAIR");
        let content = "xx hello world yy";
        assert_eq!(
            resolve_kernel_fs_edit_old_string(content, "  hello world  "),
            Err(EditResolveFail::NotFound)
        );
        std::env::set_var("HZ_EFFECT_HOST_EDIT_REPAIR", "1");
        let ok = resolve_kernel_fs_edit_old_string(content, "  hello world  ").unwrap();
        assert_eq!(&content[ok.start..ok.end], "hello world");
    }

    #[test]
    fn ambiguous_fails_closed() {
        assert_eq!(
            resolve_kernel_fs_edit_old_string("aa", "a"),
            Err(EditResolveFail::Ambiguous)
        );
    }

    #[test]
    fn trim_end_line_window_requires_flag() {
        let _guard = edit_repair_env_lock().lock().unwrap();
        let _clear = ClearEditRepairEnv;
        std::env::remove_var("HZ_EFFECT_HOST_EDIT_REPAIR");
        let content = "alpha  \nbeta  \n";
        assert_eq!(
            resolve_kernel_fs_edit_old_string(content, "alpha\nbeta"),
            Err(EditResolveFail::NotFound)
        );
        std::env::set_var("HZ_EFFECT_HOST_EDIT_REPAIR", "1");
        let ok = resolve_kernel_fs_edit_old_string(content, "alpha\nbeta").unwrap();
        assert_eq!(&content[ok.start..ok.end], "alpha  \nbeta  ");
    }

    #[test]
    fn trim_line_window_requires_flag() {
        let _guard = edit_repair_env_lock().lock().unwrap();
        let _clear = ClearEditRepairEnv;
        std::env::remove_var("HZ_EFFECT_HOST_EDIT_REPAIR");
        let content = "  alpha  \n  beta  \n";
        assert_eq!(
            resolve_kernel_fs_edit_old_string(content, "alpha\nbeta"),
            Err(EditResolveFail::NotFound)
        );
        std::env::set_var("HZ_EFFECT_HOST_EDIT_REPAIR", "1");
        let ok = resolve_kernel_fs_edit_old_string(content, "alpha\nbeta").unwrap();
        assert_eq!(&content[ok.start..ok.end], "  alpha  \n  beta  ");
    }

    #[test]
    fn unicode_fold_line_window_requires_flag() {
        let _guard = edit_repair_env_lock().lock().unwrap();
        let _clear = ClearEditRepairEnv;
        std::env::remove_var("HZ_EFFECT_HOST_EDIT_REPAIR");
        let content = "say \u{2018}hi\u{2019}\nnext";
        assert_eq!(
            resolve_kernel_fs_edit_old_string(content, "say 'hi'\nnext"),
            Err(EditResolveFail::NotFound)
        );
        std::env::set_var("HZ_EFFECT_HOST_EDIT_REPAIR", "1");
        let ok = resolve_kernel_fs_edit_old_string(content, "say 'hi'\nnext").unwrap();
        assert_eq!(&content[ok.start..ok.end], "say \u{2018}hi\u{2019}\nnext");
    }
}
