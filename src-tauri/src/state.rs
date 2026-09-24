//! Everything the running app remembers, in one value managed by Tauri: what has been granted, the
//! stores on disk, the channel to the page, and the small pieces of lifecycle state.

use crate::errors::AppError;
use crate::grants::{
    resolve_folder_in_root, resolve_in_root, validate_file, validate_folder, FileGrant, Grants,
    Handle, ProjectGrant,
};
use crate::paths::display_path;
use crate::quit::QuitMachine;
use crate::recents::Recents;
use crate::recovery::Recovery;
use crate::settings::SettingsStore;
use crate::util::lock;
use serde::Serialize;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::Sender;
use std::sync::Mutex;
use tauri::ipc::Channel;

/// The commands the page may be told a menu item ran. Spelled as `MenuCommand` in `api.ts`; `close` is
/// there too but never sent: closing the window is decided in Rust (see `lifecycle`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MenuCommand {
    Save,
    SaveAs,
    Open,
    OpenProject,
    NewCanvas,
    Reveal,
    Revert,
    Rename,
    Settings,
    About,
    Shortcuts,
    Undo,
    Redo,
    SelectAll,
}

/// What Rust tells the page on its own account (`HostEvent` in `api.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum HostEvent {
    Open {
        handle: Handle,
        name: String,
        display_path: String,
    },
    NewQuickDraft,
    NewCanvas,
    /// A draft chosen from the tray's Drafts section, by its recovery id.
    RecoverDraft {
        id: String,
    },
    Menu {
        command: MenuCommand,
    },
    QuitRequested,
    /// The same question as `QuitRequested`, asked before an update replaces the app.
    UpdateRequested,
    /// Where an update is now; sent whole on every change.
    Update {
        snapshot: crate::updater::Snapshot,
    },
    WindowFocused,
    RecentsChanged,
    Notice {
        message: String,
    },
    /// A request from an AI agent, carried by the bridge (`agent/`). The page acknowledges it
    /// (`agent_ack`), passes the commit gate before changing anything (`agent_gate`), and answers
    /// (`agent_respond`).
    AgentRequest {
        id: u64,
        tool: String,
        args: serde_json::Value,
        context: serde_json::Value,
    },
    /// An agent's update to a diagram that isn't open was written to its file (request `id`, as sent in
    /// `AgentRequest`), now at `stamp`: the page offers to show it, with the change as one undo step.
    AgentFileWritten {
        id: u64,
        handle: Option<Handle>,
        display_path: String,
        stamp: String,
        /// A new diagram (nothing to undo); otherwise a change to an existing one.
        created: bool,
    },
    /// Agent access was switched on or off, or its connections changed: Settings looks again.
    AgentChanged,
}

struct Bus {
    channel: Option<Channel<HostEvent>>,
    /// Files the OS asked us to open before the page was listening.
    pending_opens: VecDeque<Handle>,
}

/// The one channel to the page, and the queue of files waiting for it.
pub struct EventBus {
    inner: Mutex<Bus>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Bus {
                channel: None,
                pending_opens: VecDeque::new(),
            }),
        }
    }
}

impl EventBus {
    /// Starts listening (replacing any earlier page: a reload attaches again) and hands back every file
    /// that arrived before now. Attaching and draining are one step, so a file can't slip in between.
    pub fn attach(&self, channel: Channel<HostEvent>) -> Vec<Handle> {
        let mut bus = lock(&self.inner);
        bus.channel = Some(channel);
        bus.pending_opens.drain(..).collect()
    }

    pub fn is_attached(&self) -> bool {
        lock(&self.inner).channel.is_some()
    }

    /// Whether the page was reached. A channel that fails to send is dropped, so later opens queue
    /// until a page attaches again and a quit doesn't wait for one that is gone.
    pub fn emit(&self, event: HostEvent) -> bool {
        let mut bus = lock(&self.inner);
        let Some(channel) = &bus.channel else {
            return false;
        };
        if channel.send(event).is_ok() {
            return true;
        }
        bus.channel = None;
        false
    }

    /// Returns the handles back if the page is listening (send them now), or keeps them for later.
    pub fn open_or_queue(&self, handles: Vec<Handle>) -> Option<Vec<Handle>> {
        let mut bus = lock(&self.inner);
        if bus.channel.is_some() {
            Some(handles)
        } else {
            bus.pending_opens.extend(handles);
            None
        }
    }
}

/// One file is opened per request; the rest are said out loud instead of silently dropped.
fn extra_files_notice(extra: usize) -> Option<String> {
    match extra {
        0 => None,
        1 => Some(
            "Draft Canvas opens one file at a time, so 1 other file was left closed.".to_string(),
        ),
        n => Some(format!(
            "Draft Canvas opens one file at a time, so {n} other files were left closed."
        )),
    }
}

pub struct AppState {
    pub grants: Mutex<Grants>,
    pub recents: Recents,
    pub settings: SettingsStore,
    pub recovery: Recovery,
    pub events: EventBus,
    pub quit: Mutex<QuitMachine>,
    /// Flipped the first time the window is shown, by `host_ready` or by the fallback timer.
    pub window_shown: AtomicBool,
    /// False when there is no tray icon (a Linux desktop without a status area): closing the window
    /// must then quit, because hiding it would leave nothing to bring it back.
    pub tray_ready: AtomicBool,
    /// Present only under `DRAFT_CANVAS_SMOKE`: fired once by `host_ready`.
    pub smoke_ready: Mutex<Option<Sender<()>>>,
    /// What the page drew for the tray menu (see `tray_decorate`).
    pub tray_art: Mutex<crate::tray::TrayArt>,
    /// Waiting to hear how the conversation before an update ended (see `quit::request_update`).
    pub update_gate: Mutex<Option<crate::quit::UpdateGate>>,
}

impl AppState {
    pub fn new(config_dir: &Path, local_data_dir: &Path) -> Self {
        Self {
            grants: Mutex::default(),
            recents: Recents::new(config_dir),
            settings: SettingsStore::new(config_dir),
            recovery: Recovery::new(local_data_dir),
            events: EventBus::default(),
            quit: Mutex::default(),
            window_shown: AtomicBool::new(false),
            tray_ready: AtomicBool::new(false),
            smoke_ready: Mutex::new(None),
            tray_art: Mutex::default(),
            update_gate: Mutex::new(None),
        }
    }

    pub fn grant_file(&self, path: &Path) -> Result<Handle, AppError> {
        let canonical = validate_file(path)?;
        Ok(lock(&self.grants).insert_file(canonical))
    }

    pub fn grant_project(&self, path: &Path) -> Result<Handle, AppError> {
        let canonical = validate_folder(path)?;
        Ok(lock(&self.grants).insert_project(canonical))
    }

    pub fn file(&self, handle: &str) -> Result<FileGrant, AppError> {
        lock(&self.grants).file(handle)
    }

    pub fn project(&self, handle: &str) -> Result<ProjectGrant, AppError> {
        lock(&self.grants).project(handle)
    }

    pub fn resolve_in_project(&self, project: &str, rel: &str) -> Result<PathBuf, AppError> {
        resolve_in_root(&self.project(project)?.root, rel)
    }

    /// The folder a pending canvas remembers as its destination, resolved fresh each time it's needed
    /// (the project may have been moved or the folder deleted since the canvas was created).
    pub fn resolve_folder_in_project(&self, project: &str, rel: &str) -> Result<PathBuf, AppError> {
        resolve_folder_in_root(&self.project(project)?.root, rel)
    }

    /// The events that tell the page to open `handles`: the first file, and a notice for any others.
    fn open_events(&self, handles: &[Handle]) -> Vec<HostEvent> {
        let mut events = Vec::new();
        let Some((first, rest)) = handles.split_first() else {
            return events;
        };
        if let Ok(grant) = self.file(first) {
            events.push(HostEvent::Open {
                handle: first.clone(),
                display_path: display_path(&grant.path),
                name: grant.name,
            });
            events.extend(
                extra_files_notice(rest.len()).map(|message| HostEvent::Notice { message }),
            );
        }
        events
    }

    /// A file the OS wants opened: sent now if the page is listening, queued until it is.
    pub fn deliver_opens(&self, handles: Vec<Handle>) {
        if let Some(handles) = self.events.open_or_queue(handles) {
            self.send_opens(&handles);
        }
    }

    /// Connects the page and gives it whatever arrived before it was ready.
    pub fn attach_page(&self, channel: Channel<HostEvent>) {
        let queued = self.events.attach(channel);
        self.send_opens(&queued);
    }

    fn send_opens(&self, handles: &[Handle]) {
        for event in self.open_events(handles) {
            self.events.emit(event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::sync::Arc;
    use tauri::ipc::InvokeResponseBody;
    use tempfile::{tempdir, TempDir};

    type Sent = Arc<Mutex<Vec<serde_json::Value>>>;

    fn listening() -> (Channel<HostEvent>, Sent) {
        let sent: Sent = Arc::default();
        let sink = sent.clone();
        let channel = Channel::<HostEvent>::new(move |body| {
            let InvokeResponseBody::Json(text) = body else {
                panic!("events are JSON");
            };
            lock(&sink).push(serde_json::from_str(&text).unwrap());
            Ok(())
        });
        (channel, sent)
    }

    fn state() -> (TempDir, AppState) {
        let dir = tempdir().unwrap();
        let state = AppState::new(&dir.path().join("config"), &dir.path().join("data"));
        (dir, state)
    }

    fn doc(dir: &TempDir, name: &str) -> PathBuf {
        let path = dir.path().join(name);
        fs::write(&path, "{}").unwrap();
        path
    }

    #[test]
    fn events_serialize_exactly_as_the_typescript_union_spells_them() {
        let cases = [
            (
                HostEvent::Open {
                    handle: "h_1".into(),
                    name: "flow".into(),
                    display_path: "~/flow.draftcanvas".into(),
                },
                json!({"type": "open", "handle": "h_1", "name": "flow", "displayPath": "~/flow.draftcanvas"}),
            ),
            (HostEvent::NewQuickDraft, json!({"type": "new-quick-draft"})),
            (HostEvent::NewCanvas, json!({"type": "new-canvas"})),
            (
                HostEvent::Menu {
                    command: MenuCommand::SaveAs,
                },
                json!({"type": "menu", "command": "save-as"}),
            ),
            (HostEvent::QuitRequested, json!({"type": "quit-requested"})),
            (HostEvent::WindowFocused, json!({"type": "window-focused"})),
            (
                HostEvent::RecentsChanged,
                json!({"type": "recents-changed"}),
            ),
            (
                HostEvent::Notice {
                    message: "hi".into(),
                },
                json!({"type": "notice", "message": "hi"}),
            ),
        ];
        for (event, want) in cases {
            assert_eq!(serde_json::to_value(&event).unwrap(), want);
        }
    }

    #[test]
    fn menu_commands_are_the_typescript_strings() {
        for (command, want) in [
            (MenuCommand::Save, "save"),
            (MenuCommand::SaveAs, "save-as"),
            (MenuCommand::Open, "open"),
            (MenuCommand::OpenProject, "open-project"),
            (MenuCommand::NewCanvas, "new-canvas"),
            (MenuCommand::Reveal, "reveal"),
            (MenuCommand::Revert, "revert"),
            (MenuCommand::Rename, "rename"),
            (MenuCommand::Settings, "settings"),
            (MenuCommand::About, "about"),
            (MenuCommand::Shortcuts, "shortcuts"),
            (MenuCommand::Undo, "undo"),
            (MenuCommand::Redo, "redo"),
            (MenuCommand::SelectAll, "select-all"),
        ] {
            assert_eq!(serde_json::to_value(command).unwrap(), json!(want));
        }
    }

    #[test]
    fn events_before_a_page_attaches_are_not_delivered() {
        let (_dir, state) = state();
        assert!(!state.events.is_attached());
        assert!(!state.events.emit(HostEvent::WindowFocused));
    }

    #[test]
    fn files_opened_before_the_page_is_ready_wait_and_arrive_on_attach() {
        let (dir, state) = state();
        let a = state.grant_file(&doc(&dir, "a.draftcanvas")).unwrap();
        let b = state.grant_file(&doc(&dir, "b.draftcanvas")).unwrap();
        state.deliver_opens(vec![a.clone()]);
        state.deliver_opens(vec![b]);

        let (channel, sent) = listening();
        state.attach_page(channel);

        let sent = lock(&sent).clone();
        assert_eq!(
            sent.len(),
            2,
            "the first file, then one notice for the second"
        );
        assert_eq!(sent[0]["type"], "open");
        assert_eq!(sent[0]["handle"], json!(a));
        assert_eq!(sent[0]["name"], "a");
        assert_eq!(sent[1]["type"], "notice");
        assert!(sent[1]["message"]
            .as_str()
            .unwrap()
            .contains("1 other file was left closed"));
    }

    #[test]
    fn once_listening_a_file_is_forwarded_immediately_and_the_queue_stays_empty() {
        let (dir, state) = state();
        let (channel, sent) = listening();
        state.attach_page(channel);
        assert!(lock(&sent).is_empty());

        let a = state.grant_file(&doc(&dir, "a.draftcanvas")).unwrap();
        state.deliver_opens(vec![a]);
        assert_eq!(lock(&sent).len(), 1);

        let (second, sent_second) = listening();
        state.attach_page(second);
        assert!(lock(&sent_second).is_empty(), "nothing was left waiting");
    }

    #[test]
    fn a_batch_opens_the_first_and_names_how_many_were_left() {
        let (dir, state) = state();
        let handles: Vec<Handle> = ["a", "b", "c"]
            .iter()
            .map(|n| {
                state
                    .grant_file(&doc(&dir, &format!("{n}.draftcanvas")))
                    .unwrap()
            })
            .collect();
        let (channel, sent) = listening();
        state.attach_page(channel);
        state.deliver_opens(handles);
        let sent = lock(&sent).clone();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0]["name"], "a");
        assert!(sent[1]["message"]
            .as_str()
            .unwrap()
            .contains("2 other files were left closed"));
    }

    #[test]
    fn the_notice_wording_is_singular_and_plural() {
        assert_eq!(extra_files_notice(0), None);
        assert!(extra_files_notice(1).unwrap().contains("1 other file was"));
        assert!(extra_files_notice(5)
            .unwrap()
            .contains("5 other files were"));
    }

    #[test]
    fn a_channel_that_fails_is_dropped_so_later_opens_queue() {
        let (dir, state) = state();
        state.attach_page(Channel::<HostEvent>::new(|_| {
            Err(tauri::Error::WebviewNotFound)
        }));
        assert!(state.events.is_attached());
        assert!(!state.events.emit(HostEvent::WindowFocused));
        assert!(!state.events.is_attached());

        let a = state.grant_file(&doc(&dir, "a.draftcanvas")).unwrap();
        state.deliver_opens(vec![a]);
        let (channel, sent) = listening();
        state.attach_page(channel);
        assert_eq!(lock(&sent).len(), 1);
    }

    #[test]
    fn granting_validates_and_reuses_handles() {
        let (dir, state) = state();
        let a = doc(&dir, "a.draftcanvas");
        let h1 = state.grant_file(&a).unwrap();
        assert_eq!(state.grant_file(&a).unwrap(), h1);
        assert!(state.grant_file(&doc(&dir, "notes.txt")).is_err());
        let project = state.grant_project(dir.path()).unwrap();
        assert_eq!(
            state.resolve_in_project(&project, "a.draftcanvas").unwrap(),
            state.file(&h1).unwrap().path
        );
        assert!(state
            .resolve_in_project(&project, "../a.draftcanvas")
            .is_err());
        assert!(state
            .resolve_in_project("h_unknown", "a.draftcanvas")
            .is_err());
    }
}
