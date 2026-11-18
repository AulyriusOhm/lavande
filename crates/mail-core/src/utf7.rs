//! Modified UTF-7 of IMAP mailbox names (RFC 3501 §5.1.3): `&` opens a base64
//! run of UTF-16BE code units — `,` standing for `/` — closed by `-`, and `&-`
//! is a literal `&`. A run that does not decode is kept as it came: a mailbox
//! name only has to be readable.

use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine;

pub fn decode_modified_utf7(text: &str) -> String {
    let mut decoded = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        decoded.push_str(&rest[..start]);
        let encoded = &rest[start + 1..];
        let Some(end) = encoded.find('-') else {
            decoded.push_str(&rest[start..]);
            return decoded;
        };
        let verbatim = &rest[start..=start + end + 1];
        let run = &encoded[..end];
        rest = &encoded[end + 1..];
        if run.is_empty() {
            decoded.push('&');
            continue;
        }
        match decode_run(run) {
            Some(run) => decoded.push_str(&run),
            None => decoded.push_str(verbatim),
        }
    }
    decoded.push_str(rest);
    decoded
}

/// Base64 run to text, `None` when the bytes are not the UTF-16BE they claim.
fn decode_run(run: &str) -> Option<String> {
    let standard: String = run
        .chars()
        .map(|c| if c == ',' { '/' } else { c })
        .collect();
    let bytes = STANDARD_NO_PAD
        .decode(standard.trim_end_matches('='))
        .ok()?;
    if bytes.len() % 2 != 0 {
        return None;
    }
    let units = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .copied()
        .map(u16::from_be_bytes);
    char::decode_utf16(units)
        .collect::<Result<String, _>>()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_surrogate_pair_run_is_an_emoji() {
        assert_eq!(decode_modified_utf7("&2Dzf5g-"), "🏦");
        assert_eq!(decode_modified_utf7("&2Dzf5g- Pro"), "🏦 Pro");
    }

    #[test]
    fn an_empty_run_is_a_literal_ampersand() {
        assert_eq!(decode_modified_utf7("&-"), "&");
        assert_eq!(decode_modified_utf7("Tom &- Jerry"), "Tom & Jerry");
    }

    #[test]
    fn ascii_is_untouched() {
        assert_eq!(decode_modified_utf7("INBOX"), "INBOX");
        assert_eq!(
            decode_modified_utf7("[Gmail]/Sent Mail"),
            "[Gmail]/Sent Mail"
        );
        assert_eq!(decode_modified_utf7(""), "");
    }

    #[test]
    fn an_accented_run_mixes_with_ascii() {
        assert_eq!(decode_modified_utf7("Envoy&AOk-s"), "Envoyés");
        assert_eq!(decode_modified_utf7("Re&AOc-us &ANw-"), "Reçus Ü");
        assert_eq!(decode_modified_utf7("U&AO8-nal"), "Uïnal");
    }

    #[test]
    fn the_run_alphabet_takes_a_comma_for_a_slash() {
        assert_eq!(decode_modified_utf7("&AN8-"), "ß");
        assert_eq!(decode_modified_utf7("&b,8-"), "\u{6fff}");
        assert_eq!(decode_modified_utf7("&-,"), "&,");
    }

    #[test]
    fn an_undecodable_run_stays_as_it_came() {
        assert_eq!(decode_modified_utf7("&2Dzf5g"), "&2Dzf5g");
        assert_eq!(decode_modified_utf7("&2Dzf5-"), "&2Dzf5-");
        assert_eq!(decode_modified_utf7("&!!-"), "&!!-");
        assert_eq!(decode_modified_utf7("&2AA-"), "&2AA-");
        assert_eq!(decode_modified_utf7("a&2Dzf5g- &!!- fin"), "a🏦 &!!- fin");
    }
}
