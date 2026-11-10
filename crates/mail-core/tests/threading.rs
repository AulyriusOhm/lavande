use lavande_mail::model::thread_key;
use lavande_mail::thread_id;
use lavande_mail::threading::{normalize_subject, split_ids};

fn references(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

#[test]
fn references_chain_wins() {
    let first = thread_id(
        "perso",
        "Re: Planning",
        Some("<m3@x>"),
        Some("<m2@x>"),
        &references(&["<m1@x>", "<m2@x>"]),
    );
    let root = thread_id("perso", "Planning", Some("<m1@x>"), None, &[]);
    assert_eq!(first, root);
    assert_ne!(
        first,
        thread_id("perso", "Planning", Some("<m9@x>"), None, &[])
    );
}

#[test]
fn in_reply_to_is_the_fallback() {
    let reply = thread_id("perso", "Re: Planning", Some("<m2@x>"), Some("<m1@x>"), &[]);
    let root = thread_id("perso", "Planning", Some("<m1@x>"), None, &[]);
    assert_eq!(reply, root);
}

#[test]
fn subject_fallback_normalizes_prefixes_and_accents() {
    let a = thread_id("perso", "Réunion équipe", None, None, &[]);
    let b = thread_id("perso", "RE: Réunion équipe", None, None, &[]);
    let c = thread_id("perso", "Fwd: RE: réunion   ÉQUIPE", None, None, &[]);
    let d = thread_id("perso", "Re[2]: Tr: reunion equipe", None, None, &[]);
    assert_eq!(a, b);
    assert_eq!(a, c);
    assert_eq!(a, d);
    assert_eq!(a.len(), 16);
    assert_ne!(a, thread_id("perso", "Autre sujet", None, None, &[]));
}

#[test]
fn accounts_do_not_share_threads() {
    let perso = thread_id(
        "perso",
        "Planning",
        Some("<m1@x>"),
        None,
        &references(&["<m1@x>"]),
    );
    let pro = thread_id(
        "pro",
        "Planning",
        Some("<m1@x>"),
        None,
        &references(&["<m1@x>"]),
    );
    assert_ne!(perso, pro);
    assert_eq!(thread_key("perso", &perso), format!("perso:{perso}"));
}

#[test]
fn empty_subject_falls_back_to_message_id() {
    assert_ne!(
        thread_id("perso", "", Some("<a@x>"), None, &[]),
        thread_id("perso", "   ", Some("<b@x>"), None, &[])
    );
    assert_eq!(
        thread_id("perso", "", Some("<a@x>"), None, &[]),
        thread_id("perso", "", Some("<a@x>"), None, &[])
    );
}

#[test]
fn subject_normalization_is_readable() {
    assert_eq!(
        normalize_subject("  Re:  Fwd:  ÉTÉ  à  Paris "),
        "ete a paris"
    );
    assert_eq!(normalize_subject("AW: Æther"), "aether");
    assert_eq!(normalize_subject("Sans préfixe"), "sans prefixe");
}

#[test]
fn splits_message_id_lists() {
    assert_eq!(
        split_ids("<a@x> <b@x>"),
        vec!["a@x".to_string(), "b@x".to_string()]
    );
    assert_eq!(split_ids("<a@x>"), vec!["a@x".to_string()]);
    assert_eq!(
        split_ids("a@x b@x"),
        vec!["a@x".to_string(), "b@x".to_string()]
    );
    assert!(split_ids("").is_empty());
}
