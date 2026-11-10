//! Deterministic thread ids, account-scoped.

/// FNV-1a 64 bits: stable across runs and platforms.
fn fnv1a64(data: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in data {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Thread id for a message: first `References` identifier, else
/// `In-Reply-To`, else its own `Message-ID`, else the normalized subject. The
/// account id is part of the hashed material, so two accounts never share a
/// thread; a reply and the message it references share one.
pub fn thread_id(
    account_id: &str,
    subject: &str,
    message_id: Option<&str>,
    in_reply_to: Option<&str>,
    references: &[String],
) -> String {
    let identifier = references
        .iter()
        .find_map(|value| split_ids(value).into_iter().next())
        .or_else(|| in_reply_to.and_then(|value| split_ids(value).into_iter().next()))
        .or_else(|| message_id.map(clean_id).filter(|id| !id.is_empty()));

    let root = match identifier {
        Some(id) => id,
        None => format!("subject:{}", normalize_subject(subject)),
    };

    format!(
        "{:016x}",
        fnv1a64(format!("{account_id}\u{1f}{root}").as_bytes())
    )
}

/// Message identifiers contained in a header value (`<a@b> <c@d>` or `a@b`).
pub fn split_ids(value: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut current = String::new();
    let mut in_brackets = false;
    let mut bracketed = false;
    for c in value.chars() {
        match c {
            '<' => {
                in_brackets = true;
                bracketed = true;
                current.clear();
            }
            '>' => {
                in_brackets = false;
                push_id(&mut ids, &current);
                current.clear();
            }
            c if in_brackets => current.push(c),
            _ => {}
        }
    }
    if in_brackets {
        push_id(&mut ids, &current);
    }
    if !bracketed {
        ids.extend(
            value
                .split_whitespace()
                .map(clean_id)
                .filter(|id| !id.is_empty()),
        );
    }
    ids
}

fn push_id(ids: &mut Vec<String>, raw: &str) {
    let id = clean_id(raw);
    if !id.is_empty() {
        ids.push(id);
    }
}

fn clean_id(value: &str) -> String {
    value
        .trim()
        .trim_matches(|c| c == '<' || c == '>')
        .trim()
        .to_string()
}

/// Subject without reply/forward prefixes, without accents, lowercased and
/// whitespace collapsed.
pub fn normalize_subject(subject: &str) -> String {
    let stripped = strip_prefixes(subject);
    let folded = fold_accents(stripped);
    folded.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_prefixes(subject: &str) -> &str {
    let mut current = subject.trim();
    loop {
        match strip_one_prefix(current) {
            Some(next) => current = next,
            None => return current,
        }
    }
}

fn strip_one_prefix(value: &str) -> Option<&str> {
    let trimmed = value.trim_start();
    let lower = trimmed.to_lowercase();
    for prefix in ["re", "tr", "fwd", "fw", "aw", "sv", "antw"] {
        if !lower.starts_with(prefix) {
            continue;
        }
        let rest = strip_counter(&trimmed[prefix.len()..]);
        if let Some(after) = rest.strip_prefix(':') {
            return Some(after.trim_start());
        }
    }
    None
}

fn strip_counter(value: &str) -> &str {
    let open = match value.chars().next() {
        Some('[') => '[',
        Some('(') => '(',
        _ => return value,
    };
    let close = if open == '[' { ']' } else { ')' };
    match value.find(close) {
        Some(end) => {
            let inner = &value[1..end];
            if !inner.is_empty() && inner.chars().all(|c| c.is_ascii_digit()) {
                &value[end + 1..]
            } else {
                value
            }
        }
        None => value,
    }
}

pub(crate) fn fold_accents(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        for lower in c.to_lowercase() {
            match accent_base(lower) {
                Some(base) => out.push_str(base),
                None => out.push(lower),
            }
        }
    }
    out
}

fn accent_base(c: char) -> Option<&'static str> {
    Some(match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' => "a",
        'ç' | 'ć' | 'č' => "c",
        'ď' | 'đ' => "d",
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ė' | 'ę' | 'ě' => "e",
        'ì' | 'í' | 'î' | 'ï' | 'ī' => "i",
        'ł' => "l",
        'ñ' | 'ń' => "n",
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' => "o",
        'ř' => "r",
        'ś' | 'š' => "s",
        'ß' => "ss",
        'ť' => "t",
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' => "u",
        'ý' | 'ÿ' => "y",
        'ź' | 'ż' => "z",
        'œ' => "oe",
        'æ' => "ae",
        _ => return None,
    })
}
