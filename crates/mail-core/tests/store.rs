use std::time::{Duration, Instant};

use chrono::{TimeZone, Utc};
use lavande_mail::mime;
use lavande_mail::model::{Address, AttachmentMeta, Flags, Folder, FolderRole, Message, PgpState};
use lavande_mail::pgp::PgpDetail;
use lavande_mail::store::{FolderCount, SearchFilter};
use lavande_mail::Store;

fn open() -> Store {
    let store = Store::open_in_memory().expect("open");
    store.migrate().expect("migrate");
    store
        .upsert_account("perso", "Perso", "roman@lavande.fr")
        .expect("account");
    for (path, name, role) in [
        ("INBOX", "Boite de reception", FolderRole::Inbox),
        ("Sent", "Envoyes", FolderRole::Sent),
        ("Archive", "Archives", FolderRole::Archive),
    ] {
        let folder = Folder {
            account_id: "perso".to_string(),
            path: path.to_string(),
            name: name.to_string(),
            role,
            uidvalidity: 7,
            uidnext: 10,
            last_sync_at: None,
            modseq: None,
            delimiter: None,
        };
        store.upsert_folder(&folder).expect("folder");
    }
    store
}

fn date(day: u32) -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, day, 10, 0, 0)
        .single()
        .expect("date")
}

fn message(uid: u32, thread: &str, name: &str, subject: &str, day: u32) -> Message {
    Message {
        account_id: "perso".to_string(),
        folder_path: "INBOX".to_string(),
        uid,
        uidvalidity: 7,
        thread_id: thread.to_string(),
        message_id: Some(format!("<m{uid}@x>")),
        in_reply_to: None,
        references: Vec::new(),
        from: Address {
            name: Some(name.to_string()),
            email: format!("{}@mail.fr", name.to_lowercase()),
        },
        to: vec![Address {
            name: Some("Roman".to_string()),
            email: "roman@lavande.fr".to_string(),
        }],
        cc: Vec::new(),
        subject: subject.to_string(),
        date: Some(date(day)),
        flags: Flags::default(),
        size: 1200,
        pgp: PgpState::None,
        pgp_detail: None,
        preview: format!("preview {uid}"),
        body_text: Some("corps".to_string()),
        body_html: None,
        attachments: Vec::new(),
    }
}

#[test]
fn upsert_is_idempotent() {
    let store = open();
    let mut mail = message(1, "t1", "Marc", "Planning", 10);
    store.upsert_message(&mail).expect("first");
    mail.subject = "Planning v2".to_string();
    mail.attachments = vec![AttachmentMeta {
        filename: "planning.pdf".to_string(),
        mime: "application/pdf".to_string(),
        size: 8,
        inline: false,
    }];
    store.upsert_message(&mail).expect("second");
    store.upsert_message(&mail).expect("third");

    let messages = store
        .messages_in_folder("perso", "INBOX", -1, 0)
        .expect("list");
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].subject, "Planning v2");
    assert_eq!(messages[0].attachments, mail.attachments);

    let stored = store
        .get_message("perso", "INBOX", 1)
        .expect("get")
        .expect("present");
    assert_eq!(stored, mail);
    assert!(store
        .get_message("perso", "INBOX", 99)
        .expect("get")
        .is_none());
}

#[test]
fn flags_body_and_delete() {
    let store = open();
    let mut mail = message(1, "t1", "Marc", "Planning", 10);
    mail.attachments.push(AttachmentMeta {
        filename: "a.png".to_string(),
        mime: "image/png".to_string(),
        size: 4,
        inline: true,
    });
    store.upsert_message(&mail).expect("insert");

    let flags = Flags {
        unread: false,
        starred: true,
        answered: true,
    };
    store.set_flags("perso", "INBOX", 1, &flags).expect("flags");
    let stored = store
        .get_message("perso", "INBOX", 1)
        .expect("get")
        .expect("present");
    // set_flags n'écrit que unread/starred : answered appartient à la synchro.
    assert_eq!(
        stored.flags,
        Flags {
            unread: false,
            starred: true,
            answered: false
        }
    );

    store
        .set_flags_batch("perso", "INBOX", &[(1, flags)])
        .expect("batch");
    store
        .set_flags(
            "perso",
            "INBOX",
            1,
            &Flags {
                unread: true,
                starred: false,
                answered: false,
            },
        )
        .expect("flags");
    let stored = store
        .get_message("perso", "INBOX", 1)
        .expect("get")
        .expect("present");
    assert_eq!(
        stored.flags,
        Flags {
            unread: true,
            starred: false,
            answered: true
        }
    );

    let parsed = mime::parse_message(RAW_BODY).expect("parse");
    store.set_body("perso", "INBOX", 1, &parsed).expect("body");
    let stored = store
        .get_message("perso", "INBOX", 1)
        .expect("get")
        .expect("present");
    assert_eq!(stored.body_text.as_deref(), Some("Le planning avance."));
    assert!(stored
        .body_html
        .as_deref()
        .is_some_and(|html| html.contains("Le planning avance.")));
    assert_eq!(stored.preview, "Le planning avance.");
    assert_eq!(
        stored.attachments,
        vec![AttachmentMeta {
            filename: "a.png".to_string(),
            mime: "image/png".to_string(),
            size: 3,
            inline: false,
        }]
    );
    assert_eq!(stored.pgp, PgpState::None);
    assert_eq!(stored.pgp_detail, None);

    assert!(store.set_flags("perso", "INBOX", 42, &flags).is_err());

    store.delete_message("perso", "INBOX", 1).expect("delete");
    assert!(store
        .get_message("perso", "INBOX", 1)
        .expect("get")
        .is_none());
    assert!(store
        .messages_in_folder("perso", "INBOX", -1, 0)
        .expect("list")
        .is_empty());
    assert!(store.delete_message("perso", "INBOX", 1).is_err());
}

#[test]
fn flags_in_folder_reads_every_message() {
    let store = open();
    let mut starred = message(2, "t1", "Marc", "Etoile", 10);
    starred.flags = Flags {
        unread: false,
        starred: true,
        answered: true,
    };
    store
        .upsert_message(&message(1, "t1", "Marc", "Neuf", 10))
        .expect("unread");
    store.upsert_message(&starred).expect("starred");

    let flags = store.flags_in_folder("perso", "INBOX").expect("flags");
    assert_eq!(flags.len(), 2);
    assert_eq!(flags[&1], Flags::default());
    assert_eq!(flags[&2], starred.flags);
    assert!(store
        .flags_in_folder("perso", "Archive")
        .expect("empty")
        .is_empty());
}

#[test]
fn deletes_many_messages_at_once() {
    let store = open();
    for uid in [1, 2, 3] {
        store
            .upsert_message(&message(uid, "t1", "Marc", "Sujet", 10))
            .expect("insert");
    }

    assert_eq!(
        store.delete_messages("perso", "INBOX", &[]).expect("none"),
        0
    );
    assert_eq!(
        store
            .delete_messages("perso", "INBOX", &[1, 3, 42])
            .expect("delete"),
        2
    );
    let left = store
        .messages_in_folder("perso", "INBOX", -1, 0)
        .expect("list");
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].uid, 2);
    assert!(store
        .get_message("perso", "INBOX", 1)
        .expect("get")
        .is_none());
    assert_eq!(
        store
            .delete_messages("perso", "INBOX", &[1])
            .expect("again"),
        0
    );
}

#[test]
fn set_flags_batch_updates_many_rows() {
    let store = open();
    for uid in [1, 2, 3] {
        store
            .upsert_message(&message(uid, "t1", "Marc", "Sujet", 10))
            .expect("insert");
    }
    let read = Flags {
        unread: false,
        starred: true,
        answered: false,
    };
    let answered = Flags {
        unread: true,
        starred: false,
        answered: true,
    };

    assert_eq!(
        store.set_flags_batch("perso", "INBOX", &[]).expect("none"),
        0
    );
    assert_eq!(
        store
            .set_flags_batch("perso", "INBOX", &[(1, read), (2, answered), (42, read)])
            .expect("batch"),
        2
    );
    let flags = store.flags_in_folder("perso", "INBOX").expect("flags");
    assert_eq!(flags[&1], read);
    assert_eq!(flags[&2], answered);
    assert_eq!(flags[&3], Flags::default());
}

#[test]
fn lists_messages_by_date_desc_with_paging() {
    let store = open();
    for (uid, day) in [(1, 9), (2, 11), (3, 10)] {
        store
            .upsert_message(&message(uid, "t1", "Marc", "Sujet", day))
            .expect("insert");
    }
    let all = store
        .messages_in_folder("perso", "INBOX", -1, 0)
        .expect("list");
    assert_eq!(
        all.iter().map(|message| message.uid).collect::<Vec<_>>(),
        vec![2, 3, 1]
    );
    let page = store
        .messages_in_folder("perso", "INBOX", 1, 1)
        .expect("page");
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].uid, 3);
}

#[test]
fn aggregates_threads_in_folder() {
    let store = open();
    let mut marc = message(1, "t1", "Marc Delaunay", "Planning", 10);
    let mut lea = message(2, "t1", "Lea Petit", "Re: Planning", 11);
    let mut marc_again = message(3, "t2", "Marc Delaunay", "Contrastes", 9);
    let mut answered = message(4, "t2", "Lea Petit", "Re: Contrastes", 12);
    marc.flags.unread = true;
    lea.flags.unread = true;
    answered.flags.unread = true;
    marc_again.flags = Flags {
        unread: false,
        starred: true,
        answered: false,
    };
    marc_again.pgp = PgpState::Encrypted;
    marc_again.attachments.push(AttachmentMeta {
        filename: "contrastes.png".to_string(),
        mime: "image/png".to_string(),
        size: 12,
        inline: false,
    });
    for mail in [&marc, &lea, &marc_again, &answered] {
        store.upsert_message(mail).expect("insert");
    }

    let threads = store
        .threads_in_folder("perso", "INBOX", -1, 0)
        .expect("threads");
    assert_eq!(threads.len(), 2);
    assert_eq!(threads[0].id, "t2");
    assert_eq!(threads[0].count, 2);
    assert_eq!(threads[0].unread, 1);
    assert!(threads[0].starred);
    assert_eq!(threads[0].encrypted, 1);
    assert_eq!(threads[0].attachments, 1);
    assert_eq!(threads[0].primary.uid, 4);
    assert_eq!(threads[0].subject, "Contrastes");
    assert_eq!(threads[0].preview, "Lea : preview 4");
    assert_eq!(
        threads[0].participants,
        vec!["Lea Petit".to_string(), "Marc Delaunay".to_string()]
    );

    assert_eq!(threads[1].id, "t1");
    assert_eq!(threads[1].count, 2);
    assert_eq!(threads[1].unread, 2);
    assert!(!threads[1].starred);
    assert_eq!(threads[1].subject, "Planning");
    assert_eq!(threads[1].preview, "Lea : preview 2");
}

#[test]
fn sent_folder_threads_have_no_sender_prefix() {
    let store = open();
    let mut mail = message(1, "t1", "Roman", "Planning", 10);
    mail.folder_path = "Sent".to_string();
    mail.preview = "Je lance la phase 2 lundi".to_string();
    store.upsert_message(&mail).expect("insert");

    let threads = store
        .threads_in_folder("perso", "Sent", -1, 0)
        .expect("threads");
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].preview, "Je lance la phase 2 lundi");
    assert!(threads[0].participants.is_empty());
}

#[test]
fn full_thread_spans_every_folder() {
    let store = open();
    let mut question = message(1, "t1", "Marc Delaunay", "Planning", 10);
    question.flags.unread = true;
    let mut answer = message(2, "t1", "Roman", "Re: Planning", 11);
    answer.folder_path = "Sent".to_string();
    answer.flags.starred = true;
    answer.attachments.push(AttachmentMeta {
        filename: "planning.pdf".to_string(),
        mime: "application/pdf".to_string(),
        size: 42,
        inline: false,
    });
    let mut archived = message(3, "t1", "Lea Petit", "Re: Planning", 12);
    archived.folder_path = "Archive".to_string();
    archived.pgp = PgpState::Encrypted;
    let other = message(4, "t2", "Lea Petit", "Contrastes", 13);
    for mail in [&question, &answer, &archived, &other] {
        store.upsert_message(mail).expect("insert");
    }

    let thread = store
        .thread_full("perso", "t1")
        .expect("thread")
        .expect("fil trouvé");
    assert_eq!(
        thread
            .messages
            .iter()
            .map(|message| (message.folder_path.as_str(), message.uid))
            .collect::<Vec<_>>(),
        vec![("Archive", 3), ("Sent", 2), ("INBOX", 1)]
    );
    assert_eq!(thread.id, "t1");
    assert_eq!(thread.account_id, "perso");
    assert_eq!(thread.count, 3);
    assert_eq!(thread.primary.uid, 3);
    assert_eq!(thread.primary.folder_path, "Archive");
    assert_eq!(thread.unread, 1);
    assert!(thread.starred);
    assert_eq!(thread.encrypted, 1);
    assert_eq!(thread.attachments, 1);
    assert_eq!(thread.messages[1].attachments.len(), 1);
    assert!(thread.messages[0].attachments.is_empty());
    assert_eq!(thread.subject, "Planning");
    assert_eq!(thread.preview, "Lea : preview 3");
    assert_eq!(
        thread.participants,
        vec![
            "Lea Petit".to_string(),
            "Roman".to_string(),
            "Marc Delaunay".to_string()
        ]
    );

    assert!(store
        .thread_full("perso", "absent")
        .expect("absent")
        .is_none());
    assert!(store.thread_full("autre", "t1").expect("compte").is_none());
}

#[test]
fn migration_is_replayable_on_existing_database() {
    let path = std::env::temp_dir().join(format!("lavande-mail-{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);

    {
        let store = Store::open(&path).expect("open");
        store.migrate().expect("migrate");
        store
            .upsert_message(&message(1, "t1", "Marc", "Planning", 10))
            .expect("insert");
    }
    {
        let store = Store::open(&path).expect("reopen");
        store.migrate().expect("migrate again");
        let messages = store
            .messages_in_folder("perso", "INBOX", -1, 0)
            .expect("list");
        assert_eq!(messages.len(), 1);
        let folders = store.get_folder("perso", "INBOX").expect("folder");
        assert!(folders.is_none());
    }

    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
}

#[test]
fn reopening_an_existing_database_heals_split_replies() {
    let path = std::env::temp_dir().join(format!("lavande-mail-heal-{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let root = lavande_mail::thread_id("perso", "Planning", Some("root@x"), None, &[]);

    {
        let store = Store::open(&path).expect("open");
        store.migrate().expect("migrate");
        let mut parent = message(1, &root, "Marc", "Planning", 10);
        parent.message_id = Some("parent@x".to_string());
        store.upsert_message(&parent).expect("parent");
        let mut split = message(2, "computed", "Lea", "Re: Planning", 11);
        split.message_id = Some("reply@x".to_string());
        split.in_reply_to = Some("parent@x".to_string());
        split.references = vec!["parent@x".to_string()];
        store.upsert_message(&split).expect("split");
    }
    {
        let store = Store::open(&path).expect("reopen");
        store.migrate().expect("migrate again");
        let stored = store
            .get_message("perso", "INBOX", 2)
            .expect("get")
            .expect("present");
        assert_eq!(stored.thread_id, root);
    }

    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
}

#[test]
fn reads_folders_back() {
    let store = open();
    let folder = store
        .get_folder("perso", "INBOX")
        .expect("folder")
        .expect("present");
    assert_eq!(folder.role, FolderRole::Inbox);
    assert_eq!(folder.name, "Boite de reception");
    assert_eq!(folder.uidvalidity, 7);
    assert_eq!(folder.uidnext, 10);
    assert!(folder.last_sync_at.is_none());

    let synced = Folder {
        last_sync_at: Some(date(10)),
        ..folder
    };
    store.upsert_folder(&synced).expect("upsert");
    let stored = store
        .get_folder("perso", "INBOX")
        .expect("folder")
        .expect("present");
    assert_eq!(stored.last_sync_at, Some(date(10)));
    assert!(store.get_folder("perso", "Nope").expect("folder").is_none());
}

/// The hierarchy delimiter the server announced travels with the folder row, so
/// the tree can be rebuilt without a round-trip.
#[test]
fn keeps_the_hierarchy_delimiter_of_a_folder() {
    let store = open();
    let folder = store
        .get_folder("perso", "INBOX")
        .expect("folder")
        .expect("present");
    assert_eq!(folder.delimiter, None);

    store
        .upsert_folder(&Folder {
            delimiter: Some("/".to_string()),
            ..folder
        })
        .expect("upsert");
    assert_eq!(
        store
            .get_folder("perso", "INBOX")
            .expect("folder")
            .expect("present")
            .delimiter,
        Some("/".to_string())
    );
    let listed = store.list_folders("perso").expect("folders");
    assert_eq!(
        listed
            .iter()
            .find(|folder| folder.path == "INBOX")
            .expect("INBOX")
            .delimiter,
        Some("/".to_string())
    );
}

/// The high-water mark an incremental CONDSTORE pass resumes from: absent until
/// a CONDSTORE server reported one, then carried by every sync.
#[test]
fn keeps_the_modseq_of_a_folder() {
    let store = open();
    assert_eq!(
        store
            .get_folder("perso", "INBOX")
            .expect("folder")
            .expect("present")
            .modseq,
        None
    );

    let folder = store
        .get_folder("perso", "INBOX")
        .expect("folder")
        .expect("present");
    store
        .upsert_folder(&Folder {
            modseq: Some(90060115205545359),
            ..folder
        })
        .expect("upsert");
    assert_eq!(
        store
            .get_folder("perso", "INBOX")
            .expect("folder")
            .expect("present")
            .modseq,
        Some(90060115205545359)
    );
    let listed = store.list_folders("perso").expect("folders");
    assert_eq!(
        listed
            .iter()
            .find(|folder| folder.path == "INBOX")
            .expect("inbox")
            .modseq,
        Some(90060115205545359)
    );
    assert!(listed
        .iter()
        .filter(|folder| folder.path != "INBOX")
        .all(|folder| folder.modseq.is_none()));
}

#[test]
fn relink_replies_joins_a_parent_seen_later() {
    let store = open();
    let root = lavande_mail::thread_id("perso", "Planning", Some("root@x"), None, &[]);

    let mut parent = message(3, &root, "Marc", "Planning", 10);
    parent.message_id = Some("parent@x".to_string());
    parent.in_reply_to = Some("root@x".to_string());
    parent.references = vec!["root@x".to_string()];

    let mut reply = message(2, "late", "Lea", "Re: Planning", 11);
    reply.message_id = Some("reply@x".to_string());
    reply.in_reply_to = Some("parent@x".to_string());

    store.upsert_message(&reply).expect("reply first");
    let stored = store
        .get_message("perso", "INBOX", 2)
        .expect("get")
        .expect("present");
    assert_ne!(stored.thread_id, root);

    store.upsert_message(&parent).expect("parent");
    let updated = store
        .relink_replies("perso", "parent@x", &parent.thread_id)
        .expect("relink");
    assert_eq!(updated, 1);

    let relinked = store
        .get_message("perso", "INBOX", 2)
        .expect("get")
        .expect("present");
    assert_eq!(relinked.thread_id, root);
    assert_eq!(parent.thread_id, root);

    let threads = store
        .threads_in_folder("perso", "INBOX", -1, 0)
        .expect("threads");
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].id, root);
    assert_eq!(threads[0].count, 2);
}

#[test]
fn a_reply_adopts_the_thread_of_its_parent() {
    let store = open();
    let root = lavande_mail::thread_id("perso", "Planning", Some("root@x"), None, &[]);

    let mut parent = message(3, &root, "Marc", "Planning", 10);
    parent.message_id = Some("parent@x".to_string());
    parent.in_reply_to = Some("root@x".to_string());
    parent.references = Vec::new();
    assert_eq!(parent.thread_id, root);
    store.upsert_message(&parent).expect("parent");

    let mut reply = message(2, "computed", "Lea", "Re: Planning", 11);
    reply.message_id = Some("reply@x".to_string());
    reply.in_reply_to = Some("parent@x".to_string());
    reply.references = vec!["parent@x".to_string()];
    reply.thread_id = lavande_mail::thread_id(
        "perso",
        "Re: Planning",
        Some("reply@x"),
        Some("parent@x"),
        &["parent@x".to_string()],
    );
    assert_ne!(reply.thread_id, root);

    let mut child = message(4, "child-root", "Roman", "Re: Planning", 12);
    child.message_id = Some("child@x".to_string());
    child.in_reply_to = Some("reply@x".to_string());
    child.references = vec!["reply@x".to_string()];

    store.upsert_message(&reply).expect("reply");
    store.upsert_message(&child).expect("child");

    let parent_thread = store
        .thread_of_message("perso", "parent@x")
        .expect("parent thread")
        .expect("present");
    assert_eq!(parent_thread, root);
    assert!(store
        .rethread("perso", "INBOX", 2, &parent_thread)
        .expect("rethread"));
    assert!(!store
        .rethread("perso", "INBOX", 2, &parent_thread)
        .expect("rethread again"));
    assert_eq!(
        store
            .relink_replies("perso", "reply@x", &parent_thread)
            .expect("relink"),
        1
    );

    for uid in [2, 4] {
        let stored = store
            .get_message("perso", "INBOX", uid)
            .expect("get")
            .expect("present");
        assert_eq!(stored.thread_id, root);
    }
    assert!(store
        .thread_of_message("perso", "absent@x")
        .expect("absent")
        .is_none());
    let threads = store
        .threads_in_folder("perso", "INBOX", -1, 0)
        .expect("threads");
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].id, root);
    assert_eq!(threads[0].count, 3);
}

#[test]
fn heal_reply_threads_aligns_split_replies() {
    let store = open();
    let root = lavande_mail::thread_id("perso", "Planning", Some("root@x"), None, &[]);

    let mut parent = message(1, &root, "Marc", "Planning", 10);
    parent.message_id = Some("parent@x".to_string());
    store.upsert_message(&parent).expect("parent");

    let mut split = message(2, "computed", "Lea", "Re: Planning", 11);
    split.message_id = Some("reply@x".to_string());
    split.in_reply_to = Some("parent@x".to_string());
    split.references = vec!["parent@x".to_string()];
    store.upsert_message(&split).expect("split");

    let lonely = message(3, "lonely", "Marc", "Vacances", 12);
    store.upsert_message(&lonely).expect("lonely");

    assert_eq!(store.heal_reply_threads().expect("heal"), 1);
    let healed = store
        .get_message("perso", "INBOX", 2)
        .expect("get")
        .expect("present");
    assert_eq!(healed.thread_id, root);
    let untouched = store
        .get_message("perso", "INBOX", 3)
        .expect("get")
        .expect("present");
    assert_eq!(untouched.thread_id, "lonely");
    assert_eq!(store.heal_reply_threads().expect("heal again"), 0);
}

#[test]
fn heal_reply_threads_drags_the_replies_of_a_healed_message() {
    let store = open();
    let root = lavande_mail::thread_id("perso", "Planning", Some("root@x"), None, &[]);

    let mut parent = message(1, &root, "Marc", "Planning", 10);
    parent.message_id = Some("parent@x".to_string());
    store.upsert_message(&parent).expect("parent");

    let mut reply = message(2, "reply-own", "Lea", "Re: Planning", 11);
    reply.message_id = Some("reply@x".to_string());
    reply.in_reply_to = Some("parent@x".to_string());
    store.upsert_message(&reply).expect("reply");

    let mut child = message(3, "child-own", "Roman", "Re: Planning", 12);
    child.message_id = Some("child@x".to_string());
    child.in_reply_to = Some("reply@x".to_string());
    store.upsert_message(&child).expect("child");
    assert_eq!(store.heal_reply_threads().expect("heal"), 2);

    for uid in [2, 3] {
        let stored = store
            .get_message("perso", "INBOX", uid)
            .expect("get")
            .expect("present");
        assert_eq!(stored.thread_id, root);
    }
    let threads = store
        .threads_in_folder("perso", "INBOX", -1, 0)
        .expect("threads");
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].count, 3);
    assert_eq!(store.heal_reply_threads().expect("heal again"), 0);
}

#[test]
fn clear_folder_empties_one_folder_only() {
    let store = open();
    store
        .upsert_message(&message(1, "t1", "Marc", "A", 10))
        .expect("m1");
    store
        .upsert_message(&message(2, "t1", "Marc", "B", 11))
        .expect("m2");
    let mut sent = message(9, "t2", "Roman", "C", 12);
    sent.folder_path = "Sent".to_string();
    store.upsert_message(&sent).expect("sent");

    let cleared = store.clear_folder("perso", "INBOX").expect("clear");
    assert_eq!(cleared, 2);
    assert!(store
        .messages_in_folder("perso", "INBOX", -1, 0)
        .expect("list")
        .is_empty());
    assert_eq!(
        store
            .messages_in_folder("perso", "Sent", -1, 0)
            .expect("sent")
            .len(),
        1
    );
    assert!(store
        .get_folder("perso", "INBOX")
        .expect("folder")
        .is_some());
}

/// The local desync: messages and attachments go, the folder row stays with a
/// cleared sync baseline, so the next pass fetches it again.
#[test]
fn reset_folder_forgets_messages_and_sync_baseline() {
    let store = open();
    let mut mail = message(1, "t1", "Marc", "A", 10);
    mail.attachments.push(AttachmentMeta {
        filename: "a.png".to_string(),
        mime: "image/png".to_string(),
        size: 8,
        inline: false,
    });
    store.upsert_message(&mail).expect("m1");
    store
        .upsert_message(&message(2, "t1", "Marc", "B", 11))
        .expect("m2");
    let mut sent = message(9, "t2", "Roman", "C", 12);
    sent.folder_path = "Sent".to_string();
    store.upsert_message(&sent).expect("sent");
    let synced = store
        .get_folder("perso", "INBOX")
        .expect("folder")
        .expect("present");
    store
        .upsert_folder(&Folder {
            last_sync_at: Some(date(10)),
            modseq: Some(90060115205545359),
            ..synced
        })
        .expect("synced");

    let dropped = store.reset_folder("perso", "INBOX").expect("reset");
    assert_eq!(dropped, 2);
    assert!(store
        .messages_in_folder("perso", "INBOX", -1, 0)
        .expect("list")
        .is_empty());
    assert!(store
        .get_message("perso", "INBOX", 1)
        .expect("get")
        .is_none());
    let folder = store
        .get_folder("perso", "INBOX")
        .expect("folder")
        .expect("present");
    assert!(folder.modseq.is_none());
    assert!(folder.last_sync_at.is_none());
    assert_eq!(folder.uidnext, 10);
    assert_eq!(folder.uidvalidity, 7);
    assert_eq!(
        store
            .messages_in_folder("perso", "Sent", -1, 0)
            .expect("sent")
            .len(),
        1
    );
}

#[test]
fn delete_folder_drops_the_folder_and_its_messages() {
    let store = open();
    let custom = Folder {
        account_id: "perso".to_string(),
        path: "Projets".to_string(),
        name: "Projets".to_string(),
        role: FolderRole::Other,
        uidvalidity: 7,
        uidnext: 10,
        last_sync_at: Some(date(10)),
        modseq: Some(90060115205545359),
        delimiter: None,
    };
    store.upsert_folder(&custom).expect("folder");
    let mut first = message(1, "t1", "Marc", "A", 10);
    first.folder_path = "Projets".to_string();
    first.attachments.push(AttachmentMeta {
        filename: "a.png".to_string(),
        mime: "image/png".to_string(),
        size: 8,
        inline: false,
    });
    store.upsert_message(&first).expect("m1");
    let mut second = message(2, "t2", "Marc", "B", 11);
    second.folder_path = "Projets".to_string();
    store.upsert_message(&second).expect("m2");
    store
        .upsert_message(&message(3, "t3", "Marc", "C", 12))
        .expect("inbox");

    let dropped = store.delete_folder("perso", "Projets").expect("delete");
    assert_eq!(dropped, 2);
    assert!(store
        .get_folder("perso", "Projets")
        .expect("folder")
        .is_none());
    assert!(!store
        .list_folders("perso")
        .expect("folders")
        .iter()
        .any(|folder| folder.path == "Projets"));
    assert!(store
        .messages_in_folder("perso", "Projets", -1, 0)
        .expect("list")
        .is_empty());
    assert_eq!(
        store
            .messages_in_folder("perso", "INBOX", -1, 0)
            .expect("inbox")
            .len(),
        1,
        "les autres dossiers sont intacts"
    );
    assert_eq!(store.delete_folder("perso", "Projets").expect("again"), 0);
}

#[test]
fn list_accounts_returns_id_label_email() {
    let store = open();
    store
        .upsert_account("travail", "Travail", "roman@lavande.mail")
        .expect("second account");

    let accounts = store.list_accounts().expect("accounts");
    assert_eq!(
        accounts,
        vec![
            (
                "perso".to_string(),
                "Perso".to_string(),
                "roman@lavande.fr".to_string()
            ),
            (
                "travail".to_string(),
                "Travail".to_string(),
                "roman@lavande.mail".to_string()
            ),
        ]
    );
}

#[test]
fn list_folders_returns_known_folders() {
    let store = open();
    let paths: Vec<String> = store
        .list_folders("perso")
        .expect("folders")
        .into_iter()
        .map(|folder| folder.path)
        .collect();
    assert_eq!(paths, vec!["Archive", "INBOX", "Sent"]);
    assert!(store.list_folders("absent").expect("folders").is_empty());
}

#[test]
fn delete_account_drops_every_row() {
    let store = open();
    let mut mail = message(1, "t1", "Marc", "Planning", 10);
    mail.attachments = vec![AttachmentMeta {
        filename: "planning.pdf".to_string(),
        mime: "application/pdf".to_string(),
        size: 8,
        inline: false,
    }];
    store.upsert_message(&mail).expect("message");
    let mut sent = message(9, "t2", "Roman", "Reponse", 11);
    sent.folder_path = "Sent".to_string();
    store.upsert_message(&sent).expect("sent");

    assert_eq!(store.delete_account("perso").expect("delete"), 7);
    assert!(store.list_accounts().expect("accounts").is_empty());
    assert!(store.list_folders("perso").expect("folders").is_empty());
    assert!(store
        .messages_in_folder("perso", "INBOX", -1, 0)
        .expect("inbox")
        .is_empty());
    assert!(store
        .messages_in_folder("perso", "Sent", -1, 0)
        .expect("sent")
        .is_empty());
}

#[test]
fn delete_unknown_account_is_not_an_error() {
    let store = open();
    assert_eq!(store.delete_account("absent").expect("delete"), 0);
    assert_eq!(store.list_accounts().expect("accounts").len(), 1);
}

#[test]
fn folder_counts_totals_and_unread_per_folder() {
    let store = open();
    let mut inbox = message(1, "t1", "Marc", "Un", 1);
    inbox.flags.unread = true;
    let mut spam_unread = message(2, "t2", "Marc", "Deux", 2);
    spam_unread.folder_path = "Spam".to_string();
    spam_unread.flags.unread = true;
    let mut spam_read = message(3, "t3", "Marc", "Trois", 3);
    spam_read.folder_path = "Spam".to_string();
    for mail in [&inbox, &spam_unread, &spam_read] {
        store.upsert_message(mail).expect("insert");
    }

    assert_eq!(
        store.folder_counts("perso").expect("counts"),
        vec![
            FolderCount {
                path: "INBOX".to_string(),
                total: 1,
                unread: 1
            },
            FolderCount {
                path: "Spam".to_string(),
                total: 2,
                unread: 1
            },
        ]
    );
    assert!(store.folder_counts("absent").expect("counts").is_empty());
}

#[test]
fn threads_pagination_slices_in_sql() {
    let store = open();
    for uid in 1..=6 {
        let mail = message(
            uid,
            &format!("t{uid}"),
            "Marc",
            &format!("Sujet {uid}"),
            uid,
        );
        store.upsert_message(&mail).expect("insert");
    }

    let first = store
        .threads_in_folder("perso", "INBOX", 2, 0)
        .expect("page");
    let second = store
        .threads_in_folder("perso", "INBOX", 2, 2)
        .expect("page");
    assert_eq!(first.len(), 2);
    assert_eq!(second.len(), 2);
    assert!(first.iter().all(|a| !second.iter().any(|b| a.id == b.id)));
    assert_eq!(first[0].id, "t6");
    assert_eq!(second[0].id, "t4");
    assert_eq!(
        store
            .threads_in_folder("perso", "INBOX", -1, 0)
            .expect("all")
            .len(),
        6
    );
    assert!(store
        .threads_in_folder("perso", "INBOX", 2, 10)
        .expect("page")
        .is_empty());
}

#[test]
fn find_by_message_id_and_mark_answered() {
    let store = open();
    let mail = message(1, "t1", "Marc", "Question", 1);
    store.upsert_message(&mail).expect("insert");

    let found = store
        .find_by_message_id("perso", "<m1@x>")
        .expect("find")
        .expect("present");
    assert_eq!(found, ("INBOX".to_string(), 1));
    assert!(store
        .find_by_message_id("perso", "<absent@x>")
        .expect("find")
        .is_none());

    assert!(store.mark_answered("perso", "INBOX", 1).expect("answered"));
    assert!(!store.mark_answered("perso", "INBOX", 42).expect("answered"));
    let stored = store
        .get_message("perso", "INBOX", 1)
        .expect("get")
        .expect("present");
    assert!(stored.flags.answered);
}

#[test]
fn search_messages_matches_subject_body_and_sender() {
    let store = open();
    let mut invoice = message(1, "t1", "Marc", "Facture mars", 1);
    invoice.body_text = Some("montant dû".to_string());
    let planning = message(2, "t2", "Lea", "Planning", 2);
    let mut sent = message(3, "t3", "Marc", "Devis", 3);
    sent.folder_path = "Sent".to_string();
    sent.body_text = Some("facture avril".to_string());
    for mail in [&invoice, &planning, &sent] {
        store.upsert_message(mail).expect("insert");
    }

    let hits = store
        .search_messages("perso", "facture", 10)
        .expect("search");
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].uid, 3);
    assert_eq!(hits[1].uid, 1);

    let sender = store.search_messages("perso", "lea@", 10).expect("search");
    assert_eq!(sender.len(), 1);
    assert_eq!(sender[0].uid, 2);

    assert!(store
        .search_messages("perso", "%", 10)
        .expect("search")
        .is_empty());
    assert!(store
        .search_messages("absent", "facture", 10)
        .expect("search")
        .is_empty());
}

#[test]
fn pgp_detail_survives_a_round_trip() {
    let store = open();
    let mut stored = message(1, "t1", "Camille", "Chiffré", 1);
    stored.pgp = PgpState::Encrypted;
    stored.pgp_detail = Some(PgpDetail {
        verified: Some(true),
        signer: Some("Camille Rousseau <camille@studio-lilas.fr>".to_string()),
        decrypted: true,
        error: None,
    });
    store.upsert_message(&stored).expect("insertion");

    let read = store
        .get_message("perso", "INBOX", 1)
        .expect("lecture")
        .expect("message");
    assert_eq!(read.pgp, PgpState::Encrypted);
    assert_eq!(read.pgp_detail, stored.pgp_detail);
}

#[test]
fn a_message_without_pgp_detail_reads_back_with_none() {
    let store = open();
    let stored = message(1, "t1", "Camille", "Clair", 1);
    store.upsert_message(&stored).expect("insertion");
    let read = store
        .get_message("perso", "INBOX", 1)
        .expect("lecture")
        .expect("message");
    assert_eq!(read.pgp_detail, None);
}

#[test]
fn the_pgp_switch_defaults_to_enabled() {
    let store = open();
    assert!(store.pgp_enabled("perso").expect("interrupteur"));
    assert!(
        store.pgp_enabled("inconnu").expect("interrupteur"),
        "un compte que le store ignore est ouvert"
    );
}

#[test]
fn the_pgp_switch_is_stored_per_account() {
    let store = open();
    store
        .upsert_account("pro", "Pro", "roman@lavande.mail")
        .expect("compte");

    store.set_pgp_enabled("perso", false).expect("coupe");
    assert!(!store.pgp_enabled("perso").expect("interrupteur"));
    assert!(store.pgp_enabled("pro").expect("l'autre compte est intact"));

    store.set_pgp_enabled("perso", true).expect("rallume");
    assert!(store.pgp_enabled("perso").expect("interrupteur"));

    assert!(
        store.set_pgp_enabled("absent", false).is_err(),
        "un compte inconnu ne s'invente pas"
    );
}

#[test]
fn upsert_account_keeps_the_pgp_switch() {
    let store = open();
    store.set_pgp_enabled("perso", false).expect("coupe");
    store
        .upsert_account("perso", "Perso renommé", "roman@lavande.mail")
        .expect("upsert");
    assert!(!store.pgp_enabled("perso").expect("interrupteur"));
}

#[test]
fn closing_bodies_only_touches_encrypted_messages() {
    let store = open();
    let mut encrypted = message(1, "t1", "Camille", "Chiffré", 1);
    encrypted.pgp = PgpState::Encrypted;
    encrypted.pgp_detail = Some(PgpDetail {
        verified: None,
        signer: None,
        decrypted: true,
        error: None,
    });
    store.upsert_message(&encrypted).expect("insertion");
    let clear = message(2, "t2", "Marc", "Clair", 2);
    store.upsert_message(&clear).expect("insertion");

    assert_eq!(store.close_encrypted_bodies("perso").expect("ferme"), 1);

    let read = store
        .get_message("perso", "INBOX", 1)
        .expect("lecture")
        .expect("message");
    assert!(read.body_text.is_none());
    assert!(read.body_html.is_none());
    assert_eq!(read.preview, "");
    assert_eq!(read.pgp_detail, None);
    assert_eq!(read.pgp, PgpState::Encrypted, "l'état PGP reste lisible");

    let untouched = store
        .get_message("perso", "INBOX", 2)
        .expect("lecture")
        .expect("message");
    assert_eq!(untouched, clear);
}

const RAW_BODY: &[u8] = concat!(
    "From: Marc <marc@mail.fr>\r\n",
    "To: Roman <roman@lavande.fr>\r\n",
    "Subject: Planning\r\n",
    "Date: Tue, 10 Nov 2026 10:00:00 +0000\r\n",
    "Message-ID: <m1@x>\r\n",
    "MIME-Version: 1.0\r\n",
    "Content-Type: multipart/mixed; boundary=\"coupe\"\r\n",
    "\r\n",
    "--coupe\r\n",
    "Content-Type: text/plain; charset=utf-8\r\n",
    "\r\n",
    "Le planning avance.\r\n",
    "--coupe\r\n",
    "Content-Type: text/html; charset=utf-8\r\n",
    "\r\n",
    "<p>Le planning avance.</p>\r\n",
    "--coupe\r\n",
    "Content-Type: image/png; name=\"a.png\"\r\n",
    "Content-Transfer-Encoding: base64\r\n",
    "Content-Disposition: attachment; filename=\"a.png\"\r\n",
    "\r\n",
    "YWFh\r\n",
    "--coupe--\r\n",
)
.as_bytes();

#[test]
fn a_headers_upsert_keeps_the_body_the_preview_and_the_attachments() {
    let store = open();
    store
        .upsert_message(&message(1, "t1", "Marc", "Planning", 10))
        .expect("en-têtes");
    let parsed = mime::parse_message(RAW_BODY).expect("parse");
    store.set_body("perso", "INBOX", 1, &parsed).expect("corps");

    let mut headers = message(1, "t1", "Marc", "Planning", 10);
    headers.preview = String::new();
    headers.body_text = None;
    headers.body_html = None;
    headers.flags.unread = false;
    store.upsert_message(&headers).expect("re-synchronisation");

    let stored = store
        .get_message("perso", "INBOX", 1)
        .expect("lecture")
        .expect("message");
    assert_eq!(stored.body_text.as_deref(), Some("Le planning avance."));
    assert!(stored
        .body_html
        .as_deref()
        .is_some_and(|html| html.contains("Le planning avance.")));
    assert_eq!(stored.preview, "Le planning avance.");
    assert_eq!(stored.attachments, parsed.attachments);
    assert!(
        !stored.flags.unread,
        "les drapeaux suivent la synchronisation"
    );
}

#[test]
fn eviction_drops_old_bodies_but_keeps_the_preview() {
    let store = open();
    store
        .upsert_folder(&Folder {
            account_id: "perso".to_string(),
            path: "Drafts".to_string(),
            name: "Brouillons".to_string(),
            role: FolderRole::Drafts,
            uidvalidity: 7,
            uidnext: 10,
            last_sync_at: None,
            modseq: None,
            delimiter: None,
        })
        .expect("brouillons");

    let parsed = mime::parse_message(RAW_BODY).expect("parse");
    for (uid, folder_path, day, starred) in [
        (1, "INBOX", 1, false),
        (2, "INBOX", 1, true),
        (3, "INBOX", 29, false),
        (4, "Drafts", 1, false),
    ] {
        let mut mail = message(uid, &format!("t{uid}"), "Marc", "Planning", day);
        mail.folder_path = folder_path.to_string();
        mail.flags.starred = starred;
        store.upsert_message(&mail).expect("en-têtes");
        store
            .set_body("perso", folder_path, uid, &parsed)
            .expect("corps");
    }
    let mut without_body = message(5, "t5", "Marc", "Sans corps", 1);
    without_body.body_text = None;
    without_body.preview = String::new();
    store.upsert_message(&without_body).expect("en-têtes");

    assert_eq!(
        store
            .evict_bodies_before("perso", "2026-11-15T00:00:00Z")
            .expect("éviction"),
        1
    );

    let evicted = store
        .get_message("perso", "INBOX", 1)
        .expect("lecture")
        .expect("message");
    assert!(evicted.body_text.is_none());
    assert!(evicted.body_html.is_none());
    assert!(evicted.pgp_detail.is_none());
    assert_eq!(evicted.preview, "Le planning avance.", "l'aperçu survit");
    assert_eq!(evicted.attachments.len(), 1, "les pièces jointes restent");

    for (folder_path, uid) in [("INBOX", 2), ("INBOX", 3), ("Drafts", 4)] {
        let kept = store
            .get_message("perso", folder_path, uid)
            .expect("lecture")
            .expect("message");
        assert_eq!(
            kept.body_text.as_deref(),
            Some("Le planning avance."),
            "{folder_path} {uid}"
        );
    }
    let untouched = store
        .get_message("perso", "INBOX", 5)
        .expect("lecture")
        .expect("message");
    assert!(untouched.body_text.is_none());
}

#[test]
fn a_preview_lands_without_a_body_and_survives_a_resync() {
    let store = open();
    let mut headers = message(1, "t1", "Marc", "Planning", 10);
    headers.body_text = None;
    headers.preview = String::new();
    store.upsert_message(&headers).expect("en-têtes");
    store
        .set_preview("perso", "INBOX", 1, "Le planning avance.")
        .expect("aperçu");

    let stored = store
        .get_message("perso", "INBOX", 1)
        .expect("lecture")
        .expect("message");
    assert_eq!(stored.preview, "Le planning avance.");
    assert!(stored.body_text.is_none());
    assert!(stored.body_html.is_none());

    store.upsert_message(&headers).expect("re-synchronisation");
    let stored = store
        .get_message("perso", "INBOX", 1)
        .expect("lecture")
        .expect("message");
    assert_eq!(stored.preview, "Le planning avance.");
}

#[test]
fn a_tombstoned_uid_is_isolated_and_expires() {
    let store = open();
    store.tombstone_uid("perso", "INBOX", 4);

    assert!(store.is_tombstoned("perso", "INBOX", 4));
    assert!(!store.is_tombstoned("perso", "INBOX", 5));
    assert!(!store.is_tombstoned("perso", "Sent", 4));
    assert!(!store.is_tombstoned("autre", "INBOX", 4));

    store.prune_tombstones(Instant::now() + Duration::from_secs(601));
    assert!(!store.is_tombstoned("perso", "INBOX", 4));
}

#[test]
fn a_fresh_tombstone_survives_a_prune() {
    let store = open();
    store.tombstone_uid("perso", "INBOX", 4);
    store.prune_tombstones(Instant::now());
    assert!(store.is_tombstoned("perso", "INBOX", 4));
}

#[test]
fn forgetting_a_tombstone_is_per_uid_and_tolerates_unknown_ones() {
    let store = open();
    store.tombstone_uid("perso", "INBOX", 4);
    store.tombstone_uid("perso", "INBOX", 5);

    store.forget_tombstones("perso", "INBOX", &[4]);
    store.forget_tombstones("perso", "INBOX", &[99]);

    assert!(!store.is_tombstoned("perso", "INBOX", 4));
    assert!(store.is_tombstoned("perso", "INBOX", 5));
}

#[test]
fn search_folds_accents_and_case() {
    let store = open();
    let mut zebra = message(1, "t1", "Marc", "Zèbre rayé", 10);
    zebra.body_text = Some("Une harde à l'aube".to_string());
    let other = message(2, "t2", "Lea", "Planning", 11);
    for mail in [&zebra, &other] {
        store.upsert_message(mail).expect("insert");
    }

    for needle in ["zebre", "ZÈBRE", "Zebre", "zébr"] {
        let hits = store.search_messages("perso", needle, 10).expect("search");
        assert_eq!(hits.len(), 1, "{needle}");
        assert_eq!(hits[0].uid, 1);
    }
    let body = store.search_messages("perso", "harde", 10).expect("search");
    assert_eq!(body.len(), 1);
    assert_eq!(body[0].uid, 1);
}

#[test]
fn search_matches_the_recipients_and_the_copies() {
    let store = open();
    let mut mail = message(1, "t1", "Marc", "Planning", 10);
    mail.to = vec![Address {
        name: Some("Camille".to_string()),
        email: "camille@studio.fr".to_string(),
    }];
    mail.cc = vec![Address {
        name: None,
        email: "theo@studio.fr".to_string(),
    }];
    store.upsert_message(&mail).expect("insert");

    assert_eq!(
        store
            .search_messages("perso", "camille", 10)
            .expect("to")
            .len(),
        1
    );
    assert_eq!(
        store
            .search_messages("perso", "theo@studio", 10)
            .expect("cc")
            .len(),
        1
    );
}

fn uids(store: &Store, filter: &SearchFilter<'_>) -> Vec<u32> {
    let mut uids: Vec<u32> = store
        .search("perso", filter)
        .expect("search")
        .iter()
        .map(|mail| mail.uid)
        .collect();
    uids.sort_unstable();
    uids
}

#[test]
fn search_filters_narrow_the_result() {
    let store = open();
    let mut unread = message(1, "t1", "Marc", "Facture mars", 10);
    unread.flags = Flags {
        unread: true,
        starred: false,
        answered: false,
    };
    let mut starred = message(2, "t2", "Lea", "Facture avril", 12);
    starred.flags = Flags {
        unread: false,
        starred: true,
        answered: false,
    };
    let mut sent = message(3, "t3", "Marc", "Facture mai", 14);
    sent.folder_path = "Sent".to_string();
    sent.flags = Flags {
        unread: true,
        starred: true,
        answered: false,
    };
    sent.attachments = vec![AttachmentMeta {
        filename: "facture.pdf".to_string(),
        mime: "application/pdf".to_string(),
        size: 4,
        inline: false,
    }];
    for mail in [&unread, &starred, &sent] {
        store.upsert_message(mail).expect("insert");
    }

    let page = |filter: SearchFilter<'_>| uids(&store, &filter);
    assert_eq!(
        page(SearchFilter {
            q: "facture",
            limit: 10,
            ..SearchFilter::default()
        }),
        [1, 2, 3]
    );
    assert_eq!(
        page(SearchFilter {
            q: "facture",
            unread: Some(true),
            limit: 10,
            ..SearchFilter::default()
        }),
        [1, 3]
    );
    assert_eq!(
        page(SearchFilter {
            q: "facture",
            starred: Some(true),
            limit: 10,
            ..SearchFilter::default()
        }),
        [2, 3]
    );
    assert_eq!(
        page(SearchFilter {
            folder: Some("Sent"),
            limit: 10,
            ..SearchFilter::default()
        }),
        [3]
    );
    assert_eq!(
        page(SearchFilter {
            has_attachment: Some(true),
            limit: 10,
            ..SearchFilter::default()
        }),
        [3]
    );
    assert_eq!(
        page(SearchFilter {
            q: "facture",
            after: Some("2026-11-12T00:00:00Z"),
            limit: 10,
            ..SearchFilter::default()
        }),
        [2, 3]
    );
    assert_eq!(
        page(SearchFilter {
            q: "facture",
            before: Some("2026-11-12T00:00:00Z"),
            limit: 10,
            ..SearchFilter::default()
        }),
        [1]
    );
    assert_eq!(
        page(SearchFilter {
            from: Some("lea"),
            limit: 10,
            ..SearchFilter::default()
        }),
        [2]
    );
    assert_eq!(
        page(SearchFilter {
            subject: Some("avril"),
            limit: 10,
            ..SearchFilter::default()
        }),
        [2]
    );
    assert_eq!(
        page(SearchFilter {
            subject: Some("facture"),
            to: Some("camille"),
            limit: 10,
            ..SearchFilter::default()
        }),
        Vec::<u32>::new()
    );
}

#[test]
fn search_pages_with_offset() {
    let store = open();
    for uid in 1..=3 {
        store
            .upsert_message(&message(uid, "t1", "Marc", "Facture", uid))
            .expect("insert");
    }
    let page = |offset: i64| {
        store
            .search(
                "perso",
                &SearchFilter {
                    q: "facture",
                    limit: 2,
                    offset,
                    ..SearchFilter::default()
                },
            )
            .expect("search")
            .iter()
            .map(|mail| mail.uid)
            .collect::<Vec<u32>>()
    };
    assert_eq!(page(0), [3, 2]);
    assert_eq!(page(2), [1]);
    assert!(page(4).is_empty());
}

#[test]
fn an_evicted_body_leaves_the_index_but_its_subject_stays() {
    let store = open();
    let mut old = message(1, "t1", "Marc", "Rapport annuel", 1);
    old.body_text = Some("xylophone argentin".to_string());
    store.upsert_message(&old).expect("insert");
    assert_eq!(
        store
            .search_messages("perso", "xylophone", 10)
            .expect("search")
            .len(),
        1
    );

    assert_eq!(
        store
            .evict_bodies_before("perso", "2026-11-10T00:00:00Z")
            .expect("éviction"),
        1
    );
    assert!(store
        .search_messages("perso", "xylophone", 10)
        .expect("search")
        .is_empty());
    assert_eq!(
        store
            .search_messages("perso", "rapport", 10)
            .expect("search")
            .len(),
        1
    );
}

#[test]
fn a_query_without_any_word_finds_nothing_and_never_fails() {
    let store = open();
    store
        .upsert_message(&message(1, "t1", "Marc", "Facture", 10))
        .expect("insert");
    for needle in [
        "%", "\"", "(", ")", "'", "-", "\\", "***", "AND", "NEAR(", "%_",
    ] {
        assert!(
            store
                .search_messages("perso", needle, 10)
                .expect(needle)
                .is_empty(),
            "{needle}"
        );
    }
    assert_eq!(
        store
            .search_messages("perso", "facture", 10)
            .expect("search")
            .len(),
        1
    );
}

#[test]
fn the_attachment_flag_widens_from_the_headers_then_follows_the_body() {
    let store = open();
    let headers = message(1, "t1", "Marc", "Scan", 10);
    store
        .upsert_message_with_attachment(&headers, true)
        .expect("en-têtes");
    let attached = |store: &Store| {
        store
            .search(
                "perso",
                &SearchFilter {
                    has_attachment: Some(true),
                    limit: 10,
                    ..SearchFilter::default()
                },
            )
            .expect("search")
            .len()
    };
    assert_eq!(attached(&store), 1);

    store
        .upsert_message(&message(1, "t1", "Marc", "Scan", 10))
        .expect("re-synchronisation");
    assert_eq!(attached(&store), 1, "un en-tête ne dément pas l'index");

    let parsed = mime::parse_message(RAW_BODY).expect("parse");
    store.set_body("perso", "INBOX", 1, &parsed).expect("corps");
    assert_eq!(attached(&store), 1, "la pièce jointe est réelle");

    let bodyless = mime::parse_message(
        b"From: marc@mail.fr\r\nSubject: Note\r\nContent-Type: text/plain\r\n\r\ncorps\r\n",
    )
    .expect("parse");
    store
        .set_body("perso", "INBOX", 1, &bodyless)
        .expect("corps");
    assert_eq!(attached(&store), 0, "le corps dit la vérité");
}

#[test]
fn deleting_a_message_clears_its_index_entry() {
    let store = open();
    store
        .upsert_message(&message(1, "t1", "Marc", "Facture", 10))
        .expect("insert");
    store
        .upsert_message(&message(2, "t1", "Marc", "Facture aussi", 11))
        .expect("insert");
    assert_eq!(
        store
            .search_messages("perso", "facture", 10)
            .expect("search")
            .len(),
        2
    );

    store
        .delete_message("perso", "INBOX", 1)
        .expect("suppression");
    let left = store
        .search_messages("perso", "facture", 10)
        .expect("search");
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].uid, 2);

    store.clear_folder("perso", "INBOX").expect("vidage");
    assert!(store
        .search_messages("perso", "facture", 10)
        .expect("search")
        .is_empty());
}

fn add_folder(store: &Store, account_id: &str, path: &str, role: FolderRole) {
    store
        .upsert_folder(&Folder {
            account_id: account_id.to_string(),
            path: path.to_string(),
            name: path.to_string(),
            role,
            uidvalidity: 7,
            uidnext: 10,
            last_sync_at: None,
            modseq: None,
            delimiter: None,
        })
        .expect("folder");
}

fn contact<'a>(
    contacts: &'a [lavande_mail::store::Contact],
    email: &str,
) -> &'a lavande_mail::store::Contact {
    contacts
        .iter()
        .find(|contact| contact.email == email)
        .unwrap_or_else(|| panic!("contact {email} absent : {contacts:?}"))
}

#[test]
fn a_received_message_adds_its_sender() {
    let store = open();
    store
        .upsert_message(&message(1, "t1", "Marc", "Planning", 10))
        .expect("insert");

    let contacts = store.contacts("", 20).expect("contacts");
    assert_eq!(contacts.len(), 1);
    assert_eq!(contacts[0].email, "marc@mail.fr");
    assert_eq!(contacts[0].name.as_deref(), Some("Marc"));
    assert_eq!(contacts[0].received, 1);
    assert_eq!(contacts[0].sent, 0);
    assert_eq!(
        contacts[0].last_seen.as_deref(),
        Some("2026-11-10T10:00:00Z")
    );
}

#[test]
fn a_sent_message_adds_its_recipients_and_copies() {
    let store = open();
    let mut sent = message(1, "t1", "Roman", "Planning", 10);
    sent.folder_path = "Sent".to_string();
    sent.to = vec![
        Address {
            name: Some("Marc".to_string()),
            email: "Marc@Mail.fr".to_string(),
        },
        Address {
            name: None,
            email: "lea@mail.fr".to_string(),
        },
    ];
    sent.cc = vec![Address {
        name: Some("Camille".to_string()),
        email: "camille@mail.fr".to_string(),
    }];
    store.upsert_message(&sent).expect("insert");

    let contacts = store.contacts("", 20).expect("contacts");
    assert_eq!(contacts.len(), 3);
    assert_eq!(contact(&contacts, "marc@mail.fr").sent, 1);
    assert_eq!(
        contact(&contacts, "marc@mail.fr").name.as_deref(),
        Some("Marc")
    );
    assert_eq!(contact(&contacts, "lea@mail.fr").sent, 1);
    assert!(contact(&contacts, "lea@mail.fr").name.is_none());
    assert_eq!(contact(&contacts, "camille@mail.fr").sent, 1);
    assert!(
        contacts.iter().all(|contact| contact.received == 0),
        "l'expéditeur d'un envoi n'est pas un contact reçu"
    );
    assert!(
        !contacts
            .iter()
            .any(|contact| contact.email == "roman@lavande.fr"),
        "l'adresse du compte n'entre pas dans la liste"
    );
}

#[test]
fn spam_trash_and_drafts_are_not_contacts() {
    let store = open();
    add_folder(&store, "perso", "Junk", FolderRole::Spam);
    add_folder(&store, "perso", "Trash", FolderRole::Trash);
    add_folder(&store, "perso", "Drafts", FolderRole::Drafts);
    for (uid, path) in [(1, "Junk"), (2, "Trash"), (3, "Drafts")] {
        let mut mail = message(uid, "t1", "Marc", "Promo", 10);
        mail.folder_path = path.to_string();
        store.upsert_message(&mail).expect("insert");
    }

    assert!(store.contacts("", 20).expect("contacts").is_empty());
}

#[test]
fn an_archived_message_still_feeds_the_list() {
    let store = open();
    let mut archived = message(1, "t1", "Lea", "Planning", 10);
    archived.folder_path = "Archive".to_string();
    store.upsert_message(&archived).expect("insert");

    let contacts = store.contacts("", 20).expect("contacts");
    assert_eq!(contact(&contacts, "lea@mail.fr").received, 1);
}

#[test]
fn the_account_address_is_never_a_contact() {
    let store = open();
    let mut own = message(1, "t1", "Roman", "Note", 10);
    own.from = Address {
        name: Some("Roman".to_string()),
        email: "Roman@Lavande.FR".to_string(),
    };
    store.upsert_message(&own).expect("insert");
    assert!(store.contacts("", 20).expect("contacts").is_empty());
}

#[test]
fn the_name_follows_the_latest_message() {
    let store = open();
    store
        .upsert_message(&message(1, "t1", "Marc", "Planning", 10))
        .expect("insert");
    let mut newer = message(2, "t2", "Marc Delaunay", "Re: Planning", 12);
    newer.from.email = "marc@mail.fr".to_string();
    store.upsert_message(&newer).expect("insert");
    let mut older = message(3, "t3", "M. Delaunay", "Vieux fil", 9);
    older.from.email = "marc@mail.fr".to_string();
    store.upsert_message(&older).expect("insert");

    let contacts = store.contacts("", 20).expect("contacts");
    let marc = contact(&contacts, "marc@mail.fr");
    assert_eq!(marc.received, 3);
    assert_eq!(marc.name.as_deref(), Some("Marc Delaunay"));
    assert_eq!(marc.last_seen.as_deref(), Some("2026-11-12T10:00:00Z"));
}

#[test]
fn a_message_without_account_or_folder_is_not_a_contact_and_not_an_error() {
    let store = Store::open_in_memory().expect("open");
    store.migrate().expect("migrate");
    store
        .upsert_message(&message(1, "t1", "Marc", "Planning", 10))
        .expect("insert");

    assert!(store.contacts("", 20).expect("contacts").is_empty());
}

#[test]
fn contacts_are_filtered_sorted_and_paged() {
    let store = open();
    for (uid, name, day) in [(1, "Marc", 10), (2, "Marc", 11), (3, "Lea", 12)] {
        store
            .upsert_message(&message(uid, &format!("t{uid}"), name, "Planning", day))
            .expect("insert");
    }
    store
        .upsert_message(&message(4, "t4", "Marc", "Encore", 13))
        .expect("insert");

    let all = store.contacts("", 20).expect("contacts");
    assert_eq!(
        all.iter()
            .map(|contact| contact.email.as_str())
            .collect::<Vec<_>>(),
        ["marc@mail.fr", "lea@mail.fr"],
        "le plus fréquent d'abord"
    );
    assert_eq!(contact(&all, "marc@mail.fr").received, 3);
    assert_eq!(all[1].last_seen.as_deref(), Some("2026-11-12T10:00:00Z"));

    assert_eq!(store.contacts("marc", 20).expect("contacts").len(), 1);
    assert_eq!(store.contacts("LEA@", 20).expect("contacts").len(), 1);
    assert_eq!(store.contacts("mai", 20).expect("contacts").len(), 2);
    assert!(store.contacts("%", 20).expect("contacts").is_empty());
    assert_eq!(store.contacts("marc", 1).expect("contacts").len(), 1);
}

#[test]
fn the_migration_fills_the_contact_list_once() {
    let path = std::env::temp_dir().join(format!("lavande-contacts-{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);

    {
        let store = Store::open(&path).expect("open");
        store.migrate().expect("migrate");
        store
            .upsert_account("perso", "Perso", "roman@lavande.fr")
            .expect("account");
        add_folder(&store, "perso", "INBOX", FolderRole::Inbox);
        store
            .upsert_message(&message(1, "t1", "Marc", "Planning", 10))
            .expect("insert");
    }
    {
        let conn = rusqlite::Connection::open(&path).expect("raw open");
        conn.execute_batch(
            "DELETE FROM contacts; \
             INSERT INTO contacts (account_id, email, received, sent, source) \
             VALUES ('perso', 'marc@mail.fr', 9, 9, 'mail'); \
             PRAGMA user_version = 7;",
        )
        .expect("base d'avant la table");
    }
    {
        let store = Store::open(&path).expect("reopen");
        store.migrate().expect("migrate");
        let contacts = store.contacts("", 20).expect("contacts");
        let marc = contact(&contacts, "marc@mail.fr");
        assert_eq!(
            marc.received, 1,
            "les compteurs sont reconstruits, pas additionnés"
        );
        assert_eq!(marc.sent, 0);
        assert_eq!(marc.name.as_deref(), Some("Marc"));

        store.migrate().expect("migrate encore");
        let again = store.contacts("", 20).expect("contacts");
        assert_eq!(
            contact(&again, "marc@mail.fr").received,
            1,
            "la migration rejouée ne compte pas deux fois"
        );

        store
            .upsert_message(&message(2, "t2", "Marc", "Re: Planning", 11))
            .expect("insert");
        let after = store.contacts("", 20).expect("contacts");
        assert_eq!(contact(&after, "marc@mail.fr").received, 2);
    }

    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
}

#[test]
fn a_directory_sync_mirrors_the_address_book() {
    let store = open();
    let contacts = [
        lavande_mail::DirectoryContact {
            name: Some("Jean Dupont".to_string()),
            email: "jean.dupont@exemple.tld".to_string(),
        },
        lavande_mail::DirectoryContact {
            name: None,
            email: "Sans-Nom@Exemple.TLD".to_string(),
        },
    ];
    store
        .sync_directory_contacts("perso", &contacts, "2026-11-22T10:00:00Z")
        .expect("première synchronisation");

    let listed = store.contacts("", 10).expect("carnet");
    assert_eq!(listed.len(), 2);
    let jean = listed
        .iter()
        .find(|contact| contact.email == "jean.dupont@exemple.tld")
        .expect("Jean");
    assert_eq!(jean.name.as_deref(), Some("Jean Dupont"));
    // Les adresses du carnet sont rangées en minuscules, sans doublon de casse.
    assert!(listed
        .iter()
        .any(|contact| contact.email == "sans-nom@exemple.tld"));
    assert_eq!(jean.received + jean.sent, 0);

    // Une carte retirée du serveur disparaît du carnet.
    store
        .sync_directory_contacts("perso", &contacts[..1], "2026-11-23T10:00:00Z")
        .expect("seconde synchronisation");
    let listed = store.contacts("", 10).expect("carnet");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].email, "jean.dupont@exemple.tld");
}

#[test]
fn a_directory_sync_leaves_the_mail_contacts_alone() {
    let store = open();
    let headers = message(1, "t1", "Jean", "Planning", 20);
    store
        .upsert_message_with_attachment(&headers, true)
        .expect("message");
    let parsed = lavande_mail::mime::parse_message(
        b"From: Jean <jean@mail.fr>\r\nSubject: x\r\n\r\ncorps\r\n",
    )
    .expect("corps");
    store
        .set_body("perso", "INBOX", 1, &parsed)
        .expect("corps rangé");
    let before = store.contacts("jean@mail.fr", 5).expect("carnet");
    assert_eq!(before.len(), 1);
    assert!(before[0].received + before[0].sent > 0);
    let name_before = before[0].name.clone();

    // Le carnet annonce la même adresse sous un autre nom : la ligne du mail ne bouge pas.
    let contacts = [lavande_mail::DirectoryContact {
        name: Some("Annuaire".to_string()),
        email: "jean@mail.fr".to_string(),
    }];
    store
        .sync_directory_contacts("perso", &contacts, "2026-11-22T10:00:00Z")
        .expect("synchronisation");
    let after = store.contacts("jean@mail.fr", 5).expect("carnet");
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].name, name_before);
    assert_eq!(after[0].received, before[0].received);
    assert_eq!(after[0].sent, before[0].sent);

    // Une synchronisation sans cette carte ne touche pas non plus la ligne du mail.
    store
        .sync_directory_contacts("perso", &[], "2026-11-23T10:00:00Z")
        .expect("synchronisation vide");
    assert_eq!(store.contacts("jean@mail.fr", 5).expect("carnet").len(), 1);
}
