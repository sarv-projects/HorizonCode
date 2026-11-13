//! Reduced kernel `fs.edit` repair (ruling **287**) — trim + newline normalisation only.

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

    #[test]
    fn trim_repair_requires_flag() {
        let content = "xx hello world yy";
        assert_eq!(
            resolve_kernel_fs_edit_old_string(content, "  hello world  "),
            Err(EditResolveFail::NotFound)
        );
        std::env::set_var("HZ_EFFECT_HOST_EDIT_REPAIR", "1");
        let ok = resolve_kernel_fs_edit_old_string(content, "  hello world  ").unwrap();
        assert_eq!(&content[ok.start..ok.end], "hello world");
        std::env::remove_var("HZ_EFFECT_HOST_EDIT_REPAIR");
    }

    #[test]
    fn ambiguous_fails_closed() {
        assert_eq!(
            resolve_kernel_fs_edit_old_string("aa", "a"),
            Err(EditResolveFail::Ambiguous)
        );
    }
}
