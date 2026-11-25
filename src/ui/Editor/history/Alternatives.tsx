import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Oid } from '../../../evolution/contracts';
import { branchOf } from '../../../evolution/refs';
import { historyService } from '../../../store/evolution/bridge';
import { compareVersions } from '../../../store/evolution/compare';
import { useEvolutionStore } from '../../../store/evolution/evolutionStore';
import { reportOutcome as report } from '../../../commands/evolution';
import { archiveAlternative, createAlternative, renameAlternative, switchAlternative } from '../../../store/evolution/operations';
import { startMerge } from '../../../store/evolution/merging';
import { Button } from '../../common/Button';
import { Icon } from '../../common/Icon';
import { Modal } from '../../common/Modal';
import { ToolbarMenu } from '../toolbar/ToolbarMenu';

/**
 * Alternatives: other directions the architecture could take, each a real Git branch, named by the
 * person and never by Git. Reached from the timeline's title — the name of the one being worked on —
 * so they are one click away and take no room until wanted.
 */

/** The timeline's title: which architecture this is, and the way to the others. */
export function AlternativeSwitcher() {
  // `changes` moves whenever history does (a new alternative, a rename): read the list afresh then.
  const { altId } = useEvolutionStore(useShallow((state) => ({ altId: state.altId, changes: state.changes })));
  const [menu, setMenu] = useState<{ rect: DOMRect; trigger: HTMLElement } | null>(null);
  const [naming, setNaming] = useState(false);
  const [managing, setManaging] = useState(false);
  const alternatives = historyService().context()?.meta?.alternatives ?? [];
  const current = altId === null ? 'Main architecture' : (alternatives.find((alt) => alt.altId === altId)?.name ?? 'Alternative');

  const items = [
    { id: 'main', label: 'Main architecture', ...(altId === null ? { icon: 'check' as const } : {}), onSelect: () => void switchAlternative(null).then(report) },
    ...alternatives
      .filter((alt) => !alt.archived)
      .map((alt) => ({ id: alt.altId, label: alt.name, ...(alt.altId === altId ? { icon: 'check' as const } : {}), onSelect: () => void switchAlternative(alt.altId).then(report) })),
    ...[{ altId: null as string | null, name: 'Main architecture', archived: false }, ...alternatives]
      .filter((alt) => !alt.archived && alt.altId !== altId)
      .map((alt) => ({ id: `merge-${alt.altId ?? 'main'}`, label: `Bring in “${alt.name}”…`, detail: 'Combine its changes with this one', onSelect: () => void startMerge(alt.altId).then(report) })),
    { id: 'new', label: 'Explore an alternative…', detail: 'Try another direction; this one stays as it is', onSelect: () => setNaming(true) },
    ...(alternatives.length > 0 ? [{ id: 'manage', label: 'Manage alternatives…', onSelect: () => setManaging(true) }] : []),
  ];

  return (
    <>
      <button
        type="button"
        className="dc-timeline-title"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={(event) => {
          const trigger = event.currentTarget;
          setMenu((open) => (open ? null : { rect: trigger.getBoundingClientRect(), trigger }));
        }}
      >
        <Icon name={altId === null ? 'timeline' : 'branch'} size={15} />
        <span className="dc-timeline-title-name">{current}</span>
        <Icon name="down" size={12} />
      </button>
      {menu && (
        <ToolbarMenu
          label="Alternatives"
          anchorRect={menu.rect}
          trigger={menu.trigger}
          placement="above"
          items={items.map((item) => ({
            ...item,
            onSelect: () => {
              setMenu(null);
              item.onSelect();
            },
          }))}
          onDismiss={() => setMenu(null)}
        />
      )}
      {naming && <NameAlternative onDone={() => setNaming(false)} />}
      {managing && <ManageAlternatives onClose={() => setManaging(false)} />}
    </>
  );
}

/** Asks for a name, then starts the alternative — from now, or from the revision given. */
export function NameAlternative({ from, onDone }: { from?: Oid; onDone: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Explore an alternative" onClose={onDone} width={420}>
      <form
        className="dc-alt-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          setBusy(true);
          void createAlternative(name, from).then((outcome) => {
            setBusy(false);
            if (!outcome.ok) return setError(outcome.message);
            report(outcome);
            onDone();
          });
        }}
      >
        <p className="dc-prefs-description">
          {from ? 'It starts from the revision you are looking at.' : 'It starts from the diagram as it is now.'} The architecture you are leaving stays exactly as
          it is, and you can come back to it any time.
        </p>
        <label className="dc-field">
          <span>Name</span>
          <input autoFocus maxLength={80} placeholder="e.g. Event-driven payments" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        {error && (
          <p className="dc-prefs-description" role="alert">
            {error}
          </p>
        )}
        <div className="dc-alt-form-actions">
          <Button variant="quiet" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" variant="solid" disabled={!name.trim() || busy}>
            Explore
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ManageAlternatives({ onClose }: { onClose: () => void }) {
  const altId = useEvolutionStore((state) => state.altId);
  useEvolutionStore((state) => state.changes);
  const alternatives = historyService().context()?.meta?.alternatives ?? [];
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const compareWithMain = async (id: string) => {
    const store = historyService().store;
    if (!store) return;
    const [main, alt] = await Promise.all([store.readRef(branchOf(null)), store.readRef(branchOf(id))]);
    if (main && alt) {
      useEvolutionStore.setState({ timelineOpen: true });
      await compareVersions(main, alt);
      onClose();
    }
  };
  return (
    <Modal title="Alternatives" onClose={onClose} width={520}>
      <ul className="dc-alt-list">
        {alternatives.map((alt) => (
          <li key={alt.altId} className="dc-alt-row" data-archived={alt.archived ? 'true' : undefined}>
            <Icon name="branch" size={14} />
            {renaming === alt.altId ? (
              <form
                className="dc-alt-rename"
                onSubmit={(event) => {
                  event.preventDefault();
                  void renameAlternative(alt.altId, name).then(() => setRenaming(null));
                }}
              >
                <span className="dc-field">
                  <input autoFocus maxLength={80} aria-label="Alternative name" value={name} onChange={(event) => setName(event.target.value)} />
                </span>
                <Button type="submit" variant="quiet">
                  Save
                </Button>
              </form>
            ) : (
              <span className="dc-alt-name">
                {alt.name}
                <span className="dc-alt-meta">
                  {alt.altId === altId ? 'You are here · ' : ''}
                  {alt.archived ? 'Archived · ' : ''}
                  started {new Date(alt.createdAt).toLocaleDateString()}
                </span>
              </span>
            )}
            <span className="dc-alt-actions">
              {!alt.archived && (
                <Button variant="quiet" onClick={() => void compareWithMain(alt.altId)}>
                  Compare with main
                </Button>
              )}
              {renaming !== alt.altId && (
                <Button
                  variant="quiet"
                  onClick={() => {
                    setName(alt.name);
                    setRenaming(alt.altId);
                  }}
                >
                  Rename
                </Button>
              )}
              <Button variant="quiet" onClick={() => void archiveAlternative(alt.altId, !alt.archived).then(report)}>
                {alt.archived ? 'Unarchive' : 'Archive'}
              </Button>
            </span>
          </li>
        ))}
      </ul>
      <p className="dc-prefs-description">Archiving keeps every revision of an alternative; it only takes it out of the list.</p>
    </Modal>
  );
}
