//! The companion's agent process: the app's only long-running child. The prompt goes in on stdin,
//! stdout comes back a line at a time, and stderr is kept short for error messages.
//!
//! The agent starts children of its own (the `draft-canvas-mcp` sidecar, at least), so it runs in a
//! process group of its own on Unix and is stopped with its whole tree on Windows: stopping the agent
//! must not leave a sidecar behind.

use crate::util::{lock, now_ms};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// Stderr kept for an error message: the end of it, which is where an agent explains itself.
const STDERR_KEEP: usize = 64 * 1024;

#[derive(Debug, Clone, Copy)]
pub struct RunLimits {
    /// One stdout line at most. A tool result can carry an image (`render_diagram` allows 8 MiB before
    /// base64), so this is generous; past it the output is not something the companion understands.
    pub max_line: usize,
    /// Bytes read from both output streams over the whole turn, including unrecognised output.
    pub max_output: u64,
    /// No output on either stream for this long, and the agent is taken to have hung.
    pub idle: Duration,
    /// How long the agent gets to stop after being asked, before it is killed.
    pub grace: Duration,
}

impl Default for RunLimits {
    fn default() -> Self {
        Self {
            max_line: 32 * 1024 * 1024,
            max_output: 128 * 1024 * 1024,
            idle: Duration::from_secs(5 * 60),
            grace: Duration::from_secs(3),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cause {
    /// It exited by itself.
    Exited,
    Cancelled,
    Idle,
    LineTooLong,
    TooMuchOutput,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exit {
    pub cause: Cause,
    pub code: Option<i32>,
    pub stderr: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Output {
    Line(String),
    /// Always last, after every line.
    Exit(Exit),
}

pub type Sink = Arc<dyn Fn(Output) + Send + Sync>;

struct Shared {
    #[cfg(unix)]
    pid: u32,
    #[cfg(windows)]
    tree: crate::process_tree::ProcessTree,
    cause: Mutex<Option<Cause>>,
    done: Mutex<bool>,
    finished: Condvar,
    last_output: AtomicU64,
    output_bytes: AtomicU64,
    max_output: u64,
    grace: Duration,
}

/// Stops a run, or waits for it to end.
#[derive(Clone)]
pub struct RunControl {
    shared: Arc<Shared>,
}

impl RunControl {
    /// Asks the agent and everything it started to stop; kills them if they haven't after the grace
    /// period. Returns at once.
    pub fn stop(&self) {
        self.end(Cause::Cancelled);
    }

    /// Let a CLI flush its transcript after its terminal result, then stop a process that lingers.
    /// Waiting here runs on its own thread: stdout delivery must continue so a natural exit completes.
    pub fn stop_after(&self, grace: Duration) {
        let control = self.clone();
        std::thread::spawn(move || {
            if !control.wait(grace) {
                control.stop();
            }
        });
    }

    /// Whether the process is gone and its last output delivered, waiting up to `timeout`.
    pub fn wait(&self, timeout: Duration) -> bool {
        let done = lock(&self.shared.done);
        let (done, _) = self
            .shared
            .finished
            .wait_timeout_while(done, timeout, |done| !*done)
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *done
    }

    fn output(&self, bytes: usize) -> bool {
        let before = self
            .shared
            .output_bytes
            .fetch_add(bytes as u64, Ordering::Relaxed);
        if before.saturating_add(bytes as u64) > self.shared.max_output {
            self.end(Cause::TooMuchOutput);
            return false;
        }
        true
    }

    fn end(&self, cause: Cause) {
        {
            let mut current = lock(&self.shared.cause);
            if current.is_some() || *lock(&self.shared.done) {
                return;
            }
            *current = Some(cause);
        }
        let shared = self.shared.clone();
        std::thread::spawn(move || {
            terminate(&shared, false);
            let control = RunControl { shared };
            if !control.wait(control.shared.grace) {
                terminate(&control.shared, true);
            }
        });
    }
}

/// Starts `command` with `stdin` as its whole input, and calls `sink` with every stdout line and then
/// the exit, from threads of its own.
pub fn spawn(
    mut command: Command,
    stdin: String,
    limits: RunLimits,
    sink: Sink,
) -> std::io::Result<RunControl> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    let (mut child, tree) = crate::process_tree::spawn(&mut command)?;
    #[cfg(not(windows))]
    let mut child = command.spawn()?;
    let shared = Arc::new(Shared {
        #[cfg(unix)]
        pid: child.id(),
        #[cfg(windows)]
        tree,
        cause: Mutex::new(None),
        done: Mutex::new(false),
        finished: Condvar::new(),
        last_output: AtomicU64::new(now_ms()),
        output_bytes: AtomicU64::new(0),
        max_output: limits.max_output,
        grace: limits.grace,
    });
    let control = RunControl {
        shared: shared.clone(),
    };

    let mut input = child.stdin.take().expect("piped");
    std::thread::spawn(move || {
        // An agent that exits without reading closes the pipe; that is its answer, not an error here.
        let _ = input.write_all(stdin.as_bytes());
    });

    let stderr_tail = Arc::new(Mutex::new(VecDeque::<u8>::new()));
    let stderr = {
        let mut pipe = child.stderr.take().expect("piped");
        let tail = stderr_tail.clone();
        let shared = shared.clone();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            while let Ok(n) = pipe.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                shared.last_output.store(now_ms(), Ordering::Relaxed);
                let control = RunControl {
                    shared: shared.clone(),
                };
                if !control.output(n) {
                    // Drain until termination, retaining no more of the runaway stream.
                    let _ = std::io::copy(&mut pipe, &mut std::io::sink());
                    break;
                }
                let mut tail = lock(&tail);
                tail.extend(&chunk[..n]);
                let excess = tail.len().saturating_sub(STDERR_KEEP);
                tail.drain(..excess);
            }
        })
    };

    let stdout = {
        let pipe = child.stdout.take().expect("piped");
        let sink = sink.clone();
        let control = control.clone();
        std::thread::spawn(move || read_lines(pipe, limits.max_line, &control, &sink))
    };

    let supervisor = control.clone();
    std::thread::spawn(move || {
        let control = supervisor;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {}
                Err(_) => break None,
            }
            let quiet = now_ms().saturating_sub(shared.last_output.load(Ordering::Relaxed));
            if quiet > limits.idle.as_millis() as u64 {
                control.end(Cause::Idle);
            }
            std::thread::sleep(Duration::from_millis(40));
        };
        // A descendant may still hold the pipes after its parent exited. End the owned group/job
        // before joining the readers, rather than waiting forever for that descendant's pipe EOF.
        terminate(&shared, true);
        let _ = stdout.join();
        let _ = stderr.join();
        let stderr = String::from_utf8_lossy(lock(&stderr_tail).make_contiguous()).into_owned();
        let cause = lock(&shared.cause).unwrap_or(Cause::Exited);
        sink(Output::Exit(Exit {
            cause,
            code: status.and_then(|s| s.code()),
            stderr,
        }));
        *lock(&shared.done) = true;
        shared.finished.notify_all();
    });

    Ok(control)
}

/// Hands each complete line to `sink`, without ever holding more than `max_line` bytes of one.
fn read_lines(pipe: impl Read, max_line: usize, control: &RunControl, sink: &Sink) {
    let mut reader = BufReader::new(pipe);
    let mut line = Vec::new();
    loop {
        let buffer = match reader.fill_buf() {
            Ok([]) | Err(_) => break,
            Ok(buffer) => buffer,
        };
        control
            .shared
            .last_output
            .store(now_ms(), Ordering::Relaxed);
        let (take, complete) = match buffer.iter().position(|b| *b == b'\n') {
            Some(at) => (at + 1, true),
            None => (buffer.len(), false),
        };
        if !control.output(take) {
            let _ = std::io::copy(&mut reader, &mut std::io::sink());
            return;
        }
        if line.len() + take - usize::from(complete) > max_line {
            control.end(Cause::LineTooLong);
            // Keep draining so the agent isn't blocked on a full pipe while it is stopped.
            let _ = std::io::copy(&mut reader, &mut std::io::sink());
            return;
        }
        line.extend_from_slice(&buffer[..take]);
        reader.consume(take);
        if complete {
            sink(Output::Line(text_of(&line)));
            line.clear();
        }
    }
    if !line.is_empty() {
        sink(Output::Line(text_of(&line)));
    }
}

fn text_of(line: &[u8]) -> String {
    String::from_utf8_lossy(line)
        .trim_end_matches(['\n', '\r'])
        .to_string()
}

/// Asks the process group to stop, or (`force`) kills it. Harmless once it is gone.
#[cfg(unix)]
fn terminate(shared: &Shared, force: bool) {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    const SIGTERM: i32 = 15;
    const SIGKILL: i32 = 9;
    let Ok(group) = i32::try_from(shared.pid) else {
        return;
    };
    // SAFETY: kill(2) takes plain integers and has no memory effects; a negative pid names the
    // group the agent leads (`process_group(0)` above), and a group already gone is ESRCH.
    unsafe {
        kill(-group, if force { SIGKILL } else { SIGTERM });
    }
}

/// Windows ends the owned job at once; its membership survives the root process exiting.
#[cfg(windows)]
fn terminate(shared: &Shared, _force: bool) {
    if let Err(error) = shared.tree.terminate() {
        eprintln!("Draft Canvas: the companion process tree could not be stopped ({error})");
    }
}

/// Waits for every run to finish, `timeout` for all of them together.
pub fn wait_all(controls: &[RunControl], timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    controls
        .iter()
        .all(|control| control.wait(deadline.saturating_duration_since(Instant::now())))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::mpsc;

    /// A shell command: `sh -c` on Unix, `cmd /C` on Windows. Windows gets its line as it is: the
    /// standard library's quoting escapes inner quotes with backslashes, which cmd doesn't read, so
    /// `type "C:\…\turn.jsonl"` failed to start and the run stopped before saying anything.
    #[cfg(windows)]
    pub(crate) fn shell(_unix: &str, windows: &str) -> Command {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new("cmd");
        command.arg("/C").raw_arg(windows);
        command
    }

    /// A shell command: `sh -c` on Unix, `cmd /C` on Windows.
    #[cfg(not(windows))]
    pub(crate) fn shell(unix: &str, _windows: &str) -> Command {
        let mut command = Command::new("sh");
        command.args(["-c", unix]);
        command
    }

    fn start(
        command: Command,
        stdin: &str,
        limits: RunLimits,
    ) -> (RunControl, mpsc::Receiver<Output>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let control = spawn(
            command,
            stdin.to_string(),
            limits,
            Arc::new(move |out| {
                let _ = lock(&tx).send(out);
            }),
        )
        .unwrap();
        (control, rx)
    }

    fn collect(rx: &mpsc::Receiver<Output>) -> (Vec<String>, Exit) {
        let mut lines = Vec::new();
        loop {
            match rx
                .recv_timeout(Duration::from_secs(20))
                .expect("the run ended")
            {
                Output::Line(line) => lines.push(line),
                Output::Exit(exit) => return (lines, exit),
            }
        }
    }

    #[test]
    fn lines_come_back_in_order_then_the_exit_with_the_stderr_tail() {
        let (control, rx) = start(
            shell(
                "printf 'one\\ntwo\\n'; echo oops >&2; exit 3",
                "(echo one& echo two& echo oops 1>&2& exit /b 3)",
            ),
            "",
            RunLimits::default(),
        );
        let (lines, exit) = collect(&rx);
        assert_eq!(lines, vec!["one", "two"]);
        assert_eq!(exit.cause, Cause::Exited);
        assert_eq!(exit.code, Some(3));
        assert!(exit.stderr.contains("oops"), "{}", exit.stderr);
        assert!(control.wait(Duration::from_secs(5)));
    }

    #[test]
    fn the_prompt_arrives_on_stdin() {
        let (_, rx) = start(shell("cat", "more"), "hello\nworld\n", RunLimits::default());
        let (lines, _) = collect(&rx);
        // `more` may add a blank line of its own.
        let lines: Vec<_> = lines.into_iter().filter(|l| !l.is_empty()).collect();
        assert_eq!(lines, vec!["hello", "world"]);
    }

    #[test]
    fn stop_ends_a_running_agent_as_cancelled() {
        let (control, rx) = start(
            shell(
                "echo started; sleep 30",
                "echo started& ping -n 30 127.0.0.1 >nul",
            ),
            "",
            RunLimits::default(),
        );
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(10)).unwrap(),
            Output::Line("started".into())
        );
        let started = Instant::now();
        control.stop();
        let (_, exit) = collect(&rx);
        assert_eq!(exit.cause, Cause::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn an_agent_that_goes_quiet_is_stopped() {
        let (_, rx) = start(
            shell("sleep 30", "ping -n 30 127.0.0.1 >nul"),
            "",
            RunLimits {
                idle: Duration::from_millis(300),
                ..RunLimits::default()
            },
        );
        let (_, exit) = collect(&rx);
        assert_eq!(exit.cause, Cause::Idle);
    }

    #[test]
    fn a_line_past_the_limit_ends_the_run_without_being_delivered() {
        let (_, rx) = start(
            shell(
                "echo short; echo 0123456789012345678901234567890123456789; sleep 30",
                "echo short& echo 0123456789012345678901234567890123456789& ping -n 30 127.0.0.1 >nul",
            ),
            "",
            RunLimits {
                max_line: 16,
                ..RunLimits::default()
            },
        );
        let (lines, exit) = collect(&rx);
        assert_eq!(lines, vec!["short"]);
        assert_eq!(exit.cause, Cause::LineTooLong);
    }

    #[test]
    fn an_unterminated_line_has_the_same_limit_as_a_complete_line() {
        let (_, rx) = start(
            shell("printf '123456789'", "<nul set /p =123456789"),
            "",
            RunLimits {
                max_line: 8,
                ..RunLimits::default()
            },
        );
        let (lines, exit) = collect(&rx);
        assert!(lines.is_empty());
        assert_eq!(exit.cause, Cause::LineTooLong);
    }

    #[test]
    fn the_total_output_budget_includes_stderr_and_small_lines() {
        let (_, rx) = start(
            shell("echo 1234567890; echo 123456789012345678901234567890 >&2; sleep 30", "echo 1234567890& echo 123456789012345678901234567890 1>&2& ping -n 30 127.0.0.1 >nul"),
            "",
            RunLimits { max_output: 25, ..RunLimits::default() },
        );
        let (_, exit) = collect(&rx);
        assert_eq!(exit.cause, Cause::TooMuchOutput);
    }

    #[cfg(windows)]
    #[test]
    fn repeated_early_output_cancellation_cannot_let_a_new_child_escape() {
        // Stop as soon as cmd says anything, while it is about to create PING. A taskkill tree walk
        // could miss that new child, kill cmd, then leave its pipe held open for the full 30 seconds.
        for _ in 0..16 {
            let (control, rx) = start(
                shell("", "echo ready& ping -n 30 127.0.0.1 >nul"),
                "",
                RunLimits::default(),
            );
            assert_eq!(
                rx.recv_timeout(Duration::from_secs(10)).unwrap(),
                Output::Line("ready".into())
            );
            let started = Instant::now();
            control.stop();
            let (_, exit) = collect(&rx);
            assert_eq!(exit.cause, Cause::Cancelled);
            assert!(control.wait(Duration::from_secs(5)));
            assert!(started.elapsed() < Duration::from_secs(10));
        }
    }

    #[cfg(windows)]
    #[test]
    fn an_exited_parent_cannot_leave_a_child_holding_the_output_pipes() {
        let started = Instant::now();
        let (control, rx) = start(
            shell("", r#"start "" /b ping -n 30 127.0.0.1 & exit /b 0"#),
            "",
            RunLimits::default(),
        );
        let (_, exit) = collect(&rx);
        assert_eq!(exit.cause, Cause::Exited);
        assert_eq!(exit.code, Some(0));
        assert!(control.wait(Duration::from_secs(5)));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[cfg(unix)]
    #[test]
    fn stopping_also_stops_what_the_agent_started() {
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        let (control, rx) = start(
            shell("sleep 30 & echo $!; wait", ""),
            "",
            RunLimits::default(),
        );
        let Output::Line(grandchild) = rx.recv_timeout(Duration::from_secs(10)).unwrap() else {
            panic!("expected the grandchild's pid");
        };
        let grandchild: i32 = grandchild.trim().parse().unwrap();
        control.stop();
        collect(&rx);
        let deadline = Instant::now() + Duration::from_secs(5);
        // SAFETY: signal 0 only asks whether the process exists.
        while unsafe { kill(grandchild, 0) } == 0 {
            assert!(Instant::now() < deadline, "the grandchild outlived the run");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
