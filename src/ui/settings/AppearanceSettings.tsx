import { useEffect, useMemo, useRef, useState } from 'react';
import { ShapePreview } from '../../canvas/ShapePreview';
import {
  HAND_PRESETS,
  KIND_FIELDS,
  STYLE_KINDS,
  STYLE_LIMITS,
  shapeKey,
  type ConnectorStyle,
  type DocumentStyle,
  type HandPreset,
  type ShapeStyle,
  type StyleCorners,
  type StyleEdgeColour,
  type StyleHead,
  type StyleWeight,
  type StyleWobble,
  type SurfaceStyle,
} from '../../document/style';
import { NODE_TYPES, type DraftNode, type DraftNodeType } from '../../document/types';
import {
  ACTOR_KIND_OPTION_LABELS,
  ARTIFACT_KIND_OPTION_LABELS,
  BOUNDARY_PRESET_OPTION_LABELS,
  COMPONENT_KIND_OPTION_LABELS,
  DATABASE_KIND_OPTION_LABELS,
  NODE_TYPE_LABELS,
  NOTE_LABELS,
  QUEUE_KIND_OPTION_LABELS,
  SERVICE_KIND_OPTION_LABELS,
  TEXT_ROLE_OPTION_LABELS,
} from '../../lib/nodeKindLabels';
import { downloadText } from '../../export/download';
import { MAX_STYLE_FILE_BYTES, readStyleFile, serializeStyleFile, STYLE_FILE_EXTENSION, STYLE_FILE_MIME, styleFileName } from '../../document/styleFile';
import { MAX_PROFILES } from '../../storage/styleProfiles';
import { useEditorStore } from '../../store/editorStore';
import { activeStyleOf, builtinProfileStyle, useStyleStore } from '../../store/styleStore';
import { useUiStore } from '../../store/uiStore';
import { usePersonality } from '../../theme/usePersonality';
import { useTheme } from '../../theme/useTheme';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';
import { SegmentedControl } from '../common/SegmentedControl';
import { ChoiceRow, SettingRow, SettingsPage, SettingsSection } from './layout';
import { CanvasLook } from './CanvasLook';
import { CORNER_ART, EDGE_COLOUR_ART, HAND_ART, HEAD_ART, STEADY_ART, WEIGHT_ART } from './lookArt';
import { LookTiles } from './LookTiles';
import { ShapeArtwork } from './ShapeArtwork';
import { StylePacks } from './StylePacks';
import { StylePreview } from './StylePreview';

const BUILTIN_DESCRIPTIONS: Record<HandPreset, string> = {
  clean: 'Crisp, exact lines.',
  draft: 'A restrained, hand-drawn outline.',
  sketch: 'Loose, like a pencil sketch.',
};

const HAND_LABELS: Record<HandPreset, string> = { clean: 'Clean', draft: 'Draft', sketch: 'Sketch' };
const HANDS = HAND_PRESETS.map((value) => ({ value, label: HAND_LABELS[value], art: HAND_ART[value] }));

type Steadiness = StyleWobble | 'even';
const STEADINESS: { value: Steadiness; label: string }[] = [
  { value: 'calm', label: 'Steady' },
  { value: 'even', label: 'Regular' },
  { value: 'lively', label: 'Loose' },
];
const STEADINESS_TILES = STEADINESS.map((option) => ({ ...option, art: STEADY_ART[option.value] }));

const WEIGHTS: { value: StyleWeight; label: string }[] = [
  { value: 'fine', label: 'Fine' },
  { value: 'regular', label: 'Regular' },
  { value: 'bold', label: 'Bold' },
];
const CORNERS: { value: StyleCorners; label: string }[] = [
  { value: 'sharp', label: 'Sharp' },
  { value: 'soft', label: 'Soft' },
  { value: 'round', label: 'Round' },
];
const HEADS: { value: StyleHead; label: string }[] = [
  { value: 'nib', label: 'Nib' },
  { value: 'triangle', label: 'Triangle' },
];
const WEIGHT_TILES = WEIGHTS.map((option) => ({ ...option, art: WEIGHT_ART[option.value] }));
const CORNER_TILES = CORNERS.map((option) => ({ ...option, art: CORNER_ART[option.value] }));
const HEAD_TILES = HEADS.map((option) => ({ ...option, art: HEAD_ART[option.value] }));
const EDGE_COLOURS: { value: StyleEdgeColour; label: string; name: string }[] = [
  { value: 'source', label: 'From its source', name: 'Colour from its source shape' },
  { value: 'plain', label: 'Plain', name: 'Plain colour' },
];
const EDGE_COLOUR_TILES = EDGE_COLOURS.map((option) => ({ ...option, art: EDGE_COLOUR_ART[option.value] }));

/** Beside the canvas the page is three short ones: what to draw in, the paper, and the pen. */
type PanelTab = 'styles' | 'canvas' | 'drawing';
const PANEL_TABS: { id: PanelTab; label: string }[] = [
  { id: 'styles', label: 'Styles' },
  { id: 'canvas', label: 'Canvas' },
  { id: 'drawing', label: 'Drawing' },
];

/** "Not set here": the value comes from one level up, and the control says which. */
const INHERIT = 'inherit';
type OrInherit<T extends string> = T | typeof INHERIT;
const inheriting = <T extends string>(options: { value: T; label: string }[], from: string): { value: OrInherit<T>; label: string; name?: string }[] => [
  { value: INHERIT, label: 'Same', name: `Same as ${from}` },
  ...options,
];

const KIND_LABELS: Partial<Record<DraftNodeType, Record<string, string>>> = {
  service: SERVICE_KIND_OPTION_LABELS,
  database: DATABASE_KIND_OPTION_LABELS,
  queue: QUEUE_KIND_OPTION_LABELS,
  actor: ACTOR_KIND_OPTION_LABELS,
  component: COMPONENT_KIND_OPTION_LABELS,
  artifact: ARTIFACT_KIND_OPTION_LABELS,
  group: BOUNDARY_PRESET_OPTION_LABELS,
  note: NOTE_LABELS,
  text: TEXT_ROLE_OPTION_LABELS,
};

function shapeOf(type: DraftNodeType, kind: string | undefined): Pick<DraftNode, 'type'> & Partial<DraftNode> {
  const field = (KIND_FIELDS as Partial<Record<DraftNodeType, keyof DraftNode>>)[type];
  return kind && field ? ({ type, [field]: kind } as Pick<DraftNode, 'type'> & Partial<DraftNode>) : { type };
}

/** `object` without `key` when `value` is "not set", so a style never keeps an empty setting. */
function withField<T extends object, K extends keyof T>(object: T | undefined, key: K, value: T[K] | undefined): T | undefined {
  const next = { ...(object ?? {}) } as T;
  if (value === undefined) delete next[key];
  else next[key] = value;
  return Object.keys(next).length > 0 ? next : undefined;
}

function withOptional<K extends 'general' | 'connectors' | 'schemes' | 'shapes'>(style: DocumentStyle, key: K, value: DocumentStyle[K] | undefined): DocumentStyle {
  const next = { ...style };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/**
 * Settings → Appearance, on the web and the desktop: the style this person draws in.
 *
 * A style is theirs, on this device: choosing or changing one here changes no diagram. A new
 * diagram starts with a copy of it; the open one takes it only when asked to, in the last section,
 * as one step that undo takes back. Changing a built-in style quietly makes it a style of their own
 * first, so there is never a "duplicate before you can edit" step.
 */
export function AppearanceSettings({ documentOpen = true, layout = 'page' }: { documentOpen?: boolean; /** `panel`: a column beside the canvas, where the open diagram is the picture. */ layout?: 'page' | 'panel' }) {
  const panel = layout === 'panel';
  const [tab, setTab] = useState<PanelTab>('styles');
  const { preset, setPreset } = usePersonality();
  const { name: theme } = useTheme();
  const profiles = useStyleStore((state) => state.profiles);
  const activeId = useStyleStore((state) => state.activeId);
  const notify = useUiStore((state) => state.notify);
  const style = useMemo(() => activeStyleOf({ profiles, activeId }, preset), [profiles, activeId, preset]);
  const active = activeId ? profiles.find((profile) => profile.id === activeId) : undefined;

  // The style this page last showed: what the open diagram is compared with when the style changes.
  const shown = useRef(style);
  useEffect(() => {
    shown.current = style;
  }, [style]);

  /**
   * After any change to the style in use: the open diagram follows, when it was drawn in that
   * style. So a change here is seen on the canvas at once, as one step that undo takes back. A
   * diagram with a different look of its own is left alone; it changes only when asked to, below.
   * (One with no style of its own needs nothing: it is drawn in the style in use as it is.)
   */
  const follow = (hand: HandPreset) => {
    const before = shown.current;
    const after = activeStyleOf(useStyleStore.getState(), hand);
    shown.current = after;
    if (!documentOpen || useUiStore.getState().readOnly) return;
    const editor = useEditorStore.getState();
    const own = editor.document.style;
    if (own && sameLook(own, before) && !sameLook(own, after)) editor.setDocumentStyle(after, { coalesceKey: 'my-style' });
  };

  /** Changes the style in use. A built-in one becomes the person's own on its first change. */
  const edit = (recipe: (style: DocumentStyle) => DocumentStyle) => {
    const store = useStyleStore.getState();
    const id = store.activeId ?? store.add('My style', style);
    if (!id) {
      notify(`This device keeps up to ${MAX_PROFILES} styles. Delete one to make another.`, 'error');
      return;
    }
    store.update(id, recipe);
    follow(style.hand.base);
  };

  /** The device's drawing hand follows the style in use, and so does the open diagram. */
  const took = (hand: HandPreset) => {
    setPreset(hand);
    follow(hand);
  };
  const pickBuiltin = (hand: HandPreset) => {
    useStyleStore.getState().select(null);
    took(hand);
  };
  const pickOwn = (id: string, hand: HandPreset) => {
    useStyleStore.getState().select(id);
    took(hand);
  };

  const gallery = (
    <>
      <fieldset className="dc-prefs-section dc-look-gallery" aria-describedby="dc-look-gallery-description">
        <legend className="dc-prefs-section-title">My style</legend>
        <p id="dc-look-gallery-description" className="dc-prefs-section-description">
          Pick one to draw with. Change anything below and it becomes a style of your own.
        </p>
        <div className="dc-look-cards">
          {HAND_PRESETS.map((hand) => (
            <StyleCard
              key={hand}
              name={HAND_LABELS[hand]}
              description={BUILTIN_DESCRIPTIONS[hand]}
              style={builtinProfileStyle(hand)}
              theme={theme}
              checked={!activeId && preset === hand}
              onPick={() => pickBuiltin(hand)}
            />
          ))}
          {profiles.map((profile) => (
            <StyleCard
              key={profile.id}
              name={profile.name}
              description="Yours"
              own
              style={profile.style}
              theme={theme}
              checked={activeId === profile.id}
              onPick={() => pickOwn(profile.id, profile.style.hand.base)}
            />
          ))}
          <ImportStyle onImported={took} />
        </div>
      </fieldset>

      {active && <OwnStyle key={active.id} id={active.id} name={active.name} style={active.style} onRemoved={() => follow(preset)} />}

      <StylePacks theme={theme} onAdded={took} />
    </>
  );
  const general = (
      <SettingsSection title="General" description="What every shape and connector shares, unless a shape says otherwise.">
        <SettingRow
          label="Drawing hand"
          description="How steady the pen is."
          control={
            <LookTiles
              name="style-hand"
              legend="Drawing hand"
              value={style.hand.base}
              options={HANDS}
              onChange={(base) => {
                // The device's hand first: it is what the changed style is looked up beside.
                setPreset(base);
                edit((current) => ({ ...current, hand: base === 'clean' ? { base } : { ...current.hand, base } }));
              }}
            />
          }
        />
        {style.hand.base !== 'clean' && (
          <>
            <SettingRow
              label="Steadiness"
              description="How much a line wanders."
              control={
                <LookTiles
                  name="style-wobble"
                  legend="Steadiness"
                  value={style.hand.wobble ?? 'even'}
                  options={STEADINESS_TILES}
                  onChange={(wobble) =>
                    edit((current) => {
                      const { wobble: _wobble, ...hand } = current.hand;
                      return { ...current, hand: wobble === 'even' ? hand : { ...hand, wobble } };
                    })
                  }
                />
              }
            />
            <ChoiceRow
              type="checkbox"
              toggle
              label="Go over each line twice"
              description="A second, fainter pass, the way a pencil retraces."
              checked={style.hand.retrace ?? style.hand.base === 'sketch'}
              onChange={(event) => edit((current) => ({ ...current, hand: { ...current.hand, retrace: event.target.checked } }))}
            />
          </>
        )}
        <SurfaceRows
          name="general"
          value={style.general}
          onChange={(general) => edit((current) => withOptional(current, 'general', general))}
        />
      </SettingsSection>
  );
  const shapes = (
      <ShapesSection style={style} theme={theme} edit={edit} />
  );
  const connectors = (
      <SettingsSection title="Connectors" description="How a line is drawn. What a line means, such as a dashed asynchronous call, is not a style and stays as it is.">
        <ConnectorRows value={style.connectors} onChange={(connectors) => edit((current) => withOptional(current, 'connectors', connectors))} />
      </SettingsSection>
  );
  const diagram = (
      <DiagramSection style={style} documentOpen={documentOpen} onAdded={took} />
  );

  if (panel) {
    // What the two working tabs change, said once at their head.
    const subject = <p className="dc-look-subject">{active ? <>Changing <strong>{active.name}</strong>.</> : <>Change anything here and {HAND_LABELS[preset]} becomes a style of your own, kept beside it.</>}</p>;
    return (
      <div className="dc-prefs-page dc-look-column">
        <div className="dc-look-tabs" role="tablist" aria-label="Appearance">
          {PANEL_TABS.map((entry) => (
            <button key={entry.id} type="button" role="tab" id={`dc-look-tab-${entry.id}`} aria-selected={tab === entry.id} aria-controls="dc-look-tabpanel" className="dc-look-tab" onClick={() => setTab(entry.id)}>
              {entry.label}
            </button>
          ))}
        </div>
        <div id="dc-look-tabpanel" role="tabpanel" aria-labelledby={`dc-look-tab-${tab}`} className="dc-look-tabpanel">
          {tab === 'styles' && (
            <>
              <DiagramNotice style={style} />
              {gallery}
              {diagram}
            </>
          )}
          {tab === 'canvas' && (
            <>
              {subject}
              <div className="dc-look-canvas">
                <CanvasLook style={style} theme={theme} edit={edit} />
              </div>
            </>
          )}
          {tab === 'drawing' && (
            <>
              {subject}
              {general}
              {connectors}
              {shapes}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <SettingsPage title="Appearance" lead="How your diagrams are drawn, on this device. Pick a style, add a pack, or make one that is yours.">
      {gallery}
      <div className="dc-look-studio-head">
        <h4 className="dc-prefs-section-title">Make it yours</h4>
        <p className="dc-prefs-section-description">
          {active ? `Everything below changes “${active.name}”.` : `Change anything below and ${HAND_LABELS[preset]} becomes a style of your own, kept beside it.`}
          {' '}The picture is drawn by the same renderer as the canvas.
        </p>
      </div>
      <div className="dc-prefs-stage">
        <StylePreview style={style} theme={theme} />
      </div>

      {general}
      <SettingsSection title="Canvas and colours" description="The paper, what is printed on it, and the colours everything is drawn in.">
        <CanvasLook style={style} theme={theme} edit={edit} />
      </SettingsSection>
      {shapes}
      {connectors}
      {diagram}
    </SettingsPage>
  );
}

/**
 * Beside the canvas, a change that does not show on the diagram needs saying at once: the open
 * diagram has a look of its own, saved with it, and follows nothing here until it is given this one.
 */
function DiagramNotice({ style }: { style: DocumentStyle }) {
  const readOnly = useUiStore((state) => Boolean(state.readOnly));
  const notify = useUiStore((state) => state.notify);
  const own = useEditorStore((state) => state.document.style);
  if (readOnly || !own || sameLook(own, style)) return null;
  return (
    <div className="dc-look-notice" role="status">
      <Icon name="info" size={15} />
      <p>
        This diagram is drawn in a look of its own{own.name ? `, “${own.name}”` : ''}, saved with it. What you pick here shows on it once it uses your style.
      </p>
      <Button
        variant="solid"
        onClick={() => {
          useEditorStore.getState().setDocumentStyle(style);
          notify('This diagram is now drawn in your style.');
        }}
      >
        Use my style here
      </Button>
    </div>
  );
}

/** A style to draw with, shown as a diagram drawn in it. The whole card is the choice. */
function StyleCard({ name, description, own, style, theme, checked, onPick }: { name: string; description: string; own?: boolean; style: DocumentStyle; theme: 'light' | 'dark'; checked: boolean; onPick: () => void }) {
  return (
    <label className="dc-look-card" data-own={own ? '' : undefined}>
      <input type="radio" name="style" className="dc-sr-only" aria-label={`${name}. ${description}`} checked={checked} onChange={onPick} />
      <span className="dc-look-card-picture">
        <StylePreview style={style} theme={theme} size="card" label={`${name}, drawn`} />
      </span>
      <span className="dc-look-card-foot">
        <span className="dc-look-card-text">
          <span className="dc-look-card-name">{name}</span>
          <span className="dc-look-card-description">{description}</span>
        </span>
        <span className="dc-look-card-check" aria-hidden="true">
          <Icon name="check" size={12} />
        </span>
      </span>
    </label>
  );
}

/** The name of one of the person's own styles, and the way to be rid of it. */
/** A style from a `.draftstyle` file, added to the person's own and put to use. */
function ImportStyle({ onImported }: { onImported: (hand: HandPreset) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const notify = useUiStore((state) => state.notify);
  const read = async (file: File | undefined) => {
    if (!file) return;
    let text: string;
    try {
      if (file.size > MAX_STYLE_FILE_BYTES) throw new Error('too large');
      text = await file.text();
    } catch {
      notify('That file is too large to be a style, or could not be read.', 'error');
      return;
    }
    const result = readStyleFile(text);
    if (!result.ok) {
      notify(result.error, 'error');
      return;
    }
    const id = useStyleStore.getState().add(result.name, result.style);
    if (!id) {
      notify(`This device keeps up to ${MAX_PROFILES} styles. Delete one to make another.`, 'error');
      return;
    }
    onImported(result.style.hand.base);
    notify(result.repairs.length > 0 ? `“${result.name}” is now your style. ${result.repairs.join(' ')}` : `“${result.name}” is now your style.`);
  };
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={`${STYLE_FILE_EXTENSION},application/json`}
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          void read(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      <button type="button" className="dc-look-card dc-look-card-add" onClick={() => input.current?.click()}>
        <span className="dc-look-card-picture" aria-hidden="true">
          <Icon name="upload" size={16} />
        </span>
        <span className="dc-look-card-foot">
          <span className="dc-look-card-text">
            <span className="dc-look-card-name">Import style…</span>
            <span className="dc-look-card-description">From a .draftstyle file</span>
          </span>
        </span>
      </button>
    </>
  );
}

function OwnStyle({ id, name, style, onRemoved }: { id: string; name: string; style: DocumentStyle; onRemoved: () => void }) {
  const [draft, setDraft] = useState(name);
  const commit = () => {
    if (draft.trim()) useStyleStore.getState().rename(id, draft);
    else setDraft(name);
  };
  return (
    <div className="dc-look-own">
      <label className="dc-look-own-name">
        <span className="dc-sr-only">Name</span>
        <Icon name="pencil" size={13} />
        <input
          type="text"
          value={draft}
          maxLength={STYLE_LIMITS.maxNameLength}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      </label>
      {/* One line, whatever the width: the name takes the room, the two things to do with it stay square. */}
      <Button
        variant="quiet"
        className="dc-prefs-outline dc-look-own-action"
        icon="export"
        aria-label="Export…"
        title="Export as a .draftstyle file"
        onClick={() => {
          // The desktop app asks where to save; choosing nowhere is a change of mind, not a failure.
          void downloadText(serializeStyleFile(name, style), styleFileName(name), STYLE_FILE_MIME).catch(() => {});
        }}
      />
      <Button
        variant="quiet"
        className="dc-prefs-outline dc-look-own-action"
        icon="trash"
        aria-label="Delete style"
        title="Delete this style"
        onClick={() => {
          useStyleStore.getState().remove(id);
          onRemoved();
        }}
      />
    </div>
  );
}

/** Line weight, corners and shadow: the three things a style says about any outline. */
function SurfaceRows({
  name,
  value,
  onChange,
  inherit,
  subject,
}: {
  name: string;
  value: SurfaceStyle | undefined;
  onChange: (value: SurfaceStyle | undefined) => void;
  /** What these fall back to when not set, named for the person. Absent at the top level. */
  inherit?: string;
  /** What these are about, when not every shape: it names each control. */
  subject?: string;
}) {
  const set = <K extends keyof SurfaceStyle>(key: K, next: SurfaceStyle[K] | undefined) => onChange(withField(value, key, next));
  const weights = inherit ? inheriting(WEIGHTS, inherit) : WEIGHTS;
  const corners = inherit ? inheriting(CORNERS, inherit) : CORNERS;
  const legend = (what: string) => (subject ? `${subject}: ${what.toLowerCase()}` : what);
  return (
    <>
      <SettingRow
        label="Line weight"
        control={
          inherit ? (
            <SegmentedControl
              name={`${name}-weight`}
              legend={legend('Line weight')}
              value={(value?.weight ?? INHERIT) as OrInherit<StyleWeight>}
              options={weights as { value: OrInherit<StyleWeight>; label: string }[]}
              onChange={(next) => set('weight', next === INHERIT ? undefined : next)}
            />
          ) : (
            <LookTiles name={`${name}-weight`} legend={legend('Line weight')} value={value?.weight ?? 'regular'} options={WEIGHT_TILES} onChange={(next) => set('weight', next === 'regular' ? undefined : next)} />
          )
        }
      />
      <SettingRow
        label="Corners"
        control={
          inherit ? (
            <SegmentedControl
              name={`${name}-corners`}
              legend={legend('Corners')}
              value={(value?.corners ?? INHERIT) as OrInherit<StyleCorners>}
              options={corners as { value: OrInherit<StyleCorners>; label: string }[]}
              onChange={(next) => set('corners', next === INHERIT ? undefined : next)}
            />
          ) : (
            <LookTiles name={`${name}-corners`} legend={legend('Corners')} value={value?.corners ?? 'soft'} options={CORNER_TILES} onChange={(next) => set('corners', next === 'soft' ? undefined : next)} />
          )
        }
      />
      {inherit ? (
        <SettingRow
          label="Shadow"
          control={
            <SegmentedControl
              name={`${name}-shadow`}
              legend={legend('Shadow')}
              value={value?.shadow === undefined ? INHERIT : value.shadow ? 'on' : 'off'}
              options={[
                { value: INHERIT, label: 'Same', name: `Same as ${inherit}` },
                { value: 'on', label: 'On' },
                { value: 'off', label: 'Off' },
              ]}
              onChange={(next) => set('shadow', next === INHERIT ? undefined : next === 'on')}
            />
          }
        />
      ) : (
        <ChoiceRow
          type="checkbox"
          toggle
          label="Shadows"
          description="A soft shadow under the shapes that stand for a piece of architecture."
          checked={value?.shadow !== false}
          onChange={(event) => set('shadow', event.target.checked ? undefined : false)}
        />
      )}
    </>
  );
}

function ConnectorRows({ value, onChange }: { value: ConnectorStyle | undefined; onChange: (value: ConnectorStyle | undefined) => void }) {
  const set = <K extends keyof ConnectorStyle>(key: K, next: ConnectorStyle[K] | undefined) => onChange(withField(value, key, next));
  return (
    <>
      <SettingRow
        label="Line weight"
        control={<LookTiles name="connector-weight" legend="Connector line weight" value={value?.weight ?? 'regular'} options={WEIGHT_TILES} onChange={(next) => set('weight', next === 'regular' ? undefined : next)} />}
      />
      <SettingRow
        label="Arrowhead"
        control={<LookTiles name="connector-head" legend="Arrowhead" value={value?.head ?? 'nib'} options={HEAD_TILES} onChange={(next) => set('head', next === 'nib' ? undefined : next)} />}
      />
      <SettingRow
        label="Colour"
        description="What a connector wears when nobody has coloured it."
        control={<LookTiles name="connector-colour" legend="Connector colour" value={value?.colour ?? 'source'} options={EDGE_COLOUR_TILES} onChange={(next) => set('colour', next === 'source' ? undefined : next)} />}
      />
    </>
  );
}

/** One shape at a time: pick it, then say what is different about it. Everything else stays inherited. */
function ShapesSection({ style, theme, edit }: { style: DocumentStyle; theme: 'light' | 'dark'; edit: (recipe: (style: DocumentStyle) => DocumentStyle) => void }) {
  const [type, setType] = useState<DraftNodeType>('service');
  const [kind, setKind] = useState<string>('');
  const kinds = STYLE_KINDS[type];
  const labels = KIND_LABELS[type] ?? {};
  const key = shapeKey(type, kind || undefined);
  const own = style.shapes?.[key];
  const start = useStyleStore((state) => state.starts[type]);
  const preview = useMemo(() => shapeOf(type, kind || undefined), [type, kind]);
  const name = NODE_TYPE_LABELS[type];
  const what = kind ? `${labels[kind] ?? kind} ${name.toLowerCase()}` : name.toLowerCase();

  const setShape = (next: ShapeStyle | undefined) =>
    edit((current) => {
      const shapes = { ...(current.shapes ?? {}) };
      if (next === undefined) delete shapes[key];
      else shapes[key] = next;
      return withOptional(current, 'shapes', Object.keys(shapes).length > 0 ? shapes : undefined);
    });

  return (
    <SettingsSection title="Shapes" description="Choose a shape to give it a look of its own. What you leave alone follows General.">
      <div className="dc-prefs-shapes" role="radiogroup" aria-label="Shape">
        {NODE_TYPES.map((entry) => (
          <label key={entry} className="dc-prefs-shape" data-styled={Object.keys(style.shapes ?? {}).some((styled) => styled === entry || styled.startsWith(`${entry}:`)) ? '' : undefined}>
            <input
              type="radio"
              name="style-shape"
              className="dc-sr-only"
              checked={type === entry}
              onChange={() => {
                setType(entry);
                setKind('');
              }}
            />
            <ShapePreview node={{ type: entry }} width={44} height={30} />
            {NODE_TYPE_LABELS[entry]}
          </label>
        ))}
      </div>

      <div className="dc-prefs-shape-editor">
        <div className="dc-prefs-shape-stage">
          <StylePreview style={style} theme={theme} shape={preview} label={`A ${what}, drawn in this style`} />
        </div>
        <div className="dc-prefs-rows">
          {kinds.length > 0 && (
            <SettingRow
              label="Kind"
              description={kind ? `Only the ${what}.` : `Every kind of ${name.toLowerCase()}.`}
              control={
                <select className="dc-select" aria-label={`Kind of ${name.toLowerCase()}`} value={kind} onChange={(event) => setKind(event.target.value)}>
                  <option value="">All kinds</option>
                  {kinds.map((entry) => (
                    <option key={entry} value={entry}>
                      {labels[entry] ?? entry}
                      {style.shapes?.[shapeKey(type, entry)] ? ' •' : ''}
                    </option>
                  ))}
                </select>
              }
            />
          )}
          <SurfaceRows name={`shape-${key}`} value={own} onChange={(next) => setShape({ ...(own?.art ? { art: own.art } : {}), ...(own?.fit ? { fit: own.fit } : {}), ...(own?.builtin ? { builtin: true } : {}), ...(next ?? {}) })} inherit={kind ? `every ${name.toLowerCase()}` : 'General'} subject={kind ? `${labels[kind] ?? kind} ${name.toLowerCase()}` : name} />
          <ShapeArtwork
            style={style}
            shapeKey={key}
            type={type}
            kind={kind || undefined}
            what={what}
            family={`every ${name.toLowerCase()}`}
            edit={edit}
            current={() => activeStyleOf(useStyleStore.getState(), style.hand.base)}
          />
          {start && (
            <SettingRow
              label={`New ${name.toLowerCase()} shapes start as you saved them`}
              description={[start.kind ? (labels[start.kind] ?? start.kind) : null, start.accent ? `${start.accent} colour` : null, start.frame ? `${start.frame}` : null].filter(Boolean).join(', ')}
              control={
                <Button variant="quiet" className="dc-prefs-outline" onClick={() => useStyleStore.getState().setStart(type, null)}>
                  Forget
                </Button>
              }
            />
          )}
          <SettingRow
            label={own ? `This ${what} has a look of its own` : `This ${what} follows ${kind ? `every ${name.toLowerCase()}` : 'General'}`}
            control={
              <Button variant="quiet" className="dc-prefs-outline" icon="refresh" disabled={!own} onClick={() => setShape(undefined)}>
                Reset
              </Button>
            }
          />
        </div>
      </div>
    </SettingsSection>
  );
}

/** The open diagram and this style: the only place a diagram's own look changes. */
/** Whether two styles draw the same picture: everything but what they are called. */
function sameLook(a: DocumentStyle, b: DocumentStyle): boolean {
  return JSON.stringify({ ...a, name: undefined }) === JSON.stringify({ ...b, name: undefined });
}

function DiagramSection({ style, documentOpen, onAdded }: { style: DocumentStyle; documentOpen: boolean; onAdded: (hand: HandPreset) => void }) {
  const readOnly = useUiStore((state) => Boolean(state.readOnly));
  const notify = useUiStore((state) => state.notify);
  const own = useEditorStore((state) => state.document.style);
  const profiles = useStyleStore((state) => state.profiles);
  if (readOnly) return null;
  if (!documentOpen) {
    return (
      <SettingsSection title="This diagram" description="A diagram’s own look, saved with it." apart>
        <p className="dc-prefs-empty">Open a diagram to give it this style.</p>
      </SettingsSection>
    );
  }
  const same = own !== undefined && sameLook(own, style);
  const known = own !== undefined && profiles.some((profile) => JSON.stringify(profile.style) === JSON.stringify(own));
  return (
    <SettingsSection
      title="This diagram"
      description={
        same
          ? 'Drawn in your style, saved with it, and following your changes here. It looks the same for everyone who opens it.'
          : own
          ? `Drawn in a style of its own${own.name ? `, “${own.name}”` : ''}, saved with it. Your changes here do not touch it.`
          : 'Has no style of its own, so everyone sees it in their own. Here that is yours.'
      }
      apart
    >
      <SettingRow
        label={own ? 'Use my style in this diagram' : 'Keep my style with this diagram'}
        description={
          same
            ? 'This diagram is already drawn in your style.'
            : own
            ? 'Replaces its look with yours, for everyone it is shared with. Undo brings the old look back.'
            : 'Saves your style into it, so it looks this way for everyone it is shared with.'
        }
        control={
          <Button
            variant="quiet"
            className="dc-prefs-outline"
            disabled={same}
            onClick={() => {
              useEditorStore.getState().setDocumentStyle(style);
              notify('This diagram is now drawn in your style.');
            }}
          >
            Use my style
          </Button>
        }
      />
      {own && !same && !known && (
        <SettingRow
          label="Keep this diagram’s style"
          description="Adds its look to your styles, to use in other diagrams."
          control={
            <Button
              variant="quiet"
              className="dc-prefs-outline"
              icon="plus"
              onClick={() => {
                const id = useStyleStore.getState().add(own.name ?? 'From a diagram', own);
                // It is now the style in use, so this device's drawing hand follows it.
                if (id) onAdded(own.hand.base);
                notify(id ? 'Added to your styles.' : `This device keeps up to ${MAX_PROFILES} styles. Delete one to make another.`, id ? 'info' : 'error');
              }}
            >
              Add to my styles
            </Button>
          }
        />
      )}
    </SettingsSection>
  );
}
