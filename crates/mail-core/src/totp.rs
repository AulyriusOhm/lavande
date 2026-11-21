//! Extracteur déterministe de codes TOTP / OTP / 2FA depuis un email.
//!
//! Ne tourne qu'une fois que le modèle de décision a classé un message en
//! `auth_totp` (ou au-dessus du seuil configuré) : zéro appel LLM, exécution
//! en quelques microsecondes côté démon Rust pour afficher un popup ou une
//! notification « Copier le code » immédiatement.

use serde::{Deserialize, Serialize};

/// Code de vérification extrait d'un message et service associé.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TotpMatch {
    /// Code normalisé sans espaces superflus (ex. `"482917"` ou `"AB49-XZ"`).
    pub code: String,
    /// Nom lisible du service émetteur (ex. `"GitHub"`, `"Stripe"`).
    pub service: String,
}

const CONTEXT_KEYWORDS: &[&str] = &[
    "code",
    "otp",
    "totp",
    "2fa",
    "mfa",
    "pin",
    "passcode",
    "token",
    "jeton",
    "vérification",
    "verification",
    "confirmation",
    "sécurité",
    "securite",
    "security",
    "connexion",
    "authentification",
    "authentication",
    "valider",
    "validation",
    "login",
    "sign-in",
    "signin",
    "sign in",
    "one-time",
    "usage unique",
];

const NOISE_SENDER_WORDS: &[&str] = &[
    "no-reply",
    "noreply",
    "no reply",
    "ne pas repondre",
    "ne pas répondre",
    "do-not-reply",
    "donotreply",
    "notification",
    "notifications",
    "security",
    "sécurité",
    "securite",
    "account",
    "accounts",
    "support",
    "team",
    "équipe",
    "equipe",
    "mailer",
    "mail",
    "info",
    "hello",
    "alert",
    "alerts",
    "auth",
    "verify",
    "verification",
];

/// Extrait un code TOTP/OTP et le nom du service depuis un mail.
/// Retourne `None` si aucun code crédible n'est trouvé (évite les faux positifs
/// sur dates, années, montants ou numéros de téléphone).
pub fn extract_totp(
    from_name: Option<&str>,
    from_email: &str,
    subject: &str,
    body: &str,
) -> Option<TotpMatch> {
    let service = infer_service(from_name, from_email);
    let code = find_code_in_text(subject, true).or_else(|| find_code_in_text(body, false))?;
    Some(TotpMatch { code, service })
}

/// Déduit un nom de service propre à partir du nom d'affichage ou du domaine.
pub fn infer_service(from_name: Option<&str>, from_email: &str) -> String {
    if let Some(raw) = from_name {
        let cleaned = raw.trim().trim_matches('"').trim();
        if !cleaned.is_empty() && !cleaned.contains('@') {
            let lower = cleaned.to_lowercase();
            let is_generic = NOISE_SENDER_WORDS.iter().any(|word| lower == *word);
            if !is_generic {
                // Retire les suffixes génériques courants ("GitHub Security" -> "GitHub").
                let stripped = strip_sender_noise(cleaned);
                if !stripped.is_empty() {
                    return stripped;
                }
                return cleaned.to_string();
            }
        }
    }
    service_from_email(from_email)
}

fn strip_sender_noise(name: &str) -> String {
    let parts: Vec<&str> = name.split_whitespace().collect();
    if parts.len() <= 1 {
        return name.to_string();
    }
    let kept: Vec<&str> = parts
        .iter()
        .copied()
        .filter(|part| {
            let low = part
                .trim_matches(|c: char| !c.is_alphanumeric() && c != '-')
                .to_lowercase();
            !NOISE_SENDER_WORDS.contains(&low.as_str())
        })
        .collect();
    if kept.is_empty() {
        name.to_string()
    } else {
        kept.join(" ")
    }
}

fn service_from_email(email: &str) -> String {
    let domain = email
        .trim()
        .rsplit('@')
        .next()
        .unwrap_or("")
        .trim()
        .trim_end_matches('>');
    if domain.is_empty() {
        return "Service".to_string();
    }
    let labels: Vec<&str> = domain.split('.').filter(|part| !part.is_empty()).collect();
    let label = match labels.as_slice() {
        [] => "Service",
        [single] => single,
        // Ignore les sous-domaines techniques courants (mail.google.com, auth.stripe.com)
        [.., base, tld] if tld.len() <= 3 && !is_second_level_tld(base) => base,
        [.., base, _, _] => base,
        [first, ..] => first,
    };
    capitalize(label)
}

fn is_second_level_tld(label: &str) -> bool {
    matches!(
        label.to_lowercase().as_str(),
        "co" | "com" | "org" | "net" | "gov" | "gouv" | "edu" | "ac"
    )
}

fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

#[derive(Clone, Debug)]
struct Candidate {
    code: String,
    score: i32,
    position: usize,
}

fn find_code_in_text(text: &str, is_subject: bool) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Borne la lecture pour éviter de scanner un mail gigantesque.
    let bounded = truncate_chars(trimmed, 4000);
    let lower = bounded.to_lowercase();
    let bytes = bounded.as_bytes();
    let mut best: Option<Candidate> = None;

    let mut i = 0;
    while i < bytes.len() {
        if !bytes[i].is_ascii_alphanumeric() {
            i += 1;
            continue;
        }
        // Saute les URLs (http://, https://) et adresses mail.
        if looks_like_url_start(&lower, i) {
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            continue;
        }

        // Capture un token simple OU un code groupé "123 456" / "123-456" / "1234-5678".
        let start = i;
        let (end, normalized, grouped) = read_candidate_span(bounded, start);
        i = end;

        if let Some(score) = score_candidate(
            bounded,
            &lower,
            start,
            end,
            &normalized,
            grouped,
            is_subject,
        ) {
            let candidate = Candidate {
                code: normalized,
                score,
                position: start,
            };
            let replace = match &best {
                None => true,
                Some(current) => {
                    candidate.score > current.score
                        || (candidate.score == current.score
                            && candidate.position < current.position)
                }
            };
            if replace {
                best = Some(candidate);
            }
        }
    }

    best.map(|entry| entry.code)
}

fn truncate_chars(value: &str, max_chars: usize) -> &str {
    match value.char_indices().nth(max_chars) {
        Some((idx, _)) => &value[..idx],
        None => value,
    }
}

fn looks_like_url_start(lower: &str, idx: usize) -> bool {
    let tail = &lower[idx..];
    tail.starts_with("http://") || tail.starts_with("https://") || tail.starts_with("www.")
}

fn read_candidate_span(text: &str, start: usize) -> (usize, String, bool) {
    let bytes = text.as_bytes();
    let mut end = start;
    while end < bytes.len() && bytes[end].is_ascii_alphanumeric() {
        end += 1;
    }
    let first = &text[start..end];

    // Gère un code scindé en deux blocs : "482 917", "482-917", "AB49-XZ12".
    if (first.len() == 3 || first.len() == 4)
        && end + 1 < bytes.len()
        && (bytes[end] == b' ' || bytes[end] == b'-')
        && bytes[end + 1].is_ascii_alphanumeric()
    {
        let sep = bytes[end];
        let mut second_end = end + 1;
        while second_end < bytes.len() && bytes[second_end].is_ascii_alphanumeric() {
            second_end += 1;
        }
        let second = &text[end + 1..second_end];
        let both_digits =
            first.bytes().all(|b| b.is_ascii_digit()) && second.bytes().all(|b| b.is_ascii_digit());
        let valid_grouped_digits = both_digits
            && ((first.len() == 3 && second.len() == 3) || (first.len() == 4 && second.len() == 4));
        let valid_grouped_alnum = sep == b'-'
            && first.len() >= 3
            && second.len() >= 3
            && (first.len() + second.len()) <= 8
            && first
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
            && second
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
            && (first.bytes().any(|b| b.is_ascii_digit())
                || second.bytes().any(|b| b.is_ascii_digit()));

        if valid_grouped_digits {
            // Vérifie qu'il n'y a pas un 3e groupe numérique (ex. numéro de téléphone).
            let next_is_more_digits = second_end + 1 < bytes.len()
                && (bytes[second_end] == b' ' || bytes[second_end] == b'-')
                && bytes[second_end + 1].is_ascii_digit();
            if !next_is_more_digits {
                return (second_end, format!("{first}{second}"), true);
            }
        } else if valid_grouped_alnum {
            return (second_end, format!("{first}-{second}"), true);
        }
    }

    (end, first.to_string(), false)
}

fn score_candidate(
    text: &str,
    lower: &str,
    start: usize,
    end: usize,
    normalized: &str,
    grouped: bool,
    is_subject: bool,
) -> Option<i32> {
    let bytes = text.as_bytes();
    let prev = if start > 0 {
        Some(bytes[start - 1])
    } else {
        None
    };
    let next = bytes.get(end).copied();

    // Exclut les couleurs hex (#123456), chemins (/123456), emails, décimaux (1234.56), téléphones.
    if matches!(prev, Some(b'#' | b'/' | b'@' | b'+' | b'_')) {
        return None;
    }
    if prev == Some(b'.') && start >= 2 && bytes[start - 2].is_ascii_digit() {
        return None;
    }
    if matches!(next, Some(b'/' | b'@' | b'%' | b'_')) {
        return None;
    }
    if next == Some(b'.') && bytes.get(end + 1).is_some_and(u8::is_ascii_digit) {
        return None;
    }
    // Exclut les dates type 2026-11-21 ou 11-2026.
    if prev == Some(b'-') || next == Some(b'-') {
        return None;
    }

    // Exclut les montants (ex. "1200 EUR", "5000 €", "$1500").
    if prev == Some(b'$') {
        return None;
    }
    let after = text[end..].trim_start();
    let after_lower = after.to_lowercase();
    if after.starts_with('€')
        || after.starts_with('$')
        || after.starts_with('£')
        || after_lower.starts_with("eur")
        || after_lower.starts_with("usd")
        || after_lower.starts_with("gbp")
    {
        return None;
    }

    let raw_len = normalized.chars().filter(|c| *c != '-').count();
    let all_digits = normalized.bytes().all(|b| b.is_ascii_digit());
    let has_digit = normalized.bytes().any(|b| b.is_ascii_digit());
    let has_upper = normalized.bytes().any(|b| b.is_ascii_uppercase());
    let all_upper_or_digit = normalized
        .bytes()
        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-');

    // Longueur admissible : 4..=8 chiffres ou 5..=8 alphanumériques majuscules avec au moins un chiffre.
    if all_digits {
        if !(4..=8).contains(&raw_len) {
            return None;
        }
    } else if !(grouped
        || (has_digit && has_upper && all_upper_or_digit && (5..=8).contains(&raw_len)))
    {
        return None;
    }

    // Fenêtre de contexte avant/après le candidat.
    let ctx_start = floor_char_boundary(lower, start.saturating_sub(90));
    let ctx_end = ceil_char_boundary(lower, (end + 60).min(lower.len()));
    let before_ctx = &lower[ctx_start..start];
    let around_ctx = &lower[ctx_start..ctx_end];

    let has_keyword_before = CONTEXT_KEYWORDS.iter().any(|kw| before_ctx.contains(kw));
    let has_keyword_around =
        has_keyword_before || CONTEXT_KEYWORDS.iter().any(|kw| around_ctx.contains(kw));

    // Rejette les années (1990..=2099) sauf si explicitement précédées d'un mot-clé OTP.
    if all_digits && raw_len == 4 {
        if let Ok(year) = normalized.parse::<u32>() {
            if (1990..=2099).contains(&year) && !has_keyword_before {
                return None;
            }
        }
    }

    // Sans aucun mot-clé autour, un code alphanumérique ou 4 chiffres est trop risqué.
    if !has_keyword_around
        && !(all_digits && raw_len == 6 && (is_subject || isolated_on_line(text, start, end)))
    {
        return None;
    }

    let mut score = 0;
    if all_digits && raw_len == 6 {
        score += 50; // Format TOTP standard le plus courant
    } else if all_digits && (raw_len == 5 || raw_len == 8) {
        score += 35;
    } else if all_digits && raw_len == 4 {
        score += 20;
    } else {
        score += 25; // Alphanumérique majuscule + chiffre
    }

    if has_keyword_before {
        score += 40;
    } else if has_keyword_around {
        score += 20;
    }

    if is_subject {
        score += 15;
    }
    if isolated_on_line(text, start, end) {
        score += 25;
    }
    if grouped {
        score += 10;
    }

    Some(score)
}

fn isolated_on_line(text: &str, start: usize, end: usize) -> bool {
    let line_start = text[..start].rfind('\n').map_or(0, |idx| idx + 1);
    let line_end = text[end..].find('\n').map_or(text.len(), |off| end + off);
    let before = text[line_start..start].trim();
    let after = text[end..line_end].trim();
    before.is_empty() && after.is_empty()
}

fn floor_char_boundary(s: &str, mut index: usize) -> usize {
    if index >= s.len() {
        return s.len();
    }
    while index > 0 && !s.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(s: &str, mut index: usize) -> usize {
    if index >= s.len() {
        return s.len();
    }
    while index < s.len() && !s.is_char_boundary(index) {
        index += 1;
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_six_digit_code_from_french_mail() {
        let found = extract_totp(
            Some("GitHub Security"),
            "noreply@github.com",
            "Votre code de vérification GitHub",
            "Bonjour,\n\nVoici votre code de vérification : 482917\nIl expire dans 10 minutes.",
        )
        .expect("code");
        assert_eq!(found.code, "482917");
        assert_eq!(found.service, "GitHub");
    }

    #[test]
    fn extracts_grouped_six_digit_code_and_normalizes() {
        let found = extract_totp(
            Some("No-Reply"),
            "auth@stripe.com",
            "Your login code",
            "Use this one-time passcode to sign in:\n\n482 917\n\nValid for 5 minutes.",
        )
        .expect("code");
        assert_eq!(found.code, "482917");
        assert_eq!(found.service, "Stripe");
    }

    #[test]
    fn extracts_code_from_subject_first() {
        let found = extract_totp(
            Some("OpenAI"),
            "noreply@tm.openai.com",
            "Your ChatGPT code is 904215",
            "Copyright 2026 OpenAI. Reference 8821.",
        )
        .expect("code");
        assert_eq!(found.code, "904215");
        assert_eq!(found.service, "OpenAI");
    }

    #[test]
    fn extracts_alphanumeric_code_when_labeled() {
        let found = extract_totp(
            Some("Steam Support"),
            "noreply@steampowered.com",
            "Accès à votre compte",
            "Votre code de sécurité Steam Guard :\n\nK7X9P\n\nNe le partagez pas.",
        )
        .expect("code");
        assert_eq!(found.code, "K7X9P");
        assert_eq!(found.service, "Steam");
    }

    #[test]
    fn extracts_code_followed_by_sentence_period() {
        let found = extract_totp(
            Some("GitHub Security"),
            "noreply@github.com",
            "Votre code de vérification GitHub",
            "Bonjour,\nVotre code de vérification est 482917.",
        )
        .expect("code");
        assert_eq!(found.code, "482917");
        assert_eq!(found.service, "GitHub");
    }

    #[test]
    fn ignores_years_amounts_and_dates() {
        let found = extract_totp(
            Some("Facturation"),
            "billing@acme.fr",
            "Facture du 2026-11-21",
            "Montant total : 1250 EUR. Copyright 2026 Acme. Couleur #482917.",
        );
        assert!(found.is_none());
    }
}
