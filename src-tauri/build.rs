fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "lavandeupdater",
            tauri_build::InlinedPlugin::new()
                .commands(&[
                    "download_apk",
                    "can_install",
                    "open_install_settings",
                    "install_apk",
                    // La progression passe par addPluginListener (Channels) : sans ces deux
                    // commandes, l'ACL rejette leur enregistrement et l'événement se perd.
                    "register_listener",
                    "remove_listener",
                ])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("failed to run tauri-build");
}
