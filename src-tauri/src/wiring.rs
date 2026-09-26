//! A command is only callable if three lists agree: the handler in `lib.rs`, the app manifest in
//! `build.rs` (which generates its `allow-*` permission), and the capability that grants it. When they
//! drift the app builds fine and the call fails at run time, so this checks them against each other.

use std::collections::BTreeSet;

const LIB: &str = include_str!("lib.rs");
const BUILD: &str = include_str!("../build.rs");
const CAPABILITY: &str = include_str!("../capabilities/default.json");
const CONFIG: &str = include_str!("../tauri.conf.json");

fn in_handler() -> BTreeSet<String> {
    let start = LIB.find("generate_handler![").expect("the handler list");
    let end = start
        + LIB[start..]
            .find("])")
            .expect("the end of the handler list");
    LIB[start..end]
        .lines()
        .filter_map(|line| line.trim().strip_suffix(','))
        .filter_map(|path| path.rsplit("::").next())
        .map(str::to_string)
        .collect()
}

fn in_manifest() -> BTreeSet<String> {
    let start = BUILD.find("const COMMANDS").expect("the manifest list");
    let end = start
        + BUILD[start..]
            .find("];")
            .expect("the end of the manifest list");
    BUILD[start..end]
        .lines()
        .filter_map(|line| line.trim().strip_prefix('"')?.strip_suffix("\","))
        .map(str::to_string)
        .collect()
}

fn in_capability(capability: &str) -> BTreeSet<String> {
    let json: serde_json::Value = serde_json::from_str(capability).expect("capability JSON");
    json["permissions"]
        .as_array()
        .expect("a permissions list")
        .iter()
        .map(|p| {
            p.as_str()
                .and_then(|p| p.strip_prefix("allow-"))
                .unwrap_or_else(|| panic!("{p} is not an allow-<command> permission"))
                .replace('-', "_")
        })
        .collect()
}

#[test]
fn the_handler_the_manifest_and_the_capability_list_the_same_commands() {
    let handler = in_handler();
    assert_eq!(handler.len(), 52, "{handler:?}");
    assert_eq!(
        handler,
        in_manifest(),
        "lib.rs handler vs build.rs COMMANDS"
    );
    assert_eq!(
        handler,
        in_capability(CAPABILITY),
        "lib.rs handler vs capabilities/default.json"
    );
}

#[test]
fn the_window_is_granted_only_its_own_commands() {
    for (capability, window) in [(CAPABILITY, crate::window::MAIN)] {
        let json: serde_json::Value = serde_json::from_str(capability).expect("capability JSON");
        assert_eq!(json["windows"], serde_json::json!([window]));
        for permission in json["permissions"].as_array().unwrap() {
            let permission = permission.as_str().unwrap();
            assert!(
                !permission.contains(':'),
                "{permission} is a plugin or core permission; the page may not have one"
            );
        }
    }
}

#[test]
fn the_config_matches_what_the_code_assumes() {
    let config: serde_json::Value = serde_json::from_str(CONFIG).expect("tauri.conf.json");
    let window = &config["app"]["windows"][0];
    assert_eq!(window["label"], crate::window::MAIN);
    assert_eq!(
        window["create"], false,
        "the window is created in lifecycle::setup"
    );
    assert_eq!(
        window["visible"], false,
        "the window is shown by host_ready"
    );
    let url = config["build"]["devUrl"].as_str().unwrap();
    assert!(
        url.ends_with(":5198"),
        "window::DEV_PORT is the dev server's port: {url}"
    );
    assert_eq!(config["version"], "../package.json");
}

#[test]
fn the_tray_icons_are_real_images() {
    for (name, bytes) in [
        (
            "tray-template.png",
            &include_bytes!("../icons/tray-template.png")[..],
        ),
        (
            "tray-color.png",
            &include_bytes!("../icons/tray-color.png")[..],
        ),
    ] {
        let image =
            tauri::image::Image::from_bytes(bytes).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(
            image.width() > 0 && image.width() == image.height(),
            "{name} is not square"
        );
    }
}
