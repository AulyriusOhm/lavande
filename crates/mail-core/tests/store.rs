use chrono::{TimeZone, Utc};
use lavande_mail::model::{Address, AttachmentMeta, Flags, Folder, FolderRole, Message, PgpState};
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
    assert_eq!(stored.flags, flags);

    store
        .set_body("perso", "INBOX", 1, Some("texte"), Some("<p>html</p>"))
        .expect("body");
    let stored = store
        .get_message("perso", "INBOX", 1)
        .expect("get")
        .expect("present");
    assert_eq!(stored.body_text.as_deref(), Some("texte"));
    assert_eq!(stored.body_html.as_deref(), Some("<p>html</p>"));

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
fn moves_message_with_attachments() {
    let store = open();
    let mut mail = message(1, "t1", "Marc", "Planning", 10);
    mail.attachments.push(AttachmentMeta {
        filename: "planning.pdf".to_string(),
        mime: "application/pdf".to_string(),
        size: 8,
        inline: false,
    });
    store.upsert_message(&mail).expect("insert");

    store
        .move_message("perso", "INBOX", 1, "Archive")
        .expect("move");
    assert!(store
        .messages_in_folder("perso", "INBOX", -1, 0)
        .expect("list")
        .is_empty());
    let archived = store
        .messages_in_folder("perso", "Archive", -1, 0)
        .expect("list");
    assert_eq!(archived.len(), 1);
    assert_eq!(archived[0].folder_path, "Archive");
    assert_eq!(archived[0].attachments, mail.attachments);
    assert!(store.move_message("perso", "INBOX", 1, "Archive").is_err());
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

    let threads = store.threads_in_folder("perso", "INBOX").expect("threads");
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

    let threads = store.threads_in_folder("perso", "Sent").expect("threads");
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].preview, "Je lance la phase 2 lundi");
    assert!(threads[0].participants.is_empty());
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

    let threads = store.threads_in_folder("perso", "INBOX").expect("threads");
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].id, root);
    assert_eq!(threads[0].count, 2);
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
