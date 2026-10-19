import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { LIMITS } from '../document/limits';
import { isImeKeyEvent } from '../lib/isEditableTarget';
import { GENERIC_TECHNOLOGY_ICON, technologyIcon, technologySuggestions, type TechnologyIcon } from '../nodes/technology';
import { useTechnologyIcon } from './useTechnologyIcon';

function Icon({ icon: candidate }: { icon: TechnologyIcon }) {
  const icon = useTechnologyIcon(candidate.slug) ?? GENERIC_TECHNOLOGY_ICON;
  return <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d={icon.path} fill="currentColor" /></svg>;
}

/** Suggestions only advertise bundled brand icons. Typing a custom value is always allowed;
 * draft text stays local until selection, Enter or blur, so browsing never creates undo steps. */
export function TechnologyInput({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [placement, setPlacement] = useState({ above: false, height: 188 });
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const id = useId();
  const suggestions = technologySuggestions(draft);
  const expanded = open && suggestions.length > 0;
  const desiredHeight = suggestions.length * 30 + 8;

  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const canvas = root.closest('.react-flow')?.getBoundingClientRect();
    const below = Math.max(0, (canvas?.bottom ?? window.innerHeight) - rect.bottom - 8);
    const above = Math.max(0, rect.top - (canvas?.top ?? 0) - 8);
    const opensAbove = below < desiredHeight && above > below;
    const height = Math.min(desiredHeight, opensAbove ? above : below);
    setPlacement((current) => current.above === opensAbove && current.height === height ? current : { above: opensAbove, height });
  }, [desiredHeight]);

  useLayoutEffect(() => { if (expanded) measure(); }, [expanded, measure]);
  useLayoutEffect(() => {
    if (expanded) listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [expanded, active]);
  useEffect(() => {
    if (!expanded) return;
    window.addEventListener('resize', measure);
    window.addEventListener('wheel', measure, { passive: true });
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('wheel', measure);
    };
  }, [expanded, measure]);

  const choose = (selected: string) => {
    setDraft(selected);
    setOpen(false);
    if (selected !== value) onCommit(selected);
  };

  return (
    <div className="dc-c4-field">
      <label htmlFor={id}>Technology</label>
      <div className="dc-technology-input" ref={rootRef}>
        <span className="dc-technology-input-icon"><Icon icon={technologyIcon(draft) ?? GENERIC_TECHNOLOGY_ICON} /></span>
        <input
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? `${id}-options` : undefined}
          aria-activedescendant={expanded ? `${id}-option-${active}` : undefined}
          dir="auto"
          className="dc-inspector-control"
          value={draft}
          maxLength={LIMITS.maxTechnologyLength}
          placeholder="Spring Boot, PostgreSQL…"
          spellCheck={false}
          autoComplete="off"
          onFocus={() => { setOpen(true); setActive(0); }}
          onChange={(event) => { setDraft(event.currentTarget.value); setOpen(true); setActive(0); }}
          onBlur={() => {
            setOpen(false);
            if (draft.trim() !== value) onCommit(draft);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (isImeKeyEvent(event)) return;
            if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && suggestions.length) {
              event.preventDefault();
              setOpen(true);
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setActive(open ? (active + step + suggestions.length) % suggestions.length : 0);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              if (expanded) choose(suggestions[active]!.value);
              else event.currentTarget.blur();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setOpen(false);
            }
          }}
        />
        {expanded && (
          <ul
            ref={listRef}
            id={`${id}-options`}
            className="dc-technology-suggestions"
            role="listbox"
            aria-label="Technologies with icons"
            data-above={placement.above || undefined}
            style={{ maxHeight: placement.height }}
          >
            {suggestions.map((suggestion, index) => (
              <li
                id={`${id}-option-${index}`}
                key={suggestion.icon.slug}
                role="option"
                aria-selected={active === index}
                onPointerMove={() => setActive(index)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(suggestion.value)}
              >
                <Icon icon={suggestion.icon} />
                <span>{suggestion.value}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {open && draft.trim() && !suggestions.length && <span className="dc-technology-custom" role="status">Custom technology · generic icon</span>}
    </div>
  );
}
