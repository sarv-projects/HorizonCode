//! Minimal UTC time helpers (no chrono dependency by design).
//!
//! Timestamps follow the frozen contract: ISO-8601 UTC with millisecond
//! precision, exactly like JavaScript's `new Date().toISOString()`
//! (e.g. `2026-11-06T14:22:29.123Z`).

use std::time::{SystemTime, UNIX_EPOCH};

pub const MS_PER_DAY: i64 = 86_400_000;

/// Milliseconds since the Unix epoch (saturating; never panics).
pub fn now_millis() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis().min(i64::MAX as u128) as i64,
        Err(_) => 0,
    }
}

pub fn now_iso() -> String {
    iso_from_unix_millis(now_millis())
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` (matches `Date.toISOString()`).
pub fn iso_from_unix_millis(ms: i64) -> String {
    let days = ms.div_euclid(MS_PER_DAY);
    let msod = ms.rem_euclid(MS_PER_DAY);
    let (year, month, day) = civil_from_days(days);
    let hour = msod / 3_600_000;
    let minute = (msod / 60_000) % 60;
    let second = (msod / 1_000) % 60;
    let milli = msod % 1_000;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hour, minute, second, milli
    )
}

/// Parse an ISO-8601 timestamp to Unix milliseconds.
///
/// Accepts `YYYY-MM-DD(T|t| )HH:MM:SS[.fraction][Z|z|±HH:MM|±HHMM|±HH]`.
/// Returns `None` for anything malformed (callers must treat that as expired).
pub fn parse_iso_millis(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.len() < 19 || !s.is_ascii() {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    if s.as_bytes().get(4)? != &b'-' {
        return None;
    }
    let month: u32 = s.get(5..7)?.parse().ok()?;
    if s.as_bytes().get(7)? != &b'-' {
        return None;
    }
    let day: u32 = s.get(8..10)?.parse().ok()?;
    let sep = *s.as_bytes().get(10)?;
    if sep != b'T' && sep != b't' && sep != b' ' {
        return None;
    }
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    if s.as_bytes().get(13)? != &b':' {
        return None;
    }
    let minute: i64 = s.get(14..16)?.parse().ok()?;
    if s.as_bytes().get(16)? != &b':' {
        return None;
    }
    let second: i64 = s.get(17..19)?.parse().ok()?;
    if month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    let mut rest = &s[19..];
    let mut milli: i64 = 0;
    if rest.starts_with('.') || rest.starts_with(',') {
        let frac = &rest[1..];
        let digits: &str = &frac[..frac.bytes().take_while(|b| b.is_ascii_digit()).count()];
        if digits.is_empty() {
            return None;
        }
        let mut scaled = String::from(digits);
        while scaled.len() < 3 {
            scaled.push('0');
        }
        scaled.truncate(3);
        milli = scaled.parse().ok()?;
        rest = &frac[digits.len()..];
    }

    let offset_minutes: i64 = if rest.is_empty() || rest == "Z" || rest == "z" {
        0
    } else if rest.starts_with('+') || rest.starts_with('-') {
        let sign: i64 = if rest.starts_with('-') { -1 } else { 1 };
        let body = &rest[1..];
        if !body.is_ascii() {
            return None;
        }
        let (h, m) = match body.split_once(':') {
            Some((h, m)) => (h.parse::<i64>().ok()?, m.parse::<i64>().ok()?),
            None if body.len() == 4 => (body[0..2].parse().ok()?, body[2..4].parse().ok()?),
            None => (body.parse::<i64>().ok()?, 0),
        };
        sign * (h * 60 + m)
    } else {
        return None;
    };

    Some(
        days_from_civil(year, month, day) * MS_PER_DAY + hour * 3_600_000 + minute * 60_000
            + second * 1_000
            + milli
            - offset_minutes * 60_000,
    )
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m as i64 - 3 } else { m as i64 + 9 };
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
