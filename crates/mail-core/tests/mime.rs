use lavande_mail::model::PgpState;
use lavande_mail::parse_message;

const SIMPLE: &[u8] = b"From: Marc Delaunay <marc@mail.fr>\r\n\
To: Roman <roman@lavande.fr>\r\n\
Cc: Lea <lea@lavande.fr>\r\n\
Subject: Maquettes mobiles - version 3\r\n\
Date: Tue, 10 Nov 2026 11:02:00 +0100\r\n\
Message-ID: <abc123@mail.fr>\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n\
Bonjour,\r\n\
voici les maquettes.\r\n";

const RFC2047: &[u8] = b"From: =?UTF-8?B?TWFyYyBEZWxhdW5heQ==?= <marc@mail.fr>\r\n\
Subject: =?UTF-8?B?UsOpc3Vtw6kgZGUgbGEgcGhhc2UgMg==?=\r\n\
Date: Tue, 10 Nov 2026 11:02:00 +0000\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n\
Corps.\r\n";

const QUOTED_PRINTABLE: &[u8] = b"From: marc@mail.fr\r\n\
Subject: QP\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
Content-Transfer-Encoding: quoted-printable\r\n\
\r\n\
C'est bon pour moi, j'ai sign=C3=A9 l'avenant ce matin. On peut lancer la =\r\n\
phase 2 d=C3=A8s lundi.\r\n";

const BASE64: &[u8] = b"From: marc@mail.fr\r\n\
Subject: B64\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
UGhhc2UgMiBkw6hzIGx1bmRpLg==\r\n";

const HTML_ONLY: &[u8] = b"From: marc@mail.fr\r\n\
Subject: HTML\r\n\
Content-Type: text/html; charset=utf-8\r\n\
\r\n\
<html><body><p>Contrastes</p><p>revus &amp; valid&eacute;s</p></body></html>\r\n";

const ALTERNATIVE: &[u8] = b"From: marc@mail.fr\r\n\
Subject: Alternative\r\n\
Content-Type: multipart/alternative; boundary=\"sep\"\r\n\
\r\n\
--sep\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n\
Version texte.\r\n\
--sep\r\n\
Content-Type: text/html; charset=utf-8\r\n\
\r\n\
<p>Version HTML.</p>\r\n\
--sep--\r\n";

const ATTACHMENT: &[u8] = b"From: marc@mail.fr\r\n\
Subject: Piece jointe\r\n\
Content-Type: multipart/mixed; boundary=\"sep\"\r\n\
\r\n\
--sep\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n\
Ci-joint le planning.\r\n\
--sep\r\n\
Content-Type: application/pdf; name=\"planning.pdf\"\r\n\
Content-Disposition: attachment; filename=\"planning.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
JVBERi0xLjQK\r\n\
--sep--\r\n";

const SIGNED: &[u8] = b"From: marc@mail.fr\r\n\
Subject: Signe\r\n\
Content-Type: multipart/signed; micalg=pgp-sha256; protocol=\"application/pgp-signature\"; boundary=\"sep\"\r\n\
\r\n\
--sep\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n\
Message signe.\r\n\
--sep\r\n\
Content-Type: application/pgp-signature\r\n\
\r\n\
-----BEGIN PGP SIGNATURE-----\r\n\
-----END PGP SIGNATURE-----\r\n\
--sep--\r\n";

const ENCRYPTED: &[u8] = b"From: marc@mail.fr\r\n\
Subject: Chiffre\r\n\
Content-Type: multipart/encrypted; protocol=\"application/pgp-encrypted\"; boundary=\"sep\"\r\n\
\r\n\
--sep\r\n\
Content-Type: application/pgp-encrypted\r\n\
\r\n\
Version: 1\r\n\
--sep\r\n\
Content-Type: application/octet-stream; name=\"encrypted.asc\"\r\n\
\r\n\
-----BEGIN PGP MESSAGE-----\r\n\
-----END PGP MESSAGE-----\r\n\
--sep--\r\n";

const LONG_PREVIEW: &[u8] = b"From: marc@mail.fr\r\n\
Subject: Long\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n\
aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffffffffff gggggggggg \
hhhhhhhhhh iiiiiiiiii jjjjjjjjjj kkkkkkkkkk llllllllll mmmmmmmmmm nnnnnnnnnn \
oooooooooo pppppppppp qqqqqqqqqq rrrrrrrrrr ssssssssss tttttttttt uuuuuuuuuu\r\n";

#[test]
fn parses_simple_text_message() {
    let parsed = parse_message(SIMPLE).expect("parse");
    assert_eq!(parsed.subject, "Maquettes mobiles - version 3");
    assert_eq!(parsed.from.name.as_deref(), Some("Marc Delaunay"));
    assert_eq!(parsed.from.email, "marc@mail.fr");
    assert_eq!(parsed.to.len(), 1);
    assert_eq!(parsed.to[0].name.as_deref(), Some("Roman"));
    assert_eq!(parsed.cc.len(), 1);
    assert_eq!(parsed.cc[0].email, "lea@lavande.fr");
    assert_eq!(parsed.message_id.as_deref(), Some("abc123@mail.fr"));
    assert_eq!(
        parsed.body_text.as_deref(),
        Some("Bonjour,\r\nvoici les maquettes.\r\n")
    );
    assert!(parsed.body_html.is_none());
    assert_eq!(parsed.pgp, PgpState::None);
    assert_eq!(parsed.preview, "Bonjour, voici les maquettes.");
    assert_eq!(
        parsed.date.map(|date| date.to_rfc3339()),
        Some("2026-11-10T10:02:00+00:00".to_string())
    );
}

#[test]
fn decodes_rfc2047_subject_and_name() {
    let parsed = parse_message(RFC2047).expect("parse");
    assert_eq!(parsed.subject, "Résumé de la phase 2");
    assert_eq!(parsed.from.name.as_deref(), Some("Marc Delaunay"));
}

#[test]
fn decodes_quoted_printable_body() {
    let parsed = parse_message(QUOTED_PRINTABLE).expect("parse");
    assert_eq!(
        parsed.body_text.as_deref(),
        Some("C'est bon pour moi, j'ai signé l'avenant ce matin. On peut lancer la phase 2 dès lundi.\r\n")
    );
}

#[test]
fn decodes_base64_body() {
    let parsed = parse_message(BASE64).expect("parse");
    assert_eq!(parsed.body_text.as_deref(), Some("Phase 2 dès lundi."));
}

#[test]
fn falls_back_to_stripped_html() {
    let parsed = parse_message(HTML_ONLY).expect("parse");
    assert!(parsed.body_text.is_some());
    let text = parsed.body_text.expect("text");
    assert!(text.contains("Contrastes"), "{text}");
    assert!(text.contains("revus &"), "{text}");
    assert!(!text.contains('<'), "{text}");
    assert_eq!(parsed.preview, "Contrastes revus & validés");
}

#[test]
fn prefers_text_plain_in_alternative() {
    let parsed = parse_message(ALTERNATIVE).expect("parse");
    assert_eq!(parsed.body_text.as_deref(), Some("Version texte."));
    assert_eq!(parsed.body_html.as_deref(), Some("<p>Version HTML.</p>"));
    assert_eq!(parsed.preview, "Version texte.");
}

#[test]
fn reads_attachment_metadata() {
    let parsed = parse_message(ATTACHMENT).expect("parse");
    assert_eq!(parsed.attachments.len(), 1);
    let attachment = &parsed.attachments[0];
    assert_eq!(attachment.filename, "planning.pdf");
    assert_eq!(attachment.mime, "application/pdf");
    assert_eq!(attachment.size, 9);
    assert!(!attachment.inline);
    assert_eq!(parsed.body_text.as_deref(), Some("Ci-joint le planning."));
}

#[test]
fn detects_pgp_states() {
    assert_eq!(parse_message(SIGNED).expect("parse").pgp, PgpState::Signed);
    assert_eq!(
        parse_message(ENCRYPTED).expect("parse").pgp,
        PgpState::Encrypted
    );
}

#[test]
fn preview_is_compacted_and_truncated() {
    let parsed = parse_message(LONG_PREVIEW).expect("parse");
    assert_eq!(parsed.preview.chars().count(), 200);
    assert!(!parsed.preview.contains('\n'));
    assert!(!parsed.preview.contains("  "));
    assert!(parsed.preview.starts_with("aaaaaaaaaa bbbbbbbbbb"));
}

#[test]
fn reads_threading_headers() {
    const THREADED: &[u8] = b"From: a@b\r\nSubject: Re: x\r\nMessage-ID: <m2@b>\r\n\
In-Reply-To: <m1@b>\r\nReferences: <m0@b> <m1@b>\r\n\r\nbody\r\n";
    let parsed = parse_message(THREADED).expect("parse");
    assert_eq!(
        parsed.references,
        vec!["m0@b".to_string(), "m1@b".to_string()]
    );
    assert_eq!(parsed.in_reply_to.as_deref(), Some("m1@b"));
    assert_eq!(parsed.message_id.as_deref(), Some("m2@b"));
}

#[test]
fn missing_threading_headers_are_empty() {
    let parsed = parse_message(SIMPLE).expect("parse");
    assert!(parsed.references.is_empty());
    assert!(parsed.in_reply_to.is_none());
    assert!(parsed.attachments.is_empty());
}
