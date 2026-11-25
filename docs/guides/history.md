# Diagram history

Draft Canvas keeps a history of each diagram as you work, so you can see how your architecture
evolved. There is nothing to set up and nothing to remember to do: no saving versions, no commit
messages, no Git.

## Saving, history and publishing

Three things are kept apart, and the status bar never mixes them up:

| | What it means | Where you see it |
| --- | --- | --- |
| **Saved** | What is on screen is safe on this device | The save label: **Saved locally** (web), **Saved** (desktop) |
| **In history** | A revision of the diagram is recorded | The clock beside the save label |
| **Published** | Revisions are on a Git remote you connected (desktop only) | The history details |

Your diagram is saved within a second of each change. A revision is added to its history once
you pause for 30 seconds, or every 2 minutes while you keep drawing. While you are dragging or
typing, history waits for you to finish. Moving around the canvas never adds a revision, and
neither does a change you undo before it was recorded.

Click the clock to see when history last recorded a change, add one now, or open
**History settings**. A small dot on the clock means recent changes are about to be recorded.

## When a diagram looks like a copy

If you open a copy of a diagram whose history is on this device (a duplicated file, or one moved
outside Draft Canvas), the clock asks **Continue history?**:

- **Continue its history** carries on the existing history.
- **Start new history** keeps this copy's history separate.

Draft Canvas never decides this for you, and records nothing until you answer.

## Settings

Open **History settings** from the clock's details, or **Settings → History** on the desktop.

- **Keep a history of every diagram**: turn recording off or on for this device. History already
  kept stays.
- **Add a revision after**, and **at least every**: how often history records.
- **Recorded as**: the name and email revisions carry. Left empty, they say "Draft Canvas". It is a
  label, not a sign-in.
- **Record this diagram's history**: pause or resume one diagram.
- **Export history…**: saves the whole history as a `.bundle` file. Anyone with Git can open it:
  `git clone history.bundle`.
- **Import history…**: brings a `.bundle` in. This diagram then continues that history; its earlier
  history stays on the device.
- **Remove this diagram's history…**: deletes its revisions from this device, after asking. The
  diagram itself is unchanged.

## Privacy

History stays on your device: in this browser on the web, in the app's data folder on the desktop.
Nothing is uploaded.

History keeps what a diagram used to contain, including shapes and text you later deleted. Keep
that in mind before you export or share a history. Exporting a diagram (a `.draftcanvas` file, an
image, a link) never includes its history.

On the web, clearing site data, or the browser freeing up space, can remove history along with
diagrams. Export a diagram's history to keep a copy.

## Live sessions

Only the session's owner records history, from the owner's own copy. Collaborators' copies are not
recorded, and joining a session never shares anyone's history.
