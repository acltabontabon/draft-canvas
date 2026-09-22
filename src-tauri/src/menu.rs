//! The application menu bar and the tray menu, and what choosing an item does.
//!
//! Menus are described first as plain data (`Spec`), so their contents, shortcuts and wiring can be
//! tested without a window, and only then turned into native menu objects. Every item is custom rather
//! than predefined wherever the page must decide what happens: a predefined Undo on macOS goes straight
//! into the web view's text undo and would never reach the canvas.

use crate::grants::Handle;
use crate::state::{AppState, HostEvent, MenuCommand};
use crate::window::{show_main, Platform};
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Runtime};

pub const DOCS_URL: &str = "https://github.com/acltabontabon/draft-canvas/tree/main/docs";
const RECENT_PREFIX: &str = "recent:";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Predefined {
    Cut,
    Copy,
    Paste,
    Fullscreen,
    Services,
    Hide,
    HideOthers,
    ShowAll,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Spec {
    Item {
        id: String,
        text: String,
        accelerator: Option<&'static str>,
        enabled: bool,
    },
    Separator,
    Predefined(Predefined),
    Submenu {
        text: String,
        items: Vec<Spec>,
    },
}

fn item(id: &str, text: &str, accelerator: Option<&'static str>) -> Spec {
    Spec::Item {
        id: id.to_string(),
        text: text.to_string(),
        accelerator,
        enabled: true,
    }
}

fn submenu(text: &str, items: Vec<Spec>) -> Spec {
    Spec::Submenu {
        text: text.to_string(),
        items,
    }
}

/// What a menu or tray item does. Everything that only tells the page something is one `Emit`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Emit(HostEvent),
    /// The same path as the window's close button, so the shortcut and the button never disagree.
    CloseWindow,
    Quit,
    ShowWindow,
    OpenRecent(Handle),
    OpenDocs,
}

fn menu_event(command: MenuCommand) -> Action {
    Action::Emit(HostEvent::Menu { command })
}

/// The one table that ties an item's id to its action. Ids are `app:*` for the menu bar, `tray:*` for
/// the tray and `recent:<handle>` for a recent file in the tray.
pub fn action_for_id(id: &str) -> Option<Action> {
    if let Some(handle) = id.strip_prefix(RECENT_PREFIX) {
        return Some(Action::OpenRecent(handle.to_string()));
    }
    Some(match id {
        "app:new-quick-draft" | "tray:new-quick-draft" => Action::Emit(HostEvent::NewQuickDraft),
        "app:new-canvas" => menu_event(MenuCommand::NewCanvas),
        "tray:new-canvas" => Action::Emit(HostEvent::NewCanvas),
        "app:open" | "tray:open" => menu_event(MenuCommand::Open),
        "app:open-project" | "tray:open-project" => menu_event(MenuCommand::OpenProject),
        "app:save" => menu_event(MenuCommand::Save),
        "app:save-as" => menu_event(MenuCommand::SaveAs),
        "app:revert" => menu_event(MenuCommand::Revert),
        "app:reveal" => menu_event(MenuCommand::Reveal),
        "app:undo" => menu_event(MenuCommand::Undo),
        "app:redo" => menu_event(MenuCommand::Redo),
        "app:select-all" => menu_event(MenuCommand::SelectAll),
        "app:shortcuts" => menu_event(MenuCommand::Shortcuts),
        "app:about" => menu_event(MenuCommand::About),
        "app:settings" | "tray:settings" => menu_event(MenuCommand::Settings),
        "app:close-window" => Action::CloseWindow,
        "app:quit" | "tray:quit" => Action::Quit,
        "tray:show" => Action::ShowWindow,
        "app:docs" => Action::OpenDocs,
        _ => return None,
    })
}

/// The menu bar. macOS gets its app menu (About, Settings, Services, Hide, Quit) and a View menu with
/// full screen; Windows and Linux fold About into Help, put Quit in File, and have no View menu because
/// the native full-screen item doesn't exist there.
pub fn app_menu(platform: Platform) -> Vec<Spec> {
    let mac = platform == Platform::Macos;
    let reveal_text = match platform {
        Platform::Macos => "Reveal in Finder",
        Platform::Windows => "Reveal in File Explorer",
        Platform::Linux => "Reveal in File Manager",
    };

    let mut file = vec![
        item(
            "app:new-quick-draft",
            "New Quick Draft",
            Some("CmdOrCtrl+N"),
        ),
        item(
            "app:new-canvas",
            "New Canvas\u{2026}",
            Some("CmdOrCtrl+Shift+N"),
        ),
        item("app:open", "Open\u{2026}", Some("CmdOrCtrl+O")),
        item(
            "app:open-project",
            "Open Project\u{2026}",
            Some("CmdOrCtrl+Shift+O"),
        ),
        Spec::Separator,
        item("app:save", "Save", Some("CmdOrCtrl+S")),
        item("app:save-as", "Save As\u{2026}", Some("CmdOrCtrl+Shift+S")),
        item("app:revert", "Revert to Saved\u{2026}", None),
        Spec::Separator,
        item("app:reveal", reveal_text, None),
        Spec::Separator,
    ];
    if !mac {
        file.push(item(
            "app:settings",
            "Settings\u{2026}",
            Some("CmdOrCtrl+,"),
        ));
        file.push(Spec::Separator);
    }
    file.push(item(
        "app:close-window",
        "Close Window",
        Some("CmdOrCtrl+W"),
    ));
    if !mac {
        file.push(item("app:quit", "Quit", Some("CmdOrCtrl+Q")));
    }

    let edit = vec![
        item("app:undo", "Undo", Some("CmdOrCtrl+Z")),
        item("app:redo", "Redo", Some("CmdOrCtrl+Shift+Z")),
        Spec::Separator,
        Spec::Predefined(Predefined::Cut),
        Spec::Predefined(Predefined::Copy),
        Spec::Predefined(Predefined::Paste),
        item("app:select-all", "Select All", Some("CmdOrCtrl+A")),
    ];

    let mut help = vec![
        item("app:shortcuts", "Keyboard Shortcuts", None),
        item("app:docs", "Documentation", None),
    ];
    if !mac {
        help.push(Spec::Separator);
        help.push(item("app:about", "About Draft Canvas", None));
    }

    let mut bar = Vec::new();
    if mac {
        bar.push(submenu(
            "Draft Canvas",
            vec![
                item("app:about", "About Draft Canvas", None),
                Spec::Separator,
                item("app:settings", "Settings\u{2026}", Some("CmdOrCtrl+,")),
                Spec::Separator,
                Spec::Predefined(Predefined::Services),
                Spec::Separator,
                Spec::Predefined(Predefined::Hide),
                Spec::Predefined(Predefined::HideOthers),
                Spec::Predefined(Predefined::ShowAll),
                Spec::Separator,
                item("app:quit", "Quit Draft Canvas", Some("CmdOrCtrl+Q")),
            ],
        ));
    }
    bar.push(submenu("File", file));
    bar.push(submenu("Edit", edit));
    if mac {
        bar.push(submenu(
            "View",
            vec![Spec::Predefined(Predefined::Fullscreen)],
        ));
    }
    bar.push(submenu("Help", help));
    bar
}

/// A file the tray offers under Recent: only what the tray needs to show and to hand back.
pub struct TrayRecent {
    pub handle: Handle,
    pub name: String,
}

const TRAY_RECENTS: usize = 8;

pub fn tray_menu(recents: &[TrayRecent]) -> Vec<Spec> {
    let recent_items = if recents.is_empty() {
        vec![Spec::Item {
            id: "tray:no-recents".to_string(),
            text: "No recent files".to_string(),
            accelerator: None,
            enabled: false,
        }]
    } else {
        recents
            .iter()
            .take(TRAY_RECENTS)
            .map(|r| Spec::Item {
                id: format!("{RECENT_PREFIX}{}", r.handle),
                // `&` marks a keyboard mnemonic in native menus, so a file called "R&D" needs it doubled.
                text: r.name.replace('&', "&&"),
                accelerator: None,
                enabled: true,
            })
            .collect()
    };
    vec![
        item("tray:new-quick-draft", "New Quick Draft", None),
        item("tray:new-canvas", "New Canvas\u{2026}", None),
        Spec::Separator,
        submenu("Recent", recent_items),
        Spec::Separator,
        item("tray:open", "Open File\u{2026}", None),
        item("tray:open-project", "Open Project\u{2026}", None),
        Spec::Separator,
        item("tray:show", "Show Draft Canvas", None),
        item("tray:settings", "Settings\u{2026}", None),
        Spec::Separator,
        item("tray:quit", "Quit Draft Canvas", None),
    ]
}

// --- turning specs into native menus -----------------------------------------------------------

fn realize_one<R: Runtime, M: Manager<R>>(
    manager: &M,
    spec: &Spec,
) -> tauri::Result<Box<dyn IsMenuItem<R>>> {
    Ok(match spec {
        Spec::Item {
            id,
            text,
            accelerator,
            enabled,
        } => Box::new(MenuItem::with_id(
            manager,
            id.as_str(),
            text,
            *enabled,
            *accelerator,
        )?),
        Spec::Separator => Box::new(PredefinedMenuItem::separator(manager)?),
        Spec::Predefined(kind) => match kind {
            Predefined::Cut => Box::new(PredefinedMenuItem::cut(manager, None)?),
            Predefined::Copy => Box::new(PredefinedMenuItem::copy(manager, None)?),
            Predefined::Paste => Box::new(PredefinedMenuItem::paste(manager, None)?),
            Predefined::Fullscreen => Box::new(PredefinedMenuItem::fullscreen(manager, None)?),
            Predefined::Services => Box::new(PredefinedMenuItem::services(manager, None)?),
            Predefined::Hide => Box::new(PredefinedMenuItem::hide(manager, None)?),
            Predefined::HideOthers => Box::new(PredefinedMenuItem::hide_others(manager, None)?),
            Predefined::ShowAll => Box::new(PredefinedMenuItem::show_all(manager, None)?),
        },
        Spec::Submenu { text, items } => {
            let built = realize_all(manager, items)?;
            let refs: Vec<&dyn IsMenuItem<R>> = built.iter().map(|b| b.as_ref()).collect();
            Box::new(Submenu::with_items(manager, text, true, &refs)?)
        }
    })
}

fn realize_all<R: Runtime, M: Manager<R>>(
    manager: &M,
    specs: &[Spec],
) -> tauri::Result<Vec<Box<dyn IsMenuItem<R>>>> {
    specs.iter().map(|s| realize_one(manager, s)).collect()
}

pub fn realize<R: Runtime, M: Manager<R>>(manager: &M, specs: &[Spec]) -> tauri::Result<Menu<R>> {
    let built = realize_all(manager, specs)?;
    let refs: Vec<&dyn IsMenuItem<R>> = built.iter().map(|b| b.as_ref()).collect();
    Menu::with_items(manager, &refs)
}

// --- doing what an item says -------------------------------------------------------------------

/// Called for every menu and tray item chosen. Items that tell the page something bring the window
/// forward first, so a choice made while it is hidden in the tray isn't invisible.
pub fn handle_event(app: &AppHandle, id: &str) {
    let Some(action) = action_for_id(id) else {
        return;
    };
    match action {
        Action::Emit(event) => {
            show_main(app);
            app.state::<AppState>().events.emit(event);
        }
        Action::CloseWindow => crate::lifecycle::request_close(app),
        Action::Quit => crate::quit::request_quit(app),
        Action::ShowWindow => show_main(app),
        Action::OpenRecent(handle) => {
            show_main(app);
            let state = app.state::<AppState>();
            state.deliver_opens(vec![handle]);
        }
        // Handing a URL to the OS launches a process; not something to wait for on the event loop.
        Action::OpenDocs => {
            tauri::async_runtime::spawn_blocking(|| {
                let _ = tauri_plugin_opener::open_url(DOCS_URL, None::<&str>);
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use muda::accelerator::Accelerator;
    use std::collections::HashSet;

    fn flatten(specs: &[Spec]) -> Vec<&Spec> {
        let mut out = Vec::new();
        for spec in specs {
            out.push(spec);
            if let Spec::Submenu { items, .. } = spec {
                out.extend(flatten(items));
            }
        }
        out
    }

    fn items(specs: &[Spec]) -> Vec<(&str, &str, Option<&'static str>, bool)> {
        flatten(specs)
            .into_iter()
            .filter_map(|s| match s {
                Spec::Item {
                    id,
                    text,
                    accelerator,
                    enabled,
                } => Some((id.as_str(), text.as_str(), *accelerator, *enabled)),
                _ => None,
            })
            .collect()
    }

    fn find<'a>(specs: &'a [Spec], id: &str) -> (&'a str, Option<&'static str>) {
        items(specs)
            .into_iter()
            .find(|(i, ..)| *i == id)
            .map(|(_, text, accel, _)| (text, accel))
            .unwrap_or_else(|| panic!("no item {id}"))
    }

    fn submenu_titles(specs: &[Spec]) -> Vec<&str> {
        specs
            .iter()
            .filter_map(|s| match s {
                Spec::Submenu { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    fn submenu_items<'a>(specs: &'a [Spec], title: &str) -> &'a [Spec] {
        specs
            .iter()
            .find_map(|s| match s {
                Spec::Submenu { text, items } if text == title => Some(items.as_slice()),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no submenu {title}"))
    }

    const PLATFORMS: [Platform; 3] = [Platform::Macos, Platform::Windows, Platform::Linux];

    #[test]
    fn every_item_id_is_unique_and_wired_to_an_action() {
        for platform in PLATFORMS {
            let bar = app_menu(platform);
            let mut seen = HashSet::new();
            for (id, ..) in items(&bar) {
                assert!(seen.insert(id), "{platform:?}: duplicate {id}");
                assert!(id.starts_with("app:"), "{id}");
                assert!(
                    action_for_id(id).is_some(),
                    "{platform:?}: {id} does nothing"
                );
            }
        }
        let tray = tray_menu(&[TrayRecent {
            handle: "h_1".into(),
            name: "a".into(),
        }]);
        for (id, ..) in items(&tray) {
            if id != "tray:no-recents" {
                assert!(action_for_id(id).is_some(), "{id} does nothing");
            }
        }
    }

    #[test]
    fn every_shortcut_parses_and_none_is_shared() {
        for platform in PLATFORMS {
            let mut seen = HashSet::new();
            for (id, _, accel, _) in items(&app_menu(platform)) {
                if let Some(accel) = accel {
                    assert!(
                        accel.parse::<Accelerator>().is_ok(),
                        "{id}: {accel:?} is not a shortcut muda understands"
                    );
                    assert!(seen.insert(accel), "{platform:?}: {accel} is used twice");
                }
            }
        }
    }

    #[test]
    fn the_file_menu_has_the_documented_shortcuts() {
        let bar = app_menu(Platform::Macos);
        for (id, text, accel) in [
            ("app:new-quick-draft", "New Quick Draft", "CmdOrCtrl+N"),
            ("app:new-canvas", "New Canvas\u{2026}", "CmdOrCtrl+Shift+N"),
            ("app:open", "Open\u{2026}", "CmdOrCtrl+O"),
            (
                "app:open-project",
                "Open Project\u{2026}",
                "CmdOrCtrl+Shift+O",
            ),
            ("app:save", "Save", "CmdOrCtrl+S"),
            ("app:save-as", "Save As\u{2026}", "CmdOrCtrl+Shift+S"),
            ("app:close-window", "Close Window", "CmdOrCtrl+W"),
        ] {
            assert_eq!(find(&bar, id), (text, Some(accel)), "{id}");
        }
        assert_eq!(find(&bar, "app:revert"), ("Revert to Saved\u{2026}", None));
    }

    #[test]
    fn undo_redo_and_select_all_are_custom_items_the_page_handles() {
        for platform in PLATFORMS {
            let bar = app_menu(platform);
            let edit = submenu_items(&bar, "Edit");
            assert_eq!(find(edit, "app:undo"), ("Undo", Some("CmdOrCtrl+Z")));
            assert_eq!(find(edit, "app:redo"), ("Redo", Some("CmdOrCtrl+Shift+Z")));
            assert_eq!(
                find(edit, "app:select-all"),
                ("Select All", Some("CmdOrCtrl+A"))
            );
            let predefined: Vec<Predefined> = edit
                .iter()
                .filter_map(|s| match s {
                    Spec::Predefined(p) => Some(*p),
                    _ => None,
                })
                .collect();
            assert_eq!(
                predefined,
                [Predefined::Cut, Predefined::Copy, Predefined::Paste]
            );
        }
    }

    #[test]
    fn macos_gets_an_app_menu_and_a_view_menu_and_no_quit_in_file() {
        let bar = app_menu(Platform::Macos);
        assert_eq!(
            submenu_titles(&bar),
            ["Draft Canvas", "File", "Edit", "View", "Help"]
        );
        let app = submenu_items(&bar, "Draft Canvas");
        assert_eq!(find(app, "app:about").0, "About Draft Canvas");
        assert_eq!(
            find(app, "app:quit"),
            ("Quit Draft Canvas", Some("CmdOrCtrl+Q"))
        );
        assert_eq!(
            find(app, "app:settings"),
            ("Settings\u{2026}", Some("CmdOrCtrl+,"))
        );
        for p in [
            Predefined::Services,
            Predefined::Hide,
            Predefined::HideOthers,
            Predefined::ShowAll,
        ] {
            assert!(app.contains(&Spec::Predefined(p)), "{p:?}");
        }
        assert!(items(submenu_items(&bar, "File"))
            .iter()
            .all(|(id, ..)| *id != "app:quit"));
        assert_eq!(
            submenu_items(&bar, "View"),
            [Spec::Predefined(Predefined::Fullscreen)]
        );
        assert!(items(submenu_items(&bar, "Help"))
            .iter()
            .all(|(id, ..)| *id != "app:about"));
        assert_eq!(
            find(submenu_items(&bar, "File"), "app:reveal").0,
            "Reveal in Finder"
        );
    }

    #[test]
    fn windows_folds_about_into_help_and_puts_quit_in_file() {
        let bar = app_menu(Platform::Windows);
        assert_eq!(submenu_titles(&bar), ["File", "Edit", "Help"]);
        assert_eq!(
            find(submenu_items(&bar, "File"), "app:quit"),
            ("Quit", Some("CmdOrCtrl+Q"))
        );
        assert_eq!(
            find(submenu_items(&bar, "File"), "app:reveal").0,
            "Reveal in File Explorer"
        );
        assert_eq!(
            find(submenu_items(&bar, "Help"), "app:about").0,
            "About Draft Canvas"
        );
        assert_eq!(
            find(submenu_items(&bar, "Help"), "app:docs").0,
            "Documentation"
        );
        assert_eq!(
            find(submenu_items(&bar, "Help"), "app:shortcuts").0,
            "Keyboard Shortcuts"
        );
    }

    #[test]
    fn linux_follows_windows_with_its_own_reveal_wording() {
        let bar = app_menu(Platform::Linux);
        assert_eq!(submenu_titles(&bar), ["File", "Edit", "Help"]);
        assert_eq!(
            find(submenu_items(&bar, "File"), "app:reveal").0,
            "Reveal in File Manager"
        );
    }

    #[test]
    fn every_platform_has_documentation_and_shortcuts_in_help() {
        for platform in PLATFORMS {
            let bar = app_menu(platform);
            let help = submenu_items(&bar, "Help");
            assert_eq!(find(help, "app:docs").0, "Documentation");
            assert_eq!(find(help, "app:shortcuts").0, "Keyboard Shortcuts");
        }
    }

    #[test]
    fn the_tray_menu_is_laid_out_as_documented() {
        let tray = tray_menu(&[]);
        let shape: Vec<String> = tray
            .iter()
            .map(|s| match s {
                Spec::Item { text, .. } => text.clone(),
                Spec::Separator => "-".into(),
                Spec::Submenu { text, .. } => format!("[{text}]"),
                Spec::Predefined(_) => "?".into(),
            })
            .collect();
        assert_eq!(
            shape,
            [
                "New Quick Draft",
                "New Canvas\u{2026}",
                "-",
                "[Recent]",
                "-",
                "Open File\u{2026}",
                "Open Project\u{2026}",
                "-",
                "Show Draft Canvas",
                "Settings\u{2026}",
                "-",
                "Quit Draft Canvas"
            ]
        );
    }

    #[test]
    fn an_empty_recent_list_shows_a_disabled_placeholder() {
        let tray = tray_menu(&[]);
        let recent = submenu_items(&tray, "Recent");
        assert_eq!(recent.len(), 1);
        assert_eq!(
            items(recent),
            [("tray:no-recents", "No recent files", None, false)]
        );
    }

    #[test]
    fn recent_files_are_capped_at_eight_and_carry_their_handle() {
        let recents: Vec<TrayRecent> = (0..12)
            .map(|i| TrayRecent {
                handle: format!("h_{i}"),
                name: format!("file {i}"),
            })
            .collect();
        let tray = tray_menu(&recents);
        let listed = items(submenu_items(&tray, "Recent"));
        assert_eq!(listed.len(), 8);
        assert_eq!(listed[0], ("recent:h_0", "file 0", None, true));
        assert_eq!(listed[7].0, "recent:h_7");
        assert_eq!(
            action_for_id("recent:h_3"),
            Some(Action::OpenRecent("h_3".into()))
        );
    }

    #[test]
    fn an_ampersand_in_a_file_name_is_escaped_so_it_is_not_a_mnemonic() {
        let tray = tray_menu(&[TrayRecent {
            handle: "h_1".into(),
            name: "R&D plan".into(),
        }]);
        assert_eq!(items(submenu_items(&tray, "Recent"))[0].1, "R&&D plan");
    }

    #[test]
    fn tray_items_do_what_the_spec_says() {
        assert_eq!(
            action_for_id("tray:new-quick-draft"),
            Some(Action::Emit(HostEvent::NewQuickDraft))
        );
        assert_eq!(
            action_for_id("tray:new-canvas"),
            Some(Action::Emit(HostEvent::NewCanvas))
        );
        assert_eq!(
            action_for_id("tray:open"),
            Some(menu_event(MenuCommand::Open))
        );
        assert_eq!(
            action_for_id("tray:open-project"),
            Some(menu_event(MenuCommand::OpenProject))
        );
        assert_eq!(
            action_for_id("tray:settings"),
            Some(menu_event(MenuCommand::Settings))
        );
        assert_eq!(action_for_id("tray:show"), Some(Action::ShowWindow));
        assert_eq!(action_for_id("tray:quit"), Some(Action::Quit));
    }

    #[test]
    fn menu_bar_items_do_what_the_spec_says() {
        assert_eq!(
            action_for_id("app:new-quick-draft"),
            Some(Action::Emit(HostEvent::NewQuickDraft))
        );
        assert_eq!(
            action_for_id("app:new-canvas"),
            Some(menu_event(MenuCommand::NewCanvas))
        );
        assert_eq!(
            action_for_id("app:save"),
            Some(menu_event(MenuCommand::Save))
        );
        assert_eq!(action_for_id("app:close-window"), Some(Action::CloseWindow));
        assert_eq!(action_for_id("app:quit"), Some(Action::Quit));
        assert_eq!(action_for_id("app:docs"), Some(Action::OpenDocs));
        assert_eq!(
            action_for_id("app:undo"),
            Some(menu_event(MenuCommand::Undo))
        );
    }

    #[test]
    fn an_unknown_id_does_nothing() {
        for id in ["", "app:", "save", "tray:nope", "recent", "About"] {
            assert_eq!(action_for_id(id), None, "{id}");
        }
    }
}
