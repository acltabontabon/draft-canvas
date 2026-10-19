//! Quitting is a conversation with the page: the page may have unsaved work to save or ask about, so
//! Rust asks first (`QuitRequested`), waits for an answer, and only then exits. Installing an update
//! has the same conversation (`UpdateRequested`), and where a quit would exit, it hands over to the
//! installer instead. The state machine is pure; the functions below it carry out its decisions.

use crate::state::{AppState, HostEvent};
use crate::util::lock;
use serde::Deserialize;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Told whether the page is done (`true`) or the person chose to keep working (`false`).
pub type UpdateGate = tokio::sync::oneshot::Sender<bool>;

/// What the conversation is for: the app is going away either way, but an update relaunches it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    Quit,
    Update,
}

/// A page that never answers (hung, or its window is hidden and suspended) must not keep the app alive.
const ACK_TIMEOUT: Duration = Duration::from_millis(1_500);

/// What a page that said it is working on it (settling a field, writing its recovery copy), or that
/// holds unsaved work, gets on top of `ACK_TIMEOUT` before it is given up on. The first answer waits on
/// a flush and several fsyncs, which can run past the first timeout; quitting then lost the Save prompt.
const WORKING_GRACE: Duration = Duration::from_millis(10_000);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuitDecision {
    /// Nothing left to save: go ahead.
    Ready,
    /// The page has the request and is settling its work first; it will answer again. Said at once, so
    /// a slow flush isn't taken for a hung page.
    Working,
    /// The page is showing a question to the person; wait as long as that takes.
    Prompting,
    /// The person chose to keep working.
    Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Idle,
    /// Asked; the number is which ask, so a stale timer can't quit a later, cancelled attempt.
    Waiting(u64),
    Prompting,
    Quitting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Tell the page (and start the timer for this ask).
    Ask(u64),
    /// The ask is still open and worth waiting for: give it `WORKING_GRACE` more.
    Extend(u64),
    /// Go: exit, or for an update, install.
    Exit,
    /// The person chose to keep working.
    Cancelled,
    Nothing,
}

#[derive(Debug)]
pub struct QuitMachine {
    phase: Phase,
    asks: u64,
    purpose: Purpose,
    /// The page has said it is working on the current ask.
    working: bool,
    /// The current ask has already had its extra time.
    extended: bool,
}

impl Default for QuitMachine {
    fn default() -> Self {
        Self {
            phase: Phase::Idle,
            asks: 0,
            purpose: Purpose::Quit,
            working: false,
            extended: false,
        }
    }
}

impl QuitMachine {
    /// Once true the app really is going away, so `ExitRequested` must be let through.
    pub fn is_quitting(&self) -> bool {
        self.phase == Phase::Quitting
    }

    pub fn purpose(&self) -> Purpose {
        self.purpose
    }

    /// Quit (menu, tray, close behaviour) or an update was chosen. With nobody to ask, go at once.
    pub fn request(&mut self, page_listening: bool, purpose: Purpose) -> Step {
        match self.phase {
            Phase::Quitting | Phase::Waiting(_) | Phase::Prompting => Step::Nothing,
            Phase::Idle => {
                self.purpose = purpose;
                if !page_listening {
                    return self.exit();
                }
                self.asks += 1;
                self.working = false;
                self.extended = false;
                self.phase = Phase::Waiting(self.asks);
                Step::Ask(self.asks)
            }
        }
    }

    pub fn ack(&mut self, decision: QuitDecision) -> Step {
        match (self.phase, decision) {
            (Phase::Waiting(_) | Phase::Prompting, QuitDecision::Ready) => self.exit(),
            (Phase::Waiting(_), QuitDecision::Working) => {
                self.working = true;
                Step::Nothing
            }
            (Phase::Waiting(_), QuitDecision::Prompting) => {
                self.phase = Phase::Prompting;
                Step::Nothing
            }
            (Phase::Waiting(_) | Phase::Prompting, QuitDecision::Cancel) => {
                self.phase = Phase::Idle;
                Step::Cancelled
            }
            _ => Step::Nothing,
        }
    }

    /// An update that was going to replace the app couldn't: it carries on, and a later quit asks again.
    pub fn resume(&mut self) {
        self.phase = Phase::Idle;
        self.purpose = Purpose::Quit;
    }

    /// The ask's timer ran out. A page that is working on it, or whose open file has unsaved changes
    /// (a window hidden in the tray may be suspended and not have run yet), gets one more allowance
    /// before it is given up on; a hung page must still not keep the app alive.
    pub fn timed_out(&mut self, ask: u64, unsaved: bool) -> Step {
        match self.phase {
            Phase::Waiting(current) if current == ask => {
                if !self.extended && (self.working || unsaved) {
                    self.extended = true;
                    Step::Extend(ask)
                } else {
                    self.exit()
                }
            }
            _ => Step::Nothing,
        }
    }

    /// The page saved (or chose to discard) and says to go, whether or not it was asked.
    pub fn quit_now(&mut self) -> Step {
        self.exit()
    }

    fn exit(&mut self) -> Step {
        self.phase = Phase::Quitting;
        Step::Exit
    }
}

pub fn request_quit(app: &AppHandle) {
    let state = app.state::<AppState>();
    let step = lock(&state.quit).request(state.events.is_attached(), Purpose::Quit);
    apply(app, step);
}

/// Starts the conversation for an update; `gate` hears how it ended. False when a quit or another
/// update is already under way, which has its own conversation.
pub fn request_update(app: &AppHandle, gate: UpdateGate) -> bool {
    let state = app.state::<AppState>();
    let step = {
        let mut quit = lock(&state.quit);
        let step = quit.request(state.events.is_attached(), Purpose::Update);
        if step != Step::Nothing {
            *lock(&state.update_gate) = Some(gate);
        }
        step
    };
    if step == Step::Nothing {
        return false;
    }
    apply(app, step);
    true
}

/// The update couldn't be installed after all: the app carries on.
pub fn resume(app: &AppHandle) {
    lock(&app.state::<AppState>().quit).resume();
}

pub fn acknowledge(app: &AppHandle, decision: QuitDecision) {
    let step = lock(&app.state::<AppState>().quit).ack(decision);
    apply(app, step);
}

pub fn quit_now(app: &AppHandle) {
    let step = lock(&app.state::<AppState>().quit).quit_now();
    apply(app, step);
}

/// Whether the open file has changes the page has not saved, as the page last reported it.
fn unsaved_work(app: &AppHandle) -> bool {
    app.state::<std::sync::Arc<crate::agent::Agent>>()
        .active()
        .is_some_and(|doc| doc.dirty)
}

fn wait_for(app: &AppHandle, ask: u64, wait: Duration) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(wait);
        let unsaved = unsaved_work(&app);
        let step = lock(&app.state::<AppState>().quit).timed_out(ask, unsaved);
        apply(&app, step);
    });
}

fn apply(app: &AppHandle, step: Step) {
    let state = app.state::<AppState>();
    let purpose = lock(&state.quit).purpose();
    match step {
        Step::Nothing => {}
        Step::Exit if purpose == Purpose::Update => {
            if let Some(gate) = lock(&state.update_gate).take() {
                let _ = gate.send(true);
            }
        }
        Step::Exit => app.exit(0),
        Step::Cancelled => {
            if let Some(gate) = lock(&state.update_gate).take() {
                let _ = gate.send(false);
            }
        }
        Step::Ask(ask) => {
            let event = match purpose {
                Purpose::Quit => HostEvent::QuitRequested,
                Purpose::Update => HostEvent::UpdateRequested,
            };
            if !state.events.emit(event) {
                // The page can't hear us (it's gone), so there is nobody to wait for.
                let step = lock(&state.quit).quit_now();
                apply(app, step);
                return;
            }
            wait_for(app, ask, ACK_TIMEOUT);
        }
        Step::Extend(ask) => {
            // A suspended window only runs again once it is shown; with unsaved work it should be.
            if unsaved_work(app) {
                crate::window::show_main(app);
            }
            wait_for(app, ask, WORKING_GRACE);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_page_means_exit_at_once() {
        let mut m = QuitMachine::default();
        assert_eq!(m.request(false, Purpose::Quit), Step::Exit);
        assert!(m.is_quitting());
    }

    #[test]
    fn a_ready_page_lets_the_quit_through() {
        let mut m = QuitMachine::default();
        assert_eq!(m.request(true, Purpose::Quit), Step::Ask(1));
        assert!(!m.is_quitting());
        assert_eq!(m.ack(QuitDecision::Ready), Step::Exit);
        assert!(m.is_quitting());
    }

    #[test]
    fn a_page_that_never_answers_is_quit_when_the_timer_fires() {
        let mut m = QuitMachine::default();
        assert_eq!(m.request(true, Purpose::Quit), Step::Ask(1));
        assert_eq!(m.timed_out(1, false), Step::Exit);
        assert!(m.is_quitting());
    }

    #[test]
    fn a_page_that_is_working_gets_one_more_allowance_and_then_no_more() {
        let mut m = QuitMachine::default();
        assert_eq!(m.request(true, Purpose::Quit), Step::Ask(1));
        assert_eq!(m.ack(QuitDecision::Working), Step::Nothing);
        assert_eq!(m.timed_out(1, false), Step::Extend(1));
        // Still working after the extra time: a hung page doesn't keep the app alive.
        assert_eq!(m.timed_out(1, false), Step::Exit);
    }

    #[test]
    fn unsaved_work_in_a_window_that_has_not_answered_also_earns_the_allowance() {
        let mut m = QuitMachine::default();
        m.request(true, Purpose::Quit);
        assert_eq!(m.timed_out(1, true), Step::Extend(1));
        // Answering during it still works, and so does the Save prompt.
        assert_eq!(m.ack(QuitDecision::Prompting), Step::Nothing);
        assert_eq!(m.timed_out(1, true), Step::Nothing);
        assert!(!m.is_quitting());
    }

    #[test]
    fn a_new_ask_starts_with_a_fresh_allowance() {
        let mut m = QuitMachine::default();
        m.request(true, Purpose::Quit);
        m.ack(QuitDecision::Working);
        assert_eq!(m.timed_out(1, false), Step::Extend(1));
        m.ack(QuitDecision::Cancel);
        assert_eq!(m.request(true, Purpose::Quit), Step::Ask(2));
        assert_eq!(
            m.timed_out(2, false),
            Step::Exit,
            "not working yet, nothing unsaved"
        );
    }

    #[test]
    fn prompting_waits_with_no_timeout_until_a_decision() {
        let mut m = QuitMachine::default();
        m.request(true, Purpose::Quit);
        assert_eq!(m.ack(QuitDecision::Prompting), Step::Nothing);
        assert_eq!(m.timed_out(1, false), Step::Nothing);
        assert!(!m.is_quitting());
        assert_eq!(m.ack(QuitDecision::Ready), Step::Exit);
    }

    #[test]
    fn cancelling_clears_the_request_and_a_stale_timer_cannot_quit_the_next_one() {
        let mut m = QuitMachine::default();
        assert_eq!(m.request(true, Purpose::Quit), Step::Ask(1));
        assert_eq!(m.ack(QuitDecision::Cancel), Step::Cancelled);
        assert_eq!(m.request(true, Purpose::Quit), Step::Ask(2));
        assert_eq!(m.timed_out(1, false), Step::Nothing);
        assert!(!m.is_quitting());
        assert_eq!(m.timed_out(2, false), Step::Exit);
    }

    #[test]
    fn cancelling_after_a_prompt_goes_back_to_idle() {
        let mut m = QuitMachine::default();
        m.request(true, Purpose::Quit);
        m.ack(QuitDecision::Prompting);
        assert_eq!(m.ack(QuitDecision::Cancel), Step::Cancelled);
        assert_eq!(m.request(true, Purpose::Quit), Step::Ask(2));
    }

    #[test]
    fn an_update_has_the_same_conversation_and_remembers_what_it_is_for() {
        let mut m = QuitMachine::default();
        assert_eq!(m.request(true, Purpose::Update), Step::Ask(1));
        assert_eq!(m.purpose(), Purpose::Update);
        // A quit chosen meanwhile doesn't start a second conversation.
        assert_eq!(m.request(true, Purpose::Quit), Step::Nothing);
        assert_eq!(m.purpose(), Purpose::Update);
        assert_eq!(m.ack(QuitDecision::Ready), Step::Exit);
        assert!(m.is_quitting());
    }

    #[test]
    fn a_failed_update_hands_the_app_back() {
        let mut m = QuitMachine::default();
        m.request(false, Purpose::Update);
        assert!(m.is_quitting());
        m.resume();
        assert!(!m.is_quitting());
        assert_eq!(m.request(true, Purpose::Quit), Step::Ask(1));
        assert_eq!(m.purpose(), Purpose::Quit);
    }

    #[test]
    fn a_second_request_while_one_is_open_does_nothing() {
        let mut m = QuitMachine::default();
        assert_eq!(m.request(true, Purpose::Quit), Step::Ask(1));
        assert_eq!(m.request(true, Purpose::Quit), Step::Nothing);
        m.ack(QuitDecision::Prompting);
        assert_eq!(m.request(true, Purpose::Quit), Step::Nothing);
    }

    #[test]
    fn unsolicited_answers_are_ignored_but_quit_now_always_exits() {
        let mut m = QuitMachine::default();
        assert_eq!(m.ack(QuitDecision::Ready), Step::Nothing);
        assert_eq!(m.ack(QuitDecision::Prompting), Step::Nothing);
        assert_eq!(m.ack(QuitDecision::Cancel), Step::Nothing);
        assert_eq!(m.timed_out(1, false), Step::Nothing);
        assert!(!m.is_quitting());
        assert_eq!(m.quit_now(), Step::Exit);
        assert!(m.is_quitting());
        assert_eq!(m.request(true, Purpose::Quit), Step::Nothing);
        assert_eq!(
            m.ack(QuitDecision::Cancel),
            Step::Nothing,
            "a cancel that arrives too late changes nothing"
        );
        assert!(m.is_quitting());
    }

    #[test]
    fn decisions_deserialize_from_the_typescript_strings() {
        for (text, want) in [
            ("ready", QuitDecision::Ready),
            ("prompting", QuitDecision::Prompting),
            ("cancel", QuitDecision::Cancel),
            ("working", QuitDecision::Working),
        ] {
            let got: QuitDecision = serde_json::from_value(serde_json::json!(text)).unwrap();
            assert_eq!(got, want);
        }
        assert!(serde_json::from_value::<QuitDecision>(serde_json::json!("now")).is_err());
    }
}
