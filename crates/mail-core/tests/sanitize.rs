use lavande_mail::{sanitize_html, sanitize_html_with_images};

fn body(html: &str) -> String {
    sanitize_html_with_images(html).expect("corps html")
}

fn stored(html: &str) -> String {
    sanitize_html(html).expect("corps html")
}

#[test]
fn an_inline_style_keeps_the_presentation_of_the_message() {
    let html = body(
        r##"<p style="color:#8b7cf6;padding:8px 12px;width:600px;line-height:1.6;text-align:center">Soldes</p>"##,
    );
    assert_eq!(
        html,
        r##"<p style="color:#8b7cf6;padding:8px 12px;width:600px;line-height:1.6;text-align:center">Soldes</p>"##
    );
}

#[test]
fn an_inline_style_is_normalised_from_its_tokens() {
    let html = body(
        r##"<p style="FONT-FAMILY:'Plus Jakarta Sans',Arial,sans-serif;font-size:14px!important;border-radius:8px">x</p>"##,
    );
    assert_eq!(
        html,
        r##"<p style="font-family:&quot;Plus Jakarta Sans&quot;, Arial, sans-serif;font-size:14px !important;border-radius:8px">x</p>"##
    );
}

#[test]
fn a_style_value_that_fetches_or_runs_is_dropped() {
    let html = body(
        r##"<p style="background:url(https://track.test/p.png);width:expression(alert(1));position:fixed;z-index:9;overflow:hidden;-moz-binding:url(https://track.test/b.xml);behavior:url(https://track.test/x.htc);color:javascript:alert(1);margin:10px">Texte</p>"##,
    );
    assert_eq!(html, r#"<p style="margin:10px">Texte</p>"#);
}

#[test]
fn a_dangerous_declaration_does_not_cost_its_neighbours() {
    let html = body(
        r##"<p style="color:#333;background:url(https://track.test/p.png);padding:4px">Texte</p>"##,
    );
    assert_eq!(html, r##"<p style="color:#333;padding:4px">Texte</p>"##);
}

#[test]
fn obfuscated_css_is_still_refused() {
    let escaped =
        body(r##"<p style="background:u\72 l(https://track.test/p.png);color:red">x</p>"##);
    assert_eq!(escaped, r##"<p style="color:red">x</p>"##);

    let commented = body(r##"<p style="co/**/lor:red">x</p>"##);
    assert_eq!(commented, "<p>x</p>");

    let shouty = body(r##"<p style="COLOR:RED;BACKGROUND:URL(https://track.test/p.png)">x</p>"##);
    assert_eq!(shouty, r##"<p style="color:RED">x</p>"##);

    let glued =
        body(r##"<p style="background:image-set(url(https://track.test/p.png) 1x)">x</p>"##);
    assert_eq!(glued, "<p>x</p>");
}

#[test]
fn a_broken_declaration_is_dropped_without_losing_the_others() {
    let html = body(r##"<p style="color;width:600px;font-size:14px">x</p>"##);
    assert_eq!(html, r##"<p style="width:600px;font-size:14px">x</p>"##);

    let unclosed = body(r##"<p style="color:red;width:600px">x</p>"##);
    assert_eq!(unclosed, r##"<p style="color:red;width:600px">x</p>"##);
}

#[test]
fn only_the_safe_display_values_are_kept() {
    let html = body(r##"<p style="display:block">a</p><p style="display:grid">b</p>"##);
    assert_eq!(html, r#"<p style="display:block">a</p><p>b</p>"#);
}

#[test]
fn a_style_block_survives_sanitized_and_comes_before_the_body() {
    let html = body(
        "<style>.promo{background-color:#8b7cf6;color:#fff}@import url(https://track.test/a.css);\
         @font-face{font-family:Vol;src:url(https://track.test/v.woff)}h1{margin:0}</style>\
         <h1 class=\"promo\">Promo</h1>",
    );
    assert_eq!(
        html,
        "<style>.promo{background-color:#8b7cf6;color:#fff}h1{margin:0}</style>\
         <h1 class=\"promo\">Promo</h1>"
    );
}

#[test]
fn a_style_block_keeps_its_media_query() {
    let html = body(
        "<style>@media only screen and (max-width:600px){.w{width:100%!important}}</style><p class=\"w\">x</p>",
    );
    assert_eq!(
        html,
        "<style>@media only screen and (max-width:600px){.w{width:100% !important}}</style>\
         <p class=\"w\">x</p>"
    );
}

#[test]
fn an_unsafe_at_rule_is_dropped_whole() {
    let html = body("<style>@supports (display:grid){a{color:red}}b{color:blue}</style><p>x</p>");
    assert_eq!(html, "<style>b{color:blue}</style><p>x</p>");
}

#[test]
fn a_style_block_cannot_close_the_element_early() {
    let html = body("<style>p{content:\"</style><script>alert(1)</script>\"}</style><p>x</p>");
    assert!(!html.contains("<script"), "{html}");
    assert!(!html.contains("alert"), "{html}");
    assert!(html.ends_with("<p>x</p>"), "{html}");
}

#[test]
fn a_style_block_goes_through_the_same_filter_as_an_inline_style() {
    let html = body(
        "<style>a{position:fixed;background:url(https://track.test/p.png);color:#333}\
         b{co/**/lor:red;width:expression(alert(1))}</style><a href=\"https://example.org\">lien</a>",
    );
    assert_eq!(
        html,
        "<style>a{color:#333}</style><a target=\"_blank\" href=\"https://example.org\" \
         rel=\"noopener noreferrer\">lien</a>"
    );
}

#[test]
fn a_style_only_message_has_no_body() {
    assert_eq!(sanitize_html("<style>p{color:red}</style>"), None);
    assert_eq!(
        sanitize_html_with_images("<style>p{color:red}</style>"),
        None
    );
}

#[test]
fn table_geometry_attributes_are_kept() {
    let html = body(
        r##"<table width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr align="center" valign="middle" bgcolor="#f6f3fd"><td width="50%" align="left" valign="top" bgcolor="rgb(255,255,255)">Total</td></tr></table>"##,
    );
    assert_eq!(
        html,
        r##"<table width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tbody><tr align="center" valign="middle" bgcolor="#f6f3fd"><td width="50%" align="left" valign="top" bgcolor="rgb(255,255,255)">Total</td></tr></tbody></table>"##
    );
}

#[test]
fn invalid_geometry_attributes_are_dropped() {
    let html = body(
        r##"<table width="600px" align="middle" cellpadding="0.5" border="1px"><tr><td width="12em" align="top" valign="center" bgcolor="javascript:alert(1)">x</td><td bgcolor="#12345">y</td><td bgcolor="notacolour">z</td></tr></table>"##,
    );
    assert_eq!(
        html,
        "<table><tbody><tr><td>x</td><td>y</td><td>z</td></tr></tbody></table>"
    );
}

#[test]
fn the_legacy_helpers_keep_their_validated_attributes() {
    let html = body(
        r##"<center><font color="#ff0000" face="Arial, sans-serif" size="3">Promo</font></center>\
        <table><caption>Tarifs</caption><tr><td>x</td></tr></table>"##,
    );
    assert_eq!(
        html,
        r##"<center><font color="#ff0000" face="Arial, sans-serif" size="3">Promo</font></center>\
        <table><caption>Tarifs</caption><tbody><tr><td>x</td></tr></tbody></table>"##
    );

    let stripped =
        body(r##"<font color="expression(alert(1))" face="Arial;url(x)" size="9">x</font>"##);
    assert_eq!(stripped, "<font>x</font>");
}

#[test]
fn a_marketing_mail_keeps_its_presentation() {
    let html = body(
        "<html><head><style>\
           .titre{font-family:'Georgia',serif;font-size:22px;color:#241b3a}\
           .bouton{background-color:#8b7cf6;color:#fff;border-radius:6px;padding:12px 24px}\
           @import url(https://track.test/pixel.css);\
         </style></head><body bgcolor=\"#ffffff\">\
         <table width=\"600\" align=\"center\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" \
           style=\"background-color:#ffffff;border-collapse:collapse\">\
         <tr><td style=\"padding:24px 16px;font-family:Arial,sans-serif;font-size:14px;color:#333333\">\
         <h1 class=\"titre\" style=\"margin:0 0 12px\">Soldes d'été</h1>\
         <p style=\"margin:0 0 16px;line-height:1.5\">Jusqu'à <strong>40 %</strong> de réduction.</p>\
         <a class=\"bouton\" href=\"https://boutique.example/soldes\" \
           style=\"display:inline-block;text-decoration:none;background-color:#8b7cf6;color:#ffffff\">\
           Voir les offres</a></td></tr></table></body></html>",
    );
    for kept in [
        "<style>.titre{font-family:\"Georgia\", serif;font-size:22px;color:#241b3a}\
         .bouton{background-color:#8b7cf6;color:#fff;border-radius:6px;padding:12px 24px}</style>",
        r##"<table width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border-collapse:collapse">"##,
        r#"<h1 class="titre" style="margin:0 0 12px">Soldes d'été</h1>"#,
        r#"<p style="margin:0 0 16px;line-height:1.5">Jusqu'à <strong>40 %</strong> de réduction.</p>"#,
        r#"<a target="_blank" class="bouton" href="https://boutique.example/soldes" style="display:inline-block;text-decoration:none;background-color:#8b7cf6;color:#ffffff" rel="noopener noreferrer">"#,
    ] {
        assert!(html.contains(kept), "manque {kept}\n{html}");
    }
    assert!(!html.contains("track.test"), "{html}");
    assert!(!html.contains("@import"), "{html}");
    assert!(!html.contains("bgcolor=\"#ffffff\""), "{html}");
}

#[test]
fn a_tracking_pixel_is_still_dropped_from_the_stored_body() {
    let html = stored(
        r##"<table width="600"><tr><td style="padding:8px">Soldes</td></tr></table>\
        <img src="https://track.test/p.gif" width="1" height="1" style="display:none">"##,
    );
    assert!(!html.contains("<img"), "{html}");
    assert!(!html.contains("track.test"), "{html}");
    assert!(
        html.contains(r#"<td style="padding:8px">Soldes</td>"#),
        "{html}"
    );
}

const CALLOUT_MAIL: &str = concat!(
    "<html><head><style>",
    ".callout{background-color:#fff9e6;border-left:4px solid #f0b429;border-radius:8px;padding:16px}",
    "pre.code{background-color:#f4f4f4;padding:12px;border-radius:6px}",
    "code{background-color:#f0f0f0;color:#c7254e;padding:1px 4px;border-radius:3px}",
    ".titre{color:#241b3a;font-family:'Georgia',serif}",
    "</style></head><body>",
    "<table width=\"600\" align=\"center\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" ",
    "bgcolor=\"#ffffff\"><tr><td style=\"padding:24px;font-size:14px;color:#333333\">",
    "<h1 class=\"titre\">Facture</h1>",
    "<div class=\"callout\">Encadré de classe</div>",
    "<table width=\"100%\" height=\"120\" bgcolor=\"#fff9e6\"><tr height=\"24\">",
    "<td height=\"24\" colspan=\"2\"></td></tr><tr>",
    "<td style=\"border-left:4px solid #f0b429;padding:12px\" bgcolor=\"#fff9e6\">Encadré de table</td>",
    "</tr></table>",
    "<div style=\"background-color:#fff9e6;border-left:4px solid #f0b429;padding:16px\">",
    "Encadré inline</div>",
    "<div style=\"background:lightyellow;border:1px solid #e0a800\">Encadré nommé</div>",
    "<div style=\"background-image:linear-gradient(90deg,#8b7cf6,#5b46e0);color:#ffffff\">Bouton</div>",
    "<pre class=\"code\">code de classe</pre>",
    "<pre style=\"background-color:#f4f4f4;padding:12px\"><code>code inline</code></pre>",
    "<p>Un <code>extrait</code> dans une phrase.</p>",
    "<blockquote style=\"border-left:3px solid #d0c9e0;background-color:#f6f3fd;padding-left:1em\">",
    "Cité</blockquote>",
    "<p style=\"color:#8b2f00\">Texte coloré</p>",
    "<font color=\"#ff0000\">Rouge</font>",
    "<span style=\"color:rgb(199, 37, 78)\">Rouge aussi</span>",
    "</td></tr></table></body></html>",
);

#[test]
fn a_callout_keeps_its_background_and_its_border_whatever_it_is_built_with() {
    let html = body(CALLOUT_MAIL);
    for kept in [
        ".callout{background-color:#fff9e6;border-left:4px solid #f0b429;border-radius:8px;padding:16px}",
        "pre.code{background-color:#f4f4f4;padding:12px;border-radius:6px}",
        "code{background-color:#f0f0f0;color:#c7254e;padding:1px 4px;border-radius:3px}",
        r##"bgcolor="#ffffff""##,
        r##"<div class="callout">Encadré de classe</div>"##,
        r##"<table width="100%" height="120" bgcolor="#fff9e6">"##,
        r##"<tr height="24"><td height="24" colspan="2"></td></tr>"##,
        r##"bgcolor="#fff9e6">Encadré de table</td>"##,
        r##"style="border-left:4px solid #f0b429;padding:12px""##,
        r##"style="background-color:#fff9e6;border-left:4px solid #f0b429;padding:16px""##,
        r##"style="background:lightyellow;border:1px solid #e0a800""##,
        r##"style="background-image:linear-gradient(90deg, #8b7cf6, #5b46e0);color:#ffffff""##,
        r##"<pre class="code">code de classe</pre>"##,
        r##"style="background-color:#f4f4f4;padding:12px""##,
        r##"<code>code inline</code>"##,
        r##"style="border-left:3px solid #d0c9e0;background-color:#f6f3fd;padding-left:1em""##,
        r##"style="color:#8b2f00">Texte coloré"##,
        r##"<font color="#ff0000">Rouge</font>"##,
        r##"style="color:rgb(199, 37, 78)"##,
    ] {
        assert!(html.contains(kept), "manque {kept}\n{html}");
    }
}

#[test]
fn the_callout_mail_keeps_nothing_that_could_run_bind_or_fetch() {
    let html = body(CALLOUT_MAIL);
    for refused in [
        "url(",
        "expression",
        "behavior",
        "javascript",
        "position",
        "z-index",
        "<script",
        "onerror",
        "@import",
    ] {
        assert!(!html.contains(refused), "{refused} survit\n{html}");
    }
}

#[test]
fn a_table_background_colour_survives_and_an_invalid_one_does_not() {
    let html =
        body(r##"<table bgcolor="#fff9e6"><tr><td bgcolor="lightyellow">a</td></tr></table>"##);
    assert_eq!(
        html,
        r##"<table bgcolor="#fff9e6"><tbody><tr><td bgcolor="lightyellow">a</td></tr></tbody></table>"##
    );

    let refused = body(
        r##"<table bgcolor="javascript:alert(1)"><tr><td bgcolor="url(https://track.test/p.png)">a</td></tr><tr><td bgcolor="expression(alert(1))">b</td></tr><tr><td bgcolor="#12345">c</td></tr><tr><td bgcolor="red;background:url(https://track.test/p.png)">d</td></tr></table>"##,
    );
    assert_eq!(
        refused,
        "<table><tbody><tr><td>a</td></tr><tr><td>b</td></tr><tr><td>c</td></tr><tr><td>d</td></tr></tbody></table>"
    );
}

#[test]
fn a_gradient_background_survives_and_a_remote_one_does_not() {
    let html = body(
        r##"<div style="background-image:linear-gradient(90deg,#8b7cf6,#5b46e0);background-size:cover;background-position:center;color:#ffffff">x</div>"##,
    );
    assert_eq!(
        html,
        r##"<div style="background-image:linear-gradient(90deg, #8b7cf6, #5b46e0);background-size:cover;background-position:center;color:#ffffff">x</div>"##
    );

    for css in [
        r##"<div style="color:#333;background-image:url(https://track.test/p.png)">x</div>"##,
        r##"<div style="color:#333;background-image:image-set(url(https://track.test/p.png) 1x)">x</div>"##,
        r##"<div style='color:#333;background-image:image-set("https://track.test/p.png" 1x)'>x</div>"##,
        r##"<div style="color:#333;background-image:-webkit-image-set('https://track.test/p.png' 1x)">x</div>"##,
        r##"<div style='color:#333;background:-webkit-cross-fade("x.png",#fff,.5)'>x</div>"##,
        r##"<div style="color:#333;background:url(https://track.test/p.png) #fff">x</div>"##,
    ] {
        let html = body(css);
        assert_eq!(html, r##"<div style="color:#333">x</div>"##, "{css}");
    }

    let named = body(
        r##"<div style="background-image:linear-gradient(180deg,rgba(139,124,246,.15),transparent)">x</div>"##,
    );
    assert_eq!(
        named,
        r##"<div style="background-image:linear-gradient(180deg, rgba(139, 124, 246, 0.15), transparent)">x</div>"##
    );
}

#[test]
fn an_id_survives_so_a_block_selector_finds_its_element() {
    let html = body(
        "<style>#hero .box{background-color:#fff9e6;border:1px solid #e0a800}</style>\
         <div id=\"hero\"><div class=\"box\">x</div></div>",
    );
    assert_eq!(
        html,
        "<style>#hero .box{background-color:#fff9e6;border:1px solid #e0a800}</style>\
         <div id=\"hero\"><div class=\"box\">x</div></div>"
    );

    let stripped =
        body(r##"<div id="hero" onclick="alert(1)" style="background-color:#fff9e6">x</div>"##);
    assert_eq!(
        stripped,
        r##"<div id="hero" style="background-color:#fff9e6">x</div>"##
    );

    let quoted = body(r##"<div id="&quot; onmouseover=&quot;alert(1)">x</div>"##);
    assert!(!quoted.contains("onmouseover=alert"), "{quoted}");
    assert!(
        quoted.contains(r##"id="&quot; onmouseover=&quot;alert(1)""##),
        "{quoted}"
    );
}

#[test]
fn a_cell_height_survives_and_an_invalid_one_does_not() {
    let html = body(
        r##"<table height="100%"><tr height="24"><td height="24" colspan="2"></td><td height="auto">x</td></tr></table>"##,
    );
    assert_eq!(
        html,
        r##"<table height="100%"><tbody><tr height="24"><td height="24" colspan="2"></td><td>x</td></tr></tbody></table>"##
    );
}
