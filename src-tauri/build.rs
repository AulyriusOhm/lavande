fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .plugin(
                "lavandeupdater",
                tauri_build::InlinedPlugin::new()
                    .commands(&["download_apk", "can_install", "open_install_settings", "install_apk"])
                    .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
            )
            .plugin(
                "lavandebgsync",
                tauri_build::InlinedPlugin::new()
                    .commands(&[
                        "set_background_sync",
                        "background_sync_state",
                        "set_muted_accounts",
                        "set_widget_agenda_summary",
                        "sync_now",
                    ])
                    .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
            )
            .plugin(
                "lavandeattachments",
                tauri_build::InlinedPlugin::new()
                    .commands(&["open_attachment"])
                    .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
            ),
    )
    .expect("failed to run tauri-build");
}
