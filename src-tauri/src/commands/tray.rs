//! The page draws what the tray menu shows — each file as its own small diagram, and the action icons
//! in the ink of the current appearance — because it already holds every diagram's shape and knows
//! whether the system is light or dark. This takes those drawings and nothing else: images it can
//! check are PNGs of a sensible size, recovery ids of the one form they have, and file handles the
//! shell gave out. A path never comes this way.

use super::run_blocking;
use crate::errors::AppError;
use crate::menu::{Icon, TrayActionIcons, TrayDraft};
use crate::recovery::is_valid_id;
use crate::state::AppState;
use crate::tray::TrayArt;
use crate::util::lock;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::AppHandle;

/// An 18pt menu icon drawn at 2x is 36px square; this leaves room for any honest PNG of that and
/// refuses anything that isn't one.
const MAX_ICON_BYTES: usize = 16 * 1024;
const MAX_FILES: usize = 16;
const MAX_DRAFTS: usize = 16;
const MAX_TITLE_CHARS: usize = 60;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayArtInput {
    #[serde(default)]
    actions: HashMap<String, String>,
    #[serde(default)]
    files: Vec<FileArt>,
    #[serde(default)]
    drafts: Vec<DraftArt>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileArt {
    handle: String,
    png: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftArt {
    id: String,
    title: String,
    png: Option<String>,
}

fn icon(base64: &str) -> Option<Icon> {
    let bytes = STANDARD.decode(base64).ok()?;
    (bytes.len() <= MAX_ICON_BYTES && bytes.starts_with(PNG_SIGNATURE)).then(|| Arc::new(bytes))
}

/// A title as a menu shows it: one line, no control characters, and short enough not to widen the menu.
fn menu_title(title: &str) -> String {
    let clean: String = title
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let trimmed = clean.trim();
    if trimmed.chars().count() <= MAX_TITLE_CHARS {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(MAX_TITLE_CHARS - 1).collect();
    format!("{}\u{2026}", cut.trim_end())
}

/// Checks what the page sent and turns it into what the tray keeps. Anything that doesn't pass is left
/// out on its own, so one bad image costs one icon, never the menu.
pub(crate) fn accept(state: &AppState, input: TrayArtInput) -> TrayArt {
    let action = |key: &str| input.actions.get(key).and_then(|png| icon(png));
    let actions = TrayActionIcons {
        quick_draft: action("quickDraft"),
        new_canvas: action("newCanvas"),
        open: action("open"),
        open_project: action("openProject"),
    };
    let files = input
        .files
        .iter()
        .take(MAX_FILES)
        .filter_map(|file| Some((state.file(&file.handle).ok()?.path, icon(&file.png)?)))
        .collect();
    let drafts = input
        .drafts
        .iter()
        .filter(|draft| is_valid_id(&draft.id))
        .take(MAX_DRAFTS)
        .map(|draft| TrayDraft {
            id: draft.id.clone(),
            title: {
                let title = menu_title(&draft.title);
                if title.is_empty() {
                    "Quick Draft".to_string()
                } else {
                    title
                }
            },
            icon: draft.png.as_deref().and_then(icon),
        })
        .collect();
    TrayArt {
        actions,
        files,
        drafts,
    }
}

#[tauri::command]
pub async fn tray_decorate(app: AppHandle, art: TrayArtInput) -> Result<(), AppError> {
    run_blocking(&app, move |app, state| {
        *lock(&state.tray_art) = accept(state, art);
        crate::tray::refresh(app);
        Ok(())
    })
    .await
}

/// How many of each the panel shows; the rest are a click on "Show Draft Canvas" away.
const PANEL_RECENTS: usize = 6;
const PANEL_DRAFTS: usize = 3;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelRecent {
    /// What `tray_choose` takes to open it.
    choice: String,
    /// What `peek_document` takes to draw it.
    handle: String,
    name: String,
    opened_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelDraft {
    choice: String,
    /// What `recovery_read` takes to draw it.
    id: String,
    title: String,
    updated_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelState {
    recents: Vec<PanelRecent>,
    drafts: Vec<PanelDraft>,
}

/// What the tray panel lists: the same drafts the menu does (titled by the page, see `tray_decorate`),
/// with when each was last written, and the newest recent files.
pub(crate) fn panel_state(state: &AppState) -> PanelState {
    let recents = crate::tray::recent_entries(state)
        .into_iter()
        .take(PANEL_RECENTS)
        .map(|e| PanelRecent {
            choice: format!("recent:{}", e.handle),
            handle: e.handle,
            name: e.name,
            opened_ms: e.last_opened_ms,
        })
        .collect();
    let written: HashMap<String, u64> = state
        .recovery
        .list()
        .unwrap_or_default()
        .into_iter()
        .map(|entry| (entry.id, entry.updated_at))
        .collect();
    let drafts = lock(&state.tray_art)
        .drafts
        .iter()
        .take(PANEL_DRAFTS)
        .map(|draft| PanelDraft {
            choice: format!("draft:{}", draft.id),
            id: draft.id.clone(),
            title: draft.title.clone(),
            updated_ms: written.get(&draft.id).copied(),
        })
        .collect();
    PanelState { recents, drafts }
}

/// The panel may choose what the tray menu offers — its own items, a recent file, a waiting draft —
/// and nothing from the app menu: Save or Close Window from a popover would act on a window the
/// person isn't looking at.
pub(crate) fn is_tray_choice(id: &str) -> bool {
    (id.starts_with("tray:") || id.starts_with("recent:") || id.starts_with("draft:"))
        && crate::menu::action_for_id(id).is_some()
}

#[tauri::command]
pub async fn tray_panel(app: AppHandle) -> Result<PanelState, AppError> {
    run_blocking(&app, |_, state| Ok(panel_state(state))).await
}

/// What the panel sends to put itself away (Escape) without choosing anything.
const DISMISS: &str = "panel:dismiss";

#[tauri::command]
pub fn tray_choose(app: AppHandle, choice: String) -> Result<(), AppError> {
    if choice != DISMISS && !is_tray_choice(&choice) {
        return Err(AppError::bad_request("not a tray choice"));
    }
    let handle = app.clone();
    app.run_on_main_thread(move || {
        crate::panel::hide(&handle);
        if choice != DISMISS {
            crate::menu::handle_event(&handle, &choice);
        }
    })
    .map_err(|_| AppError::internal())
}

#[tauri::command]
pub fn tray_panel_fit(app: AppHandle, height: f64) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || crate::panel::fit(&handle, height));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::testing::{doc, test_state};

    const DRAFT: &str = "q_0123abcd-0000-4000-8000-000000000000";

    fn png() -> String {
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.extend_from_slice(&[0u8; 64]);
        STANDARD.encode(bytes)
    }

    #[test]
    fn keeps_each_files_drawing_under_the_file_it_belongs_to() {
        let (dir, state) = test_state();
        let path = doc(&dir, "flow.draftcanvas", "{}");
        let handle = state.grant_file(&path).unwrap();
        let art = accept(
            &state,
            TrayArtInput {
                files: vec![FileArt { handle, png: png() }],
                ..Default::default()
            },
        );
        assert!(art.files.contains_key(&dunce::canonicalize(&path).unwrap()));
    }

    #[test]
    fn a_handle_it_never_gave_out_is_ignored() {
        let (_dir, state) = test_state();
        let art = accept(
            &state,
            TrayArtInput {
                files: vec![FileArt {
                    handle: "h_made-up".into(),
                    png: png(),
                }],
                ..Default::default()
            },
        );
        assert!(art.files.is_empty());
    }

    #[test]
    fn only_pngs_of_a_menu_icons_size_are_taken() {
        assert!(icon(&png()).is_some());
        assert!(icon(&STANDARD.encode(b"GIF89a not a png")).is_none());
        assert!(icon("not base64 at all!").is_none());
        let mut huge = PNG_SIGNATURE.to_vec();
        huge.resize(MAX_ICON_BYTES + 1, 0);
        assert!(icon(&STANDARD.encode(huge)).is_none());
    }

    #[test]
    fn drafts_need_a_real_recovery_id_and_get_a_menu_sized_title() {
        let (_dir, state) = test_state();
        let art = accept(
            &state,
            TrayArtInput {
                drafts: vec![
                    DraftArt {
                        id: DRAFT.into(),
                        title: "Auth\nrework".into(),
                        png: Some(png()),
                    },
                    DraftArt {
                        id: "../../etc/passwd".into(),
                        title: "x".into(),
                        png: None,
                    },
                    DraftArt {
                        id: DRAFT.replace('q', "f"),
                        title: "a".repeat(200),
                        png: None,
                    },
                ],
                ..Default::default()
            },
        );
        assert_eq!(art.drafts.len(), 2);
        assert_eq!(art.drafts[0].title, "Auth rework");
        assert!(art.drafts[0].icon.is_some());
        assert_eq!(art.drafts[1].title.chars().count(), MAX_TITLE_CHARS);
        assert!(art.drafts[1].title.ends_with('\u{2026}'));
    }

    #[test]
    fn a_blank_draft_title_still_reads_as_a_draft() {
        let (_dir, state) = test_state();
        let art = accept(
            &state,
            TrayArtInput {
                drafts: vec![DraftArt {
                    id: DRAFT.into(),
                    title: "   ".into(),
                    png: None,
                }],
                ..Default::default()
            },
        );
        assert_eq!(art.drafts[0].title, "Quick Draft");
    }

    #[test]
    fn the_panel_may_choose_only_what_the_tray_offers() {
        assert!(is_tray_choice("tray:new-quick-draft"));
        assert!(is_tray_choice("tray:quit"));
        assert!(is_tray_choice("recent:h_1"));
        assert!(is_tray_choice(&format!("draft:{DRAFT}")));
        assert!(!is_tray_choice("app:save"));
        assert!(!is_tray_choice("app:close-window"));
        assert!(!is_tray_choice("tray:launch-missiles"));
        assert!(!is_tray_choice("draft:../../etc/passwd"));
    }

    #[test]
    fn the_panel_lists_recent_files_and_the_drafts_the_page_titled() {
        let (dir, state) = test_state();
        let path = doc(&dir, "flow.draftcanvas", "{}");
        state
            .recents
            .add(crate::recents::RecentKind::File, &path, "flow", 1)
            .unwrap();
        *lock(&state.tray_art) = accept(
            &state,
            TrayArtInput {
                drafts: vec![DraftArt {
                    id: DRAFT.into(),
                    title: "Auth rework".into(),
                    png: None,
                }],
                ..Default::default()
            },
        );
        let panel = panel_state(&state);
        assert_eq!(panel.recents.len(), 1);
        assert_eq!(panel.recents[0].name, "flow");
        assert_eq!(
            panel.recents[0].choice,
            format!("recent:{}", panel.recents[0].handle)
        );
        assert_eq!(panel.drafts.len(), 1);
        assert_eq!(panel.drafts[0].choice, format!("draft:{DRAFT}"));
        assert_eq!(panel.drafts[0].updated_ms, None);
    }

    #[test]
    fn only_the_known_actions_are_drawn() {
        let (_dir, state) = test_state();
        let art = accept(
            &state,
            TrayArtInput {
                actions: HashMap::from([
                    ("quickDraft".to_string(), png()),
                    ("launchMissiles".to_string(), png()),
                ]),
                ..Default::default()
            },
        );
        assert!(art.actions.quick_draft.is_some());
        assert!(art.actions.open.is_none());
    }
}
