use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use lavande_mail::model::Address;
use lavande_mail::smtp::{
    build_message, sanitize_outgoing_html, OutgoingAttachment, OutgoingMessage,
};

const PNG: [u8; 12] = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
];

fn address(name: Option<&str>, email: &str) -> Address {
    Address {
        name: name.map(str::to_string),
        email: email.to_string(),
    }
}

fn message(html: Option<String>) -> OutgoingMessage {
    OutgoingMessage {
        from: address(None, "roman@lavande.test"),
        to: vec![address(Some("Camille"), "camille@studio-lilas.fr")],
        cc: Vec::new(),
        bcc: Vec::new(),
        subject: "Capture".to_string(),
        text: "Bonjour".to_string(),
        html,
        in_reply_to: None,
        references: Vec::new(),
        attachments: Vec::new(),
        pgp_sign: false,
        pgp_encrypt: false,
    }
}

fn data_url(mime: &str, data: &[u8]) -> String {
    format!("data:{mime};base64,{}", STANDARD.encode(data))
}

fn image(src: &str) -> String {
    format!("<p>Bonjour</p><img src=\"{src}\">")
}

fn raw_of(message: &OutgoingMessage) -> String {
    let email = build_message(message).expect("message construit");
    String::from_utf8_lossy(&email.formatted()).to_string()
}

fn content_ids(raw: &str) -> Vec<String> {
    raw.match_indices("Content-ID: <")
        .map(|(index, found)| {
            let rest = &raw[index + found.len()..];
            rest[..rest.find('>').expect("chevron fermant")].to_string()
        })
        .collect()
}

fn squashed(raw: &str) -> String {
    raw.chars().filter(|c| !c.is_whitespace()).collect()
}

#[test]
fn an_inline_png_becomes_a_related_cid_part() {
    let raw = raw_of(&message(Some(image(&data_url("image/png", &PNG)))));

    assert!(raw.contains("Content-Type: multipart/alternative"));
    assert!(raw.contains("Content-Type: multipart/related"));
    assert!(raw.contains("<img src=\"cid:"));
    assert!(raw.contains("Content-Disposition: inline"));
    assert!(raw.contains("Content-Type: image/png"));
    assert!(!raw.contains("data:image/png"));
    assert!(squashed(&raw).contains(&STANDARD.encode(PNG)));

    let ids = content_ids(&raw);
    assert_eq!(ids.len(), 1, "une image, un Content-ID");
    assert!(ids[0].ends_with("@lavande"));
    assert!(raw.contains(&format!("cid:{}", ids[0])));
}

#[test]
fn each_inline_image_gets_its_own_content_id() {
    let second = [0x47, 0x49, 0x46, 0x38];
    let html = format!(
        "<p>Deux captures</p>\n<img src=\"{}\">\n<img src=\"{}\">",
        data_url("image/png", &PNG),
        data_url("image/gif", &second)
    );
    let raw = raw_of(&message(Some(html)));

    let ids = content_ids(&raw);
    assert_eq!(ids.len(), 2, "un Content-ID par image");
    assert_ne!(ids[0], ids[1]);
    assert!(raw.contains(&format!("cid:{}", ids[0])));
    assert!(raw.contains(&format!("cid:{}", ids[1])));
    assert!(raw.contains("Content-Type: image/gif"));
    assert!(
        raw.contains("GIF8"),
        "les octets décodés sont ceux de l'image"
    );
}

#[test]
fn a_data_url_of_another_type_stays_in_the_body() {
    for source in [
        data_url("image/svg+xml", b"<svg></svg>"),
        data_url("text/html", b"<b>x</b>"),
        "data:image/png,not-base64".to_string(),
    ] {
        let raw = raw_of(&message(Some(image(&source))));
        assert!(
            !raw.contains("multipart/related"),
            "aucune image en ligne pour {source}"
        );
        assert!(!raw.contains("Content-ID"));
        assert!(raw.contains(&format!("src=\"{source}\"")), "corps intact");
    }
}

#[test]
fn an_image_over_the_size_cap_is_dropped_from_the_body() {
    let too_large = vec![0u8; 10 * 1024 * 1024 + 1];
    let raw = raw_of(&message(Some(image(&data_url("image/png", &too_large)))));

    assert!(!raw.contains("<img"), "l'image est retirée du corps");
    assert!(!raw.contains("multipart/related"));
    assert!(raw.contains("<p>Bonjour</p>"));
    assert!(raw.contains("Content-Type: text/html"));
}

#[test]
fn a_message_without_images_keeps_its_shape() {
    let text_only = raw_of(&message(None));
    assert!(text_only.contains("Content-Type: text/plain"));
    assert!(!text_only.contains("multipart"));

    let html_only = raw_of(&message(Some("<p>Bonjour</p>".to_string())));
    assert!(html_only.contains("Content-Type: multipart/alternative"));
    assert!(!html_only.contains("multipart/related"));
    assert!(!html_only.contains("Content-ID"));
}

#[test]
fn attachments_and_inline_images_nest_alternative_and_related() {
    let mut outgoing = message(Some(image(&data_url("image/png", &PNG))));
    outgoing.attachments = vec![OutgoingAttachment {
        filename: "plan.pdf".to_string(),
        mime: "application/pdf".to_string(),
        data: b"%PDF-1.4".to_vec(),
    }];
    let raw = raw_of(&outgoing);

    let mixed = raw.find("Content-Type: multipart/mixed").expect("mixed");
    let alternative = raw
        .find("Content-Type: multipart/alternative")
        .expect("alternative");
    let related = raw
        .find("Content-Type: multipart/related")
        .expect("related");
    let plain = raw.find("Content-Type: text/plain").expect("text/plain");
    let pdf = raw.find("plan.pdf").expect("pièce jointe");

    assert!(mixed < alternative, "mixed emballe l'alternative");
    assert!(alternative < plain, "le texte précède le HTML");
    assert!(plain < related, "le HTML est la racine du related");
    assert!(related < pdf, "la pièce jointe vient après le corps");
    assert_eq!(squashed(&raw).matches(&STANDARD.encode(PNG)).count(), 1);
}

#[test]
fn the_outgoing_html_keeps_its_inline_images() {
    let source = data_url("image/png", &PNG);
    let html = format!(
        "<p>Bonjour<script>alert(1)</script><img src=\"{source}\" onerror=\"alert(1)\" alt=\"capture\"></p>"
    );
    let cleaned = sanitize_outgoing_html(&html).expect("corps lisible");

    assert!(!cleaned.contains("<script"));
    assert!(!cleaned.contains("onerror"));
    assert!(cleaned.contains(&format!("<img src=\"{source}\"")));
    assert!(cleaned.contains("alt=\"capture\""));
}

#[test]
fn the_outgoing_html_drops_remote_images() {
    let cleaned =
        sanitize_outgoing_html("<p>Bonjour</p><img src=\"https://tracker.example/pixel.png\">")
            .expect("corps lisible");

    assert_eq!(cleaned, "<p>Bonjour</p>");
}

#[test]
fn the_outgoing_html_of_a_script_only_body_is_none() {
    assert_eq!(sanitize_outgoing_html("<script>alert(1)</script>"), None);
}
