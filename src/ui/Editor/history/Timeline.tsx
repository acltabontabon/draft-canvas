import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { setTimelineOpen } from '../../../commands/evolution';
import { CATEGORIES } from '../../../evolution/diff';
import { groupSessions, matches, type Revision, type Session } from '../../../evolution/timeline';
import { relativeTime } from '../../../lib/relativeTime';
import { useEvolutionStore } from '../../../store/evolution/evolutionStore';
import { addMilestone, lensEnter, loadTimeline, sessionSummary, showLive, showRevision, stepRevision } from '../../../store/evolution/historyView';
import { roomsOf, viewOf, type DepthPath } from '../../../depth/tree';
import { Button } from '../../common/Button';
import { Icon } from '../../common/Icon';
import { Tooltip } from '../../common/Tooltip';
import { RevisionActions } from './RevisionActions';
import './history.css';
import './timeline.css';

/**
 * The timeline: a quiet strip along the foot of the canvas, opened when wanted and gone when not.
 *
 * Revisions run left (oldest) to right, grouped into editing sessions, and always end in **Live** —
 * the diagram as it is now, uncaptured changes included. Choosing a revision shows it in the lens
 * over the canvas; Live, or Esc, comes back. Underneath it is Git; nothing here asks the person to
 * know that, and nothing collapses Git's own history: a session is only how revisions are shown.
 */

const SPEEDS = [0.5, 1, 2] as const;
const STEP_MS = 1400;

const CATEGORY_LABELS: Record<string, string> = {
  structure: 'Structure',
  relationships: 'Relationships',
  properties: 'Properties',
  text: 'Text',
  layout: 'Layout',
  style: 'Style',
  grouping: 'Grouping',
  navigation: 'Navigation',
  flows: 'Flows',
  annotations: 'Notes',
  metadata: 'Details',
};

function formatWhen(at: number): string {
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function SessionLabel({ session }: { session: Session }) {
  const [summary, setSummary] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void sessionSummary(session.before, session.last).then((text) => live && setSummary(text));
    return () => {
      live = false;
    };
  }, [session.before, session.last]);
  return (
    <span className="dc-timeline-session-label" title={summary ?? undefined}>
      <span className="dc-timeline-session-when">{formatWhen(session.end)}</span>
      {summary && <span className="dc-timeline-session-summary">{summary}</span>}
    </span>
  );
}

export function Timeline() {
  const { open, timeline, lens, playback, altName, capture } = useEvolutionStore(
    useShallow((state) => ({ open: state.timelineOpen, timeline: state.timeline, lens: state.lens, playback: state.playback, altName: state.altName, capture: state.capture })),
  );
  const [query, setQuery] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [milestonesOnly, setMilestonesOnly] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const changes = useEvolutionStore((state) => state.changes);

  // A new revision arrived while the timeline is open: list it (Live slides into a new mark).
  useEffect(() => {
    if (open) void loadTimeline();
  }, [open, changes]);

  const filtering = query.trim() !== '' || categories.length > 0 || milestonesOnly;
  const shown = useMemo(
    () => (filtering ? timeline.revisions.filter((revision) => matches(revision, { text: query, categories, milestones: milestonesOnly })) : timeline.revisions),
    [timeline.revisions, filtering, query, categories, milestonesOnly],
  );
  const sessions = useMemo(() => groupSessions(shown), [shown]);
  const selected = lens && lens.oid !== 'live' ? timeline.revisions.find((revision) => revision.oid === lens.oid) : undefined;

  // Playback: one step at a time toward Live, as long as it plays.
  useEffect(() => {
    if (!open || !playback.playing) return;
    const timer = window.setInterval(() => {
      void stepRevision(1).then((moved) => {
        const state = useEvolutionStore.getState();
        if (!moved || state.lens === null || state.lens.oid === 'live') useEvolutionStore.setState({ playback: { ...state.playback, playing: false } });
      });
    }, STEP_MS / playback.speed);
    return () => window.clearInterval(timer);
  }, [open, playback.playing, playback.speed]);

  // Keep the chosen mark in view.
  useEffect(() => {
    track.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [lens?.oid]);

  if (!open) return null;

  const setPlayback = (patch: Partial<typeof playback>) => useEvolutionStore.setState((state) => ({ playback: { ...state.playback, ...patch } }));
  const togglePlay = async () => {
    if (playback.playing) {
      setPlayback({ playing: false });
      return;
    }
    // From the oldest loaded revision when starting at Live; from where the lens is otherwise.
    if (!lens || lens.oid === 'live') {
      const oldest = timeline.revisions.at(-1);
      if (!oldest) return;
      await showRevision(oldest.oid);
    }
    setPlayback({ playing: true });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('input, textarea, select')) {
      if (event.key === 'Escape') (event.target as HTMLElement).blur();
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      void stepRevision(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      void stepRevision(1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      const oldest = timeline.revisions.at(-1);
      if (oldest) void showRevision(oldest.oid);
    } else if (event.key === 'End') {
      event.preventDefault();
      showLive();
    } else if (event.key === ' ') {
      event.preventDefault();
      void togglePlay();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (lens) showLive();
      else setTimelineOpen(false);
    }
  };

  const ordered = [...sessions].reverse();
  const rooms = lens && lens.oid !== 'live' ? roomsOf(lens.file).filter((room) => room.path.length > 0) : [];

  return (
    <div ref={panel} className="dc-timeline" role="region" aria-label="Timeline" onKeyDown={onKeyDown}>
      <div className="dc-timeline-head">
        <span className="dc-timeline-title">
          <Icon name="timeline" size={15} />
          Timeline
          {altName && <span className="dc-timeline-alt">· {altName}</span>}
        </span>
        <div className="dc-timeline-controls">
          <Tooltip content={{ title: playback.playing ? 'Pause' : 'Play the evolution', shortcut: 'Space' }}>
            {(tip) => <Button variant="quiet" icon={playback.playing ? 'pause' : 'play'} aria-label={playback.playing ? 'Pause' : 'Play the evolution'} onClick={() => void togglePlay()} disabled={timeline.revisions.length === 0} {...tip} />}
          </Tooltip>
          <Tooltip content={{ title: 'Older', shortcut: '←' }}>{(tip) => <Button variant="quiet" icon="back" aria-label="Older revision" onClick={() => void stepRevision(-1)} {...tip} />}</Tooltip>
          <Tooltip content={{ title: 'Newer', shortcut: '→' }}>{(tip) => <Button variant="quiet" icon="forward" aria-label="Newer revision" onClick={() => void stepRevision(1)} {...tip} />}</Tooltip>
          <select className="dc-select dc-timeline-speed" aria-label="Playback speed" value={playback.speed} onChange={(event) => setPlayback({ speed: Number(event.target.value) as (typeof SPEEDS)[number] })}>
            {SPEEDS.map((speed) => (
              <option key={speed} value={speed}>
                {speed}×
              </option>
            ))}
          </select>
          <label className="dc-timeline-toggle">
            <input type="checkbox" checked={playback.focus} onChange={(event) => setPlayback({ focus: event.target.checked })} />
            Follow changes
          </label>
          <span className="dc-timeline-search">
            <Icon name="search" size={13} />
            <input type="search" placeholder="Find a revision" aria-label="Find a revision" value={query} onChange={(event) => setQuery(event.target.value)} />
          </span>
          <Button variant="quiet" active={filtersOpen || categories.length > 0 || milestonesOnly} aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>
            Filter{categories.length + (milestonesOnly ? 1 : 0) > 0 ? ` (${categories.length + (milestonesOnly ? 1 : 0)})` : ''}
          </Button>
          <Tooltip content={{ title: 'Close the timeline', shortcut: 'Esc' }}>{(tip) => <Button variant="quiet" icon="close" aria-label="Close the timeline" onClick={() => setTimelineOpen(false)} {...tip} />}</Tooltip>
        </div>
      </div>

      {filtersOpen && (
        <div className="dc-timeline-filters" role="group" aria-label="Show revisions that changed">
          {CATEGORIES.map((category) => (
            <label key={category} className="dc-timeline-chip" data-on={categories.includes(category) ? 'true' : undefined}>
              <input
                type="checkbox"
                checked={categories.includes(category)}
                onChange={(event) => setCategories(event.target.checked ? [...categories, category] : categories.filter((c) => c !== category))}
              />
              {CATEGORY_LABELS[category] ?? category}
            </label>
          ))}
          <label className="dc-timeline-chip" data-on={milestonesOnly ? 'true' : undefined}>
            <input type="checkbox" checked={milestonesOnly} onChange={(event) => setMilestonesOnly(event.target.checked)} />
            Milestones
          </label>
        </div>
      )}

      <div ref={track} className="dc-timeline-track" role="listbox" aria-label="Revisions, oldest to newest" aria-orientation="horizontal">
        {timeline.more && !filtering && (
          <button type="button" className="dc-timeline-more" onClick={() => void loadTimeline(true)}>
            Older…
          </button>
        )}
        {ordered.map((session) => (
          <div key={session.id} className="dc-timeline-session" role="group" aria-label={`Session ending ${new Date(session.end).toLocaleString()}`}>
            <SessionLabel session={session} />
            <div className="dc-timeline-marks">
              {[...session.revisions].reverse().map((revision) => (
                <RevisionMark key={revision.oid} revision={revision} current={lens?.oid === revision.oid} />
              ))}
            </div>
          </div>
        ))}
        <button
          type="button"
          role="option"
          className="dc-timeline-live"
          aria-selected={!lens || lens.oid === 'live'}
          aria-current={!lens || lens.oid === 'live' ? 'true' : undefined}
          onClick={showLive}
        >
          <span className="dc-timeline-live-dot" data-pending={capture.kind === 'pending' || capture.kind === 'capturing' ? 'true' : undefined} />
          Live
        </button>
        {timeline.loading && timeline.revisions.length === 0 && <span className="dc-timeline-empty">Reading history…</span>}
        {!timeline.loading && timeline.revisions.length === 0 && !timeline.error && <span className="dc-timeline-empty">No revisions yet: the first one is added a moment after you change something.</span>}
        {filtering && shown.length === 0 && timeline.revisions.length > 0 && <span className="dc-timeline-empty">No revision matches.</span>}
        {timeline.error && <span className="dc-timeline-empty" role="alert">{timeline.error}</span>}
      </div>

      {selected && lens && lens.oid !== 'live' && (
        <div className="dc-timeline-detail" aria-live="polite">
          <div className="dc-timeline-detail-text">
            <span className="dc-timeline-detail-summary">{selected.summary}</span>
            <span className="dc-timeline-detail-meta">
              {new Date(selected.at).toLocaleString()} · {relativeTime(selected.at)}
              {selected.agents.length > 0 && ` · by an agent you reviewed (${selected.agents.join(', ')})`}
              {selected.contributors.length > 0 && ` · with ${selected.contributors.join(', ')}`}
            </span>
            {lens.missing && <span className="dc-timeline-detail-meta" role="status">{lens.missing}</span>}
            {selected.milestones.map((milestone) => (
              <span key={milestone.id} className="dc-timeline-milestone-tag">
                <Icon name="check" size={12} /> {milestone.name}
              </span>
            ))}
          </div>
          {rooms.length > 0 && <RoomPicker file={lens.file} path={lens.path} />}
          <RevisionActions revision={selected} />
          <MilestoneForm oid={selected.oid} />
        </div>
      )}
      <span className="dc-sr-only" role="status">
        {selected ? `Showing a past revision: ${selected.summary}. Press Escape to return to the live diagram.` : ''}
      </span>
    </div>
  );
}

function RevisionMark({ revision, current }: { revision: Revision; current: boolean }) {
  const milestone = revision.milestones[0];
  return (
    <Tooltip content={{ title: revision.summary, description: `${new Date(revision.at).toLocaleString()}${milestone ? ` · ${milestone.name}` : ''}` }}>
      {(tip) => (
        <button
          type="button"
          role="option"
          aria-selected={current}
          aria-current={current ? 'true' : undefined}
          aria-label={`${revision.summary}, ${new Date(revision.at).toLocaleString()}${milestone ? `, milestone ${milestone.name}` : ''}`}
          className="dc-timeline-mark"
          data-kind={revision.initiator}
          data-milestone={milestone ? 'true' : undefined}
          onClick={() => void showRevision(revision.oid)}
          {...tip}
        >
          {milestone && <span className="dc-timeline-mark-flag">{milestone.name}</span>}
        </button>
      )}
    </Tooltip>
  );
}

/** Rooms of the revision on screen: a past revision's views are reached from here, never from the live diagram. */
function RoomPicker({ file, path }: { file: import('../../../document/types').DraftDocument; path: DepthPath }) {
  const rooms = roomsOf(file).filter((room) => room.path.length > 0);
  const nameOf = (room: DepthPath) => {
    const owner = room.length > 0 ? viewOf(file, room.slice(0, -1))?.nodes.find((node) => node.id === room[room.length - 1]) : undefined;
    return owner?.text?.split('\n')[0] || 'A view';
  };
  return (
    <select className="dc-select dc-timeline-room" aria-label="View" value={path.join('/')} onChange={(event) => lensEnter(event.target.value ? event.target.value.split('/') : [])}>
      <option value="">Top level</option>
      {rooms.map((room) => (
        <option key={room.path.join('/')} value={room.path.join('/')}>
          {'  '.repeat(room.path.length - 1)}
          {nameOf(room.path)}
        </option>
      ))}
    </select>
  );
}

function MilestoneForm({ oid }: { oid: string }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!editing) {
    return (
      <Button variant="quiet" onClick={() => setEditing(true)}>
        Name this revision…
      </Button>
    );
  }
  return (
    <form
      className="dc-timeline-milestone-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        addMilestone(oid, name).then(
          () => {
            setEditing(false);
            setName('');
          },
          (failure: unknown) => setError(failure instanceof Error ? failure.message : 'The milestone could not be saved.'),
        );
      }}
    >
      <span className="dc-field">
        <input autoFocus maxLength={120} placeholder="Milestone name" aria-label="Milestone name" value={name} onChange={(event) => setName(event.target.value)} />
      </span>
      <Button type="submit" variant="solid">
        Save
      </Button>
      <Button variant="quiet" onClick={() => setEditing(false)}>
        Cancel
      </Button>
      {error && <span role="alert">{error}</span>}
    </form>
  );
}
