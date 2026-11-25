import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { setTimelineOpen } from '../../../commands/evolution';
import { roomsOf, viewOf, type DepthPath } from '../../../depth/tree';
import type { DraftDocument } from '../../../document/types';
import { CATEGORIES } from '../../../evolution/diff';
import { groupSessions, matches, type Revision, type Session } from '../../../evolution/timeline';
import { relativeTime } from '../../../lib/relativeTime';
import { useEvolutionStore, type PlaybackState } from '../../../store/evolution/evolutionStore';
import { compareVersions, endCompare } from '../../../store/evolution/compare';
import { lensEnter, loadTimeline, sessionSummary, showLive, showRevision, stepRevision } from '../../../store/evolution/historyView';
import { Button } from '../../common/Button';
import { Icon } from '../../common/Icon';
import { Tooltip } from '../../common/Tooltip';
import { AlternativeSwitcher } from './Alternatives';
import { CompareBar } from './CompareBar';
import { MenuButton } from './MenuButton';
import { RevisionActions } from './RevisionActions';
import './history.css';
import './timeline.css';

/**
 * The timeline: a quiet strip along the foot of the canvas, opened when wanted and gone when not.
 *
 * One row of controls — step, play, find, options — then the revisions, oldest to newest, grouped
 * into editing sessions and always ending in **Live**: the diagram as it is now. Choosing a revision
 * shows it in the lens over the canvas; Live, or Esc, comes back. Everything occasional (speed,
 * following the camera, filters, Git details) waits behind one control each, so the strip stays
 * calm. Sessions are only how revisions are shown; Git's history underneath is never collapsed.
 */

const STEP_MS = 1400;

const CATEGORY_LABELS: Record<string, string> = {
  structure: 'Shapes',
  relationships: 'Connections',
  properties: 'Properties',
  text: 'Text',
  layout: 'Layout',
  style: 'Style',
  grouping: 'Grouping',
  navigation: 'Links',
  flows: 'Flows',
  annotations: 'Notes',
  metadata: 'Details',
};

function formatWhen(at: number): string {
  const date = new Date(at);
  const sameDay = date.toDateString() === new Date().toDateString();
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
  // A session's label compares its start with its end: its net change, on the canvas.
  const from = session.before ?? session.revisions.at(-1)!.oid;
  return (
    <button
      type="button"
      className="dc-timeline-session-label"
      title={summary ? `${summary} — compare the start and end of this session` : 'Compare the start and end of this session'}
      disabled={from === session.last}
      onClick={() => void compareVersions(from, session.last)}
    >
      <span className="dc-timeline-session-when">{formatWhen(session.end)}</span>
      <span className="dc-timeline-session-summary">{summary ?? ' '}</span>
    </button>
  );
}

export function Timeline() {
  const { open, timeline, lens, playback, capture, changes, compare } = useEvolutionStore(
    useShallow((state) => ({
      compare: state.compare,
      open: state.timelineOpen,
      timeline: state.timeline,
      lens: state.lens,
      playback: state.playback,
      capture: state.capture,
      changes: state.changes,
    })),
  );
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [milestonesOnly, setMilestonesOnly] = useState(false);
  const track = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);

  // A new revision while the timeline is open: list it, and Live slides along.
  useEffect(() => {
    if (open) void loadTimeline();
  }, [open, changes]);

  useEffect(() => {
    if (finding) findInput.current?.focus();
  }, [finding]);

  const filtering = finding && (query.trim() !== '' || categories.length > 0 || milestonesOnly);
  const shown = useMemo(
    () => (filtering ? timeline.revisions.filter((revision) => matches(revision, { text: query, categories, milestones: milestonesOnly })) : timeline.revisions),
    [timeline.revisions, filtering, query, categories, milestonesOnly],
  );
  const sessions = useMemo(() => [...groupSessions(shown)].reverse(), [shown]);
  const atLive = !lens || lens.oid === 'live';
  const selected = !atLive ? timeline.revisions.find((revision) => revision.oid === lens.oid) : undefined;

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

  useEffect(() => {
    track.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [lens?.oid, sessions.length]);

  if (!open) return null;

  const setPlayback = (patch: Partial<PlaybackState>) => useEvolutionStore.setState((state) => ({ playback: { ...state.playback, ...patch } }));
  const togglePlay = async () => {
    if (playback.playing) return setPlayback({ playing: false });
    if (atLive) {
      const oldest = timeline.revisions.at(-1);
      if (!oldest) return;
      await showRevision(oldest.oid);
    }
    setPlayback({ playing: true });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('input, textarea, select')) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setFinding(false);
      }
      return;
    }
    const keys: Record<string, () => void> = {
      ArrowLeft: () => void stepRevision(-1),
      ArrowRight: () => void stepRevision(1),
      Home: () => {
        const oldest = timeline.revisions.at(-1);
        if (oldest) void showRevision(oldest.oid);
      },
      End: showLive,
      ' ': () => void togglePlay(),
      Escape: () => (compare ? endCompare() : lens ? showLive() : setTimelineOpen(false)),
    };
    const run = keys[event.key];
    if (!run) return;
    event.preventDefault();
    run();
  };

  const options = () => [
    ...([0.5, 1, 2] as const).map((speed) => ({
      id: `speed-${speed}`,
      label: speed === 1 ? 'Normal speed' : speed < 1 ? 'Slower playback' : 'Faster playback',
      ...(playback.speed === speed ? { icon: 'check' as const } : {}),
      onSelect: () => setPlayback({ speed }),
    })),
    {
      id: 'follow',
      label: 'Follow changes with the camera',
      ...(playback.focus ? { icon: 'check' as const } : {}),
      onSelect: () => setPlayback({ focus: !playback.focus }),
    },
  ];

  const rooms = lens && !atLive ? roomsOf(lens.file).filter((room) => room.path.length > 0) : [];

  return (
    <div className="dc-timeline" role="region" aria-label="Timeline" onKeyDown={onKeyDown}>
      <div className="dc-timeline-head">
        <span className="dc-timeline-title-slot">
          <AlternativeSwitcher />
        </span>
        <div className="dc-timeline-transport" role="group" aria-label="Playback">
          <Tooltip content={{ title: 'Older', shortcut: '←' }}>{(tip) => <Button variant="quiet" icon="back" aria-label="Older revision" onClick={() => void stepRevision(-1)} {...tip} />}</Tooltip>
          <Tooltip content={{ title: playback.playing ? 'Pause' : 'Play the evolution', shortcut: 'Space' }}>
            {(tip) => (
              <Button
                variant="quiet"
                className="dc-timeline-play"
                icon={playback.playing ? 'pause' : 'play'}
                aria-label={playback.playing ? 'Pause' : 'Play the evolution'}
                disabled={timeline.revisions.length === 0}
                onClick={() => void togglePlay()}
                {...tip}
              />
            )}
          </Tooltip>
          <Tooltip content={{ title: 'Newer', shortcut: '→' }}>{(tip) => <Button variant="quiet" icon="forward" aria-label="Newer revision" onClick={() => void stepRevision(1)} {...tip} />}</Tooltip>
        </div>
        <div className="dc-timeline-tools">
          <Tooltip content={{ title: 'Find a revision' }}>
            {(tip) => <Button variant="quiet" icon="search" aria-label="Find a revision" aria-expanded={finding} active={finding} onClick={() => setFinding(!finding)} {...tip} />}
          </Tooltip>
          <MenuButton icon="sliders" label="Playback options" items={options} />
          <Tooltip content={{ title: 'Close', shortcut: 'Esc' }}>{(tip) => <Button variant="quiet" icon="close" aria-label="Close the timeline" onClick={() => setTimelineOpen(false)} {...tip} />}</Tooltip>
        </div>
      </div>

      {finding && (
        <div className="dc-timeline-find">
          <span className="dc-timeline-search">
            <Icon name="search" size={13} />
            <input ref={findInput} type="search" placeholder="Shape, words, person or date" aria-label="Find a revision" value={query} onChange={(event) => setQuery(event.target.value)} />
          </span>
          <div className="dc-timeline-filters" role="group" aria-label="Only revisions that changed">
            {CATEGORIES.filter((category) => category !== 'metadata' && category !== 'properties').map((category) => (
              <label key={category} className="dc-timeline-chip" data-on={categories.includes(category) ? 'true' : undefined}>
                <input type="checkbox" checked={categories.includes(category)} onChange={(event) => setCategories(event.target.checked ? [...categories, category] : categories.filter((c) => c !== category))} />
                {CATEGORY_LABELS[category]}
              </label>
            ))}
            <label className="dc-timeline-chip" data-on={milestonesOnly ? 'true' : undefined}>
              <input type="checkbox" checked={milestonesOnly} onChange={(event) => setMilestonesOnly(event.target.checked)} />
              Milestones
            </label>
          </div>
        </div>
      )}

      <div ref={track} className="dc-timeline-track" role="listbox" aria-label="Revisions, oldest to newest" aria-orientation="horizontal">
        {timeline.more && !filtering && (
          <button type="button" className="dc-timeline-more" onClick={() => void loadTimeline(true)}>
            Earlier
          </button>
        )}
        {sessions.map((session) => (
          <div key={session.id} className="dc-timeline-session" role="group" aria-label={`Session ending ${new Date(session.end).toLocaleString()}`}>
            <SessionLabel session={session} />
            <div className="dc-timeline-marks">
              {[...session.revisions].reverse().map((revision) => (
                <RevisionMark key={revision.oid} revision={revision} current={lens?.oid === revision.oid || compare?.base.oid === revision.oid} />
              ))}
            </div>
          </div>
        ))}
        {timeline.revisions.length === 0 && (
          <span className="dc-timeline-empty">{timeline.loading ? 'Reading history…' : (timeline.error ?? 'The first revision is added a moment after you change something.')}</span>
        )}
        {filtering && shown.length === 0 && timeline.revisions.length > 0 && <span className="dc-timeline-empty">No revision matches.</span>}
        <button type="button" role="option" className="dc-timeline-live" aria-selected={atLive} aria-current={atLive ? 'true' : undefined} onClick={showLive}>
          <span className="dc-timeline-live-dot" data-pending={capture.kind === 'pending' || capture.kind === 'capturing' ? 'true' : undefined} />
          Live
        </button>
      </div>

      {compare && <CompareBar compare={compare} />}
      {!compare && selected && lens && (
        <div className="dc-timeline-detail">
          <div className="dc-timeline-detail-text">
            <span className="dc-timeline-detail-summary">
              {selected.summary}
              {selected.milestones.map((milestone) => (
                <span key={milestone.id} className="dc-timeline-milestone-tag">
                  {milestone.name}
                </span>
              ))}
            </span>
            <span className="dc-timeline-detail-meta">
              {relativeTime(selected.at)}
              {selected.agents.length > 0 && ' · reviewed agent change'}
              {selected.contributors.length > 0 && ` · with ${selected.contributors.join(', ')}`}
              {lens.missing && ` · ${lens.missing}`}
            </span>
          </div>
          {rooms.length > 0 && <RoomPicker file={lens.file} path={lens.path} />}
          <RevisionActions revision={selected} />
        </div>
      )}
      <span className="dc-sr-only" role="status">
        {selected ? `Showing an earlier revision: ${selected.summary}. Escape returns to the live diagram.` : ''}
      </span>
    </div>
  );
}

function RevisionMark({ revision, current }: { revision: Revision; current: boolean }) {
  const milestone = revision.milestones[0];
  const when = new Date(revision.at).toLocaleString();
  return (
    <Tooltip content={{ title: revision.summary, description: `${milestone ? `${milestone.name} · ` : ''}${when} · Shift-click to compare` }}>
      {(tip) => (
        <button
          type="button"
          role="option"
          aria-selected={current}
          aria-current={current ? 'true' : undefined}
          aria-label={`${revision.summary}, ${when}${milestone ? `, milestone ${milestone.name}` : ''}`}
          className="dc-timeline-mark"
          data-kind={revision.initiator}
          data-milestone={milestone ? 'true' : undefined}
          onClick={(event) => {
            // Shift-click a second revision to compare the two.
            const shown = useEvolutionStore.getState().lens;
            if (event.shiftKey && shown && shown.oid !== 'live') void compareVersions(shown.oid, revision.oid);
            else void showRevision(revision.oid);
          }}
          {...tip}
        />
      )}
    </Tooltip>
  );
}

/** A past revision's views, reached from here rather than from the live diagram. */
function RoomPicker({ file, path }: { file: DraftDocument; path: DepthPath }) {
  const rooms = roomsOf(file).filter((room) => room.path.length > 0);
  const nameOf = (room: DepthPath) => viewOf(file, room.slice(0, -1))?.nodes.find((node) => node.id === room[room.length - 1])?.text?.split('\n')[0] || 'A view';
  return (
    <select className="dc-select dc-timeline-room" aria-label="View in this revision" value={path.join('/')} onChange={(event) => lensEnter(event.target.value ? event.target.value.split('/') : [])}>
      <option value="">Top level</option>
      {rooms.map((room) => (
        <option key={room.path.join('/')} value={room.path.join('/')}>
          {' '.repeat(room.path.length - 1)}
          {nameOf(room.path)}
        </option>
      ))}
    </select>
  );
}
