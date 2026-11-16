use lavande_mail::mime;
use lavande_mail::model::PgpState;
use lavande_mail::{parse_message, PgpKeyring};

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
        Some("Bonjour,\nvoici les maquettes.")
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
        Some("C'est bon pour moi, j'ai signé l'avenant ce matin. On peut lancer la phase 2 dès lundi.")
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
    assert!(parsed.preview.chars().count() <= 201, "{}", parsed.preview);
    assert!(parsed.preview.ends_with('…'));
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

fn message_of(content_type: &str, body: &str) -> Vec<u8> {
    format!(
        "From: promo@boutique.fr\r\nSubject: Test\r\nContent-Type: {content_type}; charset=utf-8\r\n\r\n{body}\r\n"
    )
    .into_bytes()
}

fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00A0}' | '\u{00AD}' | '\u{034F}' | '\u{061C}' | '\u{2007}' | '\u{2009}' | '\u{202F}' | '\u{FEFF}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
    ) || (c.is_control() && c != '\n')
}

#[test]
fn marketing_html_preview_is_readable() {
    let html = "<p>Soldes&nbsp;d'été&nbsp;: jusqu'à&nbsp;&nbsp;40&nbsp;% de réduction sur toute la boutique</p>\n\
         <p>Livraison offerte dès 30&nbsp;€, retours gratuits pendant trente jours, paiement en trois fois</p>\n\
         <p>Offre extra\u{00AD}ordinaire réservée aux abonnés de la newsletter</p>";
    let parsed = parse_message(&message_of("text/html", html)).expect("parse");
    let preview = parsed.preview.as_str();
    assert!(
        preview.starts_with("Soldes d'été : jusqu'à 40 % de réduction"),
        "{preview}"
    );
    assert!(preview.chars().count() <= 201, "{preview}");
    assert!(preview.ends_with('…'), "{preview}");
    assert!(!preview.contains("  "), "{preview}");
    assert!(!preview.chars().any(is_invisible), "{preview}");
    let head = preview.trim_end_matches('…');
    let text = parsed.body_text.as_deref().expect("text");
    let compact = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    assert!(compact.starts_with(head), "{head} / {compact}");
    assert!(text.contains("extraordinaire"), "{text}");
    assert!(!text.chars().any(is_invisible), "{text}");
}

#[test]
fn zero_width_non_joiner_does_not_glue_words() {
    let parsed = parse_message(&message_of("text/plain", "avec\u{200C}l'écran")).expect("parse");
    assert_eq!(parsed.body_text.as_deref(), Some("avec l'écran"));
    assert_eq!(parsed.preview, "avec l'écran");
}

#[test]
fn decorative_separators_are_dropped() {
    let body = "Bonjour,\r\n----\r\n•••\r\nLe devis suit.\r\n=====\r\n___\r\n";
    let parsed = parse_message(&message_of("text/plain", body)).expect("parse");
    assert_eq!(
        parsed.body_text.as_deref(),
        Some("Bonjour,\n\nLe devis suit.")
    );
    assert_eq!(parsed.preview, "Bonjour, Le devis suit.");
}

#[test]
fn html_is_sanitized_at_ingestion() {
    let html = "<html><head><script>alert('x')</script><style>p{color:red}</style></head>\
        <body><p onclick=\"steal()\">Bonjour <b>monde</b></p>\
        <iframe src=\"https://evil.test\">piege</iframe>\
        <img src=\"https://track.test/p.gif\" onerror=\"alert(1)\">\
        <a href=\"javascript:alert(1)\">lien piege</a>\
        <a href=\"https://example.com/x\" onclick=\"x()\" style=\"color:red\" title=\"exemple\">lien</a>\
        <form action=\"/x\"><input name=\"a\"></form>\
        <object data=\"x.swf\"></object><svg onload=\"x()\"></svg></body></html>";
    let parsed = parse_message(&message_of("text/html", html)).expect("parse");
    let out = parsed.body_html.as_deref().expect("html");
    for forbidden in [
        "<script",
        "<iframe",
        "<img",
        "<form",
        "<input",
        "<object",
        "<svg",
        "javascript:",
        "onclick",
        "onerror",
        "onload",
        "position",
    ] {
        assert!(!out.contains(forbidden), "{forbidden} in {out}");
    }
    assert!(out.starts_with("<style>p{color:red}</style>"), "{out}");
    assert!(out.contains(r#"style="color:red""#), "{out}");
    assert!(out.contains("Bonjour <b>monde</b>"), "{out}");
    assert!(out.contains("href=\"https://example.com/x\""), "{out}");
    assert!(out.contains("title=\"exemple\""), "{out}");
    assert!(out.contains("rel=\"noopener noreferrer\""), "{out}");
    assert!(out.contains("target=\"_blank\""), "{out}");
    assert!(out.contains("lien piege"), "{out}");
    assert!(
        parsed.preview.starts_with("Bonjour monde"),
        "{}",
        parsed.preview
    );
    assert!(!parsed.preview.contains("javascript"), "{}", parsed.preview);
    assert!(!parsed.preview.contains("color:red"), "{}", parsed.preview);
    assert!(
        !parsed
            .body_text
            .as_deref()
            .unwrap_or_default()
            .contains("color"),
        "{}",
        parsed.body_text.as_deref().unwrap_or_default()
    );
}

#[test]
fn an_autolink_keeps_its_url_in_the_text_body() {
    let html = "<p>Suivi : <https://example.com/x/a?b=1></p>\
        <p>Écrire à <mailto:support@example.org>, archive sur <ftp://ftp.example/pub></p>";
    let parsed = parse_message(&message_of("text/html", html)).expect("parse");
    let text = parsed.body_text.as_deref().expect("texte");
    for url in [
        "https://example.com/x/a?b=1",
        "mailto:support@example.org",
        "ftp://ftp.example/pub",
    ] {
        assert!(text.contains(url), "{url} absent de {text}");
        assert!(
            parsed.preview.contains(url),
            "{url} absent de {}",
            parsed.preview
        );
    }
    assert!(!text.contains('<'), "{text}");
    let out = parsed.body_html.as_deref().expect("html");
    assert!(out.contains("https://example.com/x/a?b=1"), "{out}");
    assert!(!out.contains("<https"), "{out}");
}

#[test]
fn an_autolink_only_body_survives() {
    let parsed = parse_message(&message_of("text/html", "<https://example.com/x>")).expect("parse");
    assert_eq!(parsed.body_text.as_deref(), Some("https://example.com/x"));
    assert_eq!(parsed.preview, "https://example.com/x");
    assert_eq!(parsed.body_html.as_deref(), Some("https://example.com/x\n"));
}

#[test]
fn an_escaped_autolink_keeps_its_angle_brackets() {
    let parsed = parse_message(&message_of(
        "text/html",
        "<p>Voir &lt;https://example.com/x&gt;</p>",
    ))
    .expect("parse");
    assert_eq!(
        parsed.body_text.as_deref(),
        Some("Voir <https://example.com/x>")
    );
}

#[test]
fn image_only_html_has_no_body() {
    let html = "<img src=\"https://track.test/pixel.gif\" width=\"1\" height=\"1\"><script>var a=1;</script>";
    let parsed = parse_message(&message_of("text/html", html)).expect("parse");
    assert_eq!(parsed.body_html, None);
    assert!(parsed.body_text.as_deref().unwrap_or_default().is_empty());
    assert!(parsed.preview.is_empty());
}

const RELATED: &[u8] = b"From: camille@studio-lilas.fr\r\n\
Subject: Capture\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/related; boundary=\"rel\"\r\n\
\r\n\
--rel\r\n\
Content-Type: text/html; charset=utf-8\r\n\
\r\n\
<p>Voici la capture <img src=\"cid:abc@lavande\" alt=\"capture\"></p>\r\n\
--rel\r\n\
Content-Type: image/png\r\n\
Content-ID: <abc@lavande>\r\n\
Content-Transfer-Encoding: base64\r\n\
Content-Disposition: inline; filename=\"capture.png\"\r\n\
\r\n\
iVBORw0KGgo=\r\n\
--rel--\r\n";

#[test]
fn an_inline_cid_image_reaches_the_body_as_a_data_url() {
    let parsed = parse_message(RELATED).expect("parse");
    let html = parsed.body_html.as_deref().expect("html");
    assert!(
        html.contains(r#"<img src="data:image/png;base64,iVBORw0KGgo=" alt="capture">"#),
        "{html}"
    );
    assert!(!html.contains("cid:"), "{html}");
    assert!(
        parsed.preview.contains("Voici la capture"),
        "{}",
        parsed.preview
    );

    let on_demand = mime::html_with_images(RELATED, &PgpKeyring::default())
        .expect("lecture")
        .expect("corps html");
    assert_eq!(on_demand, html);
}

#[test]
fn a_cid_without_its_part_leaves_no_image() {
    let raw = String::from_utf8(RELATED.to_vec())
        .expect("utf8")
        .replace("<abc@lavande>", "<autre@lavande>");
    let parsed = parse_message(raw.as_bytes()).expect("parse");
    let html = parsed.body_html.as_deref().expect("html");
    assert!(!html.contains("<img"), "{html}");
    assert!(!html.contains("cid:"), "{html}");
    assert!(html.contains("Voici la capture"), "{html}");
}

#[test]
fn a_cid_part_of_another_type_is_not_inlined() {
    let raw = String::from_utf8(RELATED.to_vec())
        .expect("utf8")
        .replace("Content-Type: image/png", "Content-Type: text/plain");
    let parsed = parse_message(raw.as_bytes()).expect("parse");
    let html = parsed.body_html.as_deref().expect("html");
    assert!(!html.contains("<img"), "{html}");
    assert!(!html.contains("data:"), "{html}");
    assert!(!html.contains("cid:"), "{html}");
}

#[test]
fn table_markup_survives_sanitizing() {
    let html = "<table><thead><tr><th>Poste</th></tr></thead>\
        <tbody><tr><td colspan=\"2\">Total</td><td rowspan=\"3\">TVA</td></tr></tbody></table>";
    let parsed = parse_message(&message_of("text/html", html)).expect("parse");
    let out = parsed.body_html.as_deref().expect("html");
    assert!(out.contains("<table>"), "{out}");
    assert!(out.contains("<td colspan=\"2\">Total</td>"), "{out}");
    assert!(out.contains("<td rowspan=\"3\">TVA</td>"), "{out}");
    assert!(parsed.preview.contains("Total"), "{}", parsed.preview);
    assert!(parsed.preview.contains("TVA"), "{}", parsed.preview);
    let text = parsed.body_text.as_deref().expect("texte");
    assert!(text.contains("Poste"), "{text}");
    assert!(!text.contains("PosteTotal"), "cellules collées : {text}");
    assert!(!text.contains("TotalTVA"), "cellules collées : {text}");
}

const SNIPPET_PLAIN: &[u8] = b"From: marc@mail.fr\r\n\
Subject: Apercu\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n";

const SNIPPET_HTML: &[u8] = b"From: marc@mail.fr\r\n\
Subject: HTML\r\n\
Content-Type: text/html; charset=utf-8\r\n\
\r\n";

const SNIPPET_MULTIPART: &[u8] = b"From: marc@mail.fr\r\n\
Subject: Multipart\r\n\
Content-Type: multipart/mixed; boundary=\"sep\"\r\n\
\r\n";

const SNIPPET_BASE64: &[u8] = b"From: marc@mail.fr\r\n\
Subject: B64\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n";

const SNIPPET_PGP: &[u8] = b"From: marc@mail.fr\r\n\
Subject: Scelle\r\n\
Content-Type: multipart/encrypted; protocol=\"application/pgp-encrypted\"; boundary=\"pgp\"\r\n\
\r\n";

#[test]
fn a_snippet_fills_the_preview_and_nothing_else() {
    let parsed =
        mime::parse_headers_with_snippet(SNIPPET_PLAIN, b"Bonjour,\r\nvoici les maquettes.\r\n")
            .expect("parse");
    assert_eq!(parsed.preview, "Bonjour, voici les maquettes.");
    assert_eq!(parsed.subject, "Apercu");
    assert!(parsed.body_text.is_none());
    assert!(parsed.body_html.is_none());
    assert!(parsed.attachments.is_empty());
}

#[test]
fn an_html_snippet_gives_its_text() {
    let parsed = mime::parse_headers_with_snippet(
        SNIPPET_HTML,
        b"<html><body><p>Contrastes</p><p>revus</p></body></html>",
    )
    .expect("parse");
    assert_eq!(parsed.preview, "Contrastes revus");
    assert!(parsed.body_html.is_none());
}

#[test]
fn a_multipart_snippet_gives_its_first_text_part() {
    let fragment: &[u8] = b"--sep\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n\
Le planning avance.\r\n\
--sep\r\n\
Content-Type: application/pdf; name=\"p.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
JVBERi0xLjQK";
    let parsed = mime::parse_headers_with_snippet(SNIPPET_MULTIPART, fragment).expect("parse");
    assert_eq!(parsed.preview, "Le planning avance.");
    assert!(!parsed.preview.contains("--sep"), "{}", parsed.preview);
    assert!(parsed.body_text.is_none());
    assert!(parsed.body_html.is_none());
    assert!(parsed.attachments.is_empty());
}

#[test]
fn an_encoded_snippet_is_decoded_before_the_preview() {
    let parsed = mime::parse_headers_with_snippet(SNIPPET_BASE64, b"UGhhc2UgMiBkw6hzIGx1bmRpLg==")
        .expect("parse");
    assert_eq!(parsed.preview, "Phase 2 dès lundi.");
}

#[test]
fn an_encrypted_snippet_never_leaks_into_the_preview() {
    let fragment: &[u8] = b"--pgp\r\n\
Content-Type: application/pgp-encrypted\r\n\
\r\n\
Version: 1\r\n\
--pgp\r\n\
Content-Type: application/octet-stream\r\n\
\r\n\
-----BEGIN PGP MESSAGE-----\r\n\
hQEMA0vTk3HhKzXBAQf+J1mS\r\n\
-----END PGP MESSAGE-----";
    let parsed = mime::parse_headers_with_snippet(SNIPPET_PGP, fragment).expect("parse");
    assert_eq!(parsed.preview, "");
    assert_eq!(parsed.pgp, PgpState::Encrypted);
}

#[test]
fn an_undecodable_snippet_leaves_the_preview_empty() {
    let garbage: &[u8] = b"aGVsbG8gd29ybGQgdGhpcyBpcyBhIHZlcnkgbG9uZyBiYXNlNjQgcGF5bG9hZA==";
    let parsed = mime::parse_headers_with_snippet(SNIPPET_PLAIN, garbage).expect("parse");
    assert_eq!(parsed.preview, "");

    let parsed = mime::parse_headers_with_snippet(SNIPPET_PLAIN, b"").expect("parse");
    assert_eq!(parsed.preview, "");
}
