//! An owned Windows process tree. Assign the initial process to a kill-on-close job before any
//! user code runs: assigning a normally spawned process leaves a race in which children escape.
//! `taskkill /T` has the same race and cannot find descendants after their parent has exited.

use std::io;
use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::process::{Child, Command};
use std::ptr;
use windows_sys::Win32::Foundation::{GetLastError, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    GetProcessIdOfThread, OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED,
    THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
};

pub(crate) struct ProcessTree {
    job: OwnedHandle,
}

impl ProcessTree {
    fn new() -> io::Result<Self> {
        // SAFETY: null security attributes and name request an unnamed, non-inheritable job.
        let raw = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: CreateJobObjectW returned a new, valid handle; this is its sole Rust owner.
        let job = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        // Do not allow either breakaway flag: every ordinary descendant remains in our job.
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the live job handle and correctly sized information structure remain valid for
        // the call; Windows copies this structure rather than retaining its pointer.
        if unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { job })
    }

    /// Terminates all associated processes, even if the original process has already exited.
    pub(crate) fn terminate(&self) -> io::Result<()> {
        // SAFETY: the owned job handle is valid for this call and cannot be closed concurrently.
        if unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn assign_and_resume(&self, child: &Child) -> io::Result<()> {
        // SAFETY: both handles remain owned throughout the call. The process's initial thread is
        // suspended, so it cannot run agent code or create children before assignment succeeds.
        if unsafe { AssignProcessToJobObject(self.job.as_raw_handle(), child.as_raw_handle()) } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let thread = initial_thread(child.id())?;
        // SAFETY: OpenThread supplied query/suspend access to a live owned handle. Recheck its owner
        // before resuming so a thread disappearing between snapshot and OpenThread fails closed.
        if unsafe { GetProcessIdOfThread(thread.as_raw_handle()) } != child.id() {
            return Err(io::Error::other("the initial process thread changed"));
        }
        // SAFETY: this is the initial thread of our CREATE_SUSPENDED child, now inside the job.
        let previous = unsafe { ResumeThread(thread.as_raw_handle()) };
        if previous == u32::MAX {
            return Err(io::Error::last_os_error());
        }
        if previous != 1 {
            return Err(io::Error::other(
                "the initial process thread was not suspended once",
            ));
        }
        Ok(())
    }
}

/// Keep std's platform quoting, environment and pipe setup, but never release an unowned child.
pub(crate) fn spawn(command: &mut Command) -> io::Result<(Child, ProcessTree)> {
    let tree = ProcessTree::new()?;
    command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    let mut child = command.spawn()?;
    if let Err(error) = tree.assign_and_resume(&child) {
        // No taskkill fallback: a setup failure must not run an agent without containment.
        let _ = tree.terminate();
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok((child, tree))
}

fn initial_thread(pid: u32) -> io::Result<OwnedHandle> {
    // std's initial-thread handle and process-attribute APIs are nightly-only (MSRV 1.88). The
    // suspended child has not run its loader or agent code, so exactly one initial thread is expected.
    // SAFETY: TH32CS_SNAPTHREAD requests a snapshot with no borrowed pointers.
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the successful snapshot handle is newly owned and is closed on every return path.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut found = None;
    // SAFETY: the live snapshot and writable, initialized entry stay valid throughout enumeration.
    let mut more = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
    while more != 0 {
        if entry.th32OwnerProcessID == pid && found.replace(entry.th32ThreadID).is_some() {
            return Err(io::Error::other(
                "the suspended process has more than one initial thread",
            ));
        }
        // SAFETY: as for Thread32First; each entry is consumed before Windows overwrites it.
        more = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
    }
    // SAFETY: read the thread enumeration's last error before another Win32 call changes it.
    let error = unsafe { GetLastError() };
    if error != ERROR_NO_MORE_FILES {
        return Err(io::Error::from_raw_os_error(error as i32));
    }
    let thread =
        found.ok_or_else(|| io::Error::other("the suspended initial thread was not found"))?;
    // SAFETY: request only the rights used by GetProcessIdOfThread/ResumeThread; handle inheritance
    // is off. A vanished thread produces null and is never resumed.
    let raw = unsafe {
        OpenThread(
            THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
            0,
            thread,
        )
    };
    if raw.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: OpenThread returned a newly owned valid handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[test]
    fn closing_the_last_job_handle_kills_the_live_parent_and_its_pipe_holding_child() {
        let mut command = Command::new("cmd");
        command.arg("/C").raw_arg("ping -n 30 127.0.0.1");
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let (mut child, tree) = spawn(&mut command).unwrap();
        let pipe = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(pipe);
            let mut line = String::new();
            // PING's own first output proves the child exists before the job handle is closed.
            let count = reader.read_line(&mut line).unwrap();
            let _ = tx.send(count > 0);
            let _ = io::copy(&mut reader, &mut io::sink());
            let _ = tx.send(false);
        });
        assert!(rx.recv_timeout(Duration::from_secs(10)).unwrap());
        drop(tree);
        let deadline = Instant::now() + Duration::from_secs(5);
        while child.try_wait().unwrap().is_none() {
            assert!(
                Instant::now() < deadline,
                "closing the job left its parent alive"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            "the child still held its output pipe"
        );
    }
}
