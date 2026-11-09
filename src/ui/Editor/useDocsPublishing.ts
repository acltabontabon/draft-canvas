import { useEffect, useMemo, useRef, useState } from 'react';
import type { DraftDocument } from '../../document/types';
import type { ThemeName } from '../../render/theme/tokens';
import type { PersonalityPreset } from '../../theme/usePersonality';
import { docsLevels, docsTitleFor, levelExists, renderDocsImage } from '../../export/docs/image';
import { sameSettings, type DocsSettings } from '../../export/docs/marker';
import { levelImageNames, pictureFor, picturesOf, type LevelPicture } from '../../export/docs/names';
import { defaultPlacement, excerptAround, headingsOf, insertImage, markdownImage, referenceLine, referencesTo, type ExcerptLine, type Placement } from '../../export/docs/markdown';
import { bundleNames, downloadDocsBundle } from '../../export/docs/bundle';
import { readPreference, writePreference } from '../../lib/preferences';
import { hostKind } from '../../host/hostInfo';
import { getDesktopController, useDesktopState } from '../../desktop/useDesktop';
import type { DocsStatus, MarkdownFile } from '../../desktop/api';

const THEME_PREFERENCE = 'docs-theme';
const SYNC_PREFERENCE = 'docs-sync';

/** A README is white for most readers, and a light picture reads on a dark page too: it's a card. */
function readThemePreference(): ThemeName {
  return readPreference(THEME_PREFERENCE) === 'dark' ? 'dark' : 'light';
}

function readSyncPreference(): boolean {
  return readPreference(SYNC_PREFERENCE) !== 'off';
}

/** The section holding the first of `names` the Markdown file already shows, as a placement. */
function siblingSection(markdown: MarkdownFile, names: readonly string[], headings: ReturnType<typeof headingsOf>): Placement | null {
  for (const name of names) {
    const at = referenceLine(markdown.text, markdown.imageDir ? `${markdown.imageDir}/${name}` : name);
    if (at < 0) continue;
    const heading = headings.filter((entry) => entry.line < at).at(-1);
    return heading ? { kind: 'section', line: heading.line } : { kind: 'end' };
  }
  return null;
}

export type Preview = { svg: string; width: number; height: number } | 'missing' | null;

export interface DocsAction {
  label: string;
  busyLabel: string;
  disabled: boolean;
  run: () => Promise<void>;
}

export interface DocsPublishing {
  /** Where the picture goes: beside the open file (desktop), or into a download (web, or no file yet). */
  target: { kind: 'file'; name: string; dirty: boolean } | { kind: 'bundle' };
  /** Every level, and whether it already has a picture beside the file. */
  levels: { path: string[]; label: string; published: boolean }[];
  viewKey: string;
  setView: (key: string) => void;
  /** Pictures of this diagram whose level is gone: they stay as they were, and saves pass them by. */
  orphans: string[];
  /** The folder beside the diagram couldn't be read, so nothing can be published safely. */
  statusFailed: boolean;
  /** On the desktop with no file yet: publishing beside it waits for a save. */
  draftOnDesktop: boolean;
  /** Not settled yet: the shell's answer or the preview it is compared with is still on its way. */
  checking: boolean;
  /** The panel's choices (level, look, redraw) differ from the published picture's; Update applies them. */
  unapplied: boolean;
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
  sync: boolean;
  setSync: (sync: boolean) => void;
  /** The chosen level's picture beside the file (desktop with a file only). */
  picture: LevelPicture | null;
  loading: boolean;
  imageName: string;
  sourceName: string;
  /** Exactly the bytes on disk, for a published picture. */
  current: boolean;
  preview: Preview;
  title: string;
  snippet: string;
  markdown: MarkdownFile | null;
  alreadyIn: boolean;
  /** The chosen Markdown file's headings, read once. */
  headings: ReturnType<typeof headingsOf>;
  placement: Placement;
  setPlacement: (placement: Placement) => void;
  /** The Markdown around the picture: where it will be added, or where it already is. */
  excerpt: { lines: ExcerptLine[]; added: boolean } | null;
  justDone: string | null;
  busy: boolean;
  primary: DocsAction;
  copyText: string;
  /**
   * Whether the Markdown is true right now: on the desktop the picture has to be there first — a
   * path to a file that doesn't exist yet, or to someone else's SVG, is exactly what not to copy.
   */
  canCopy: boolean;
  chooseMarkdown: (() => Promise<void>) | null;
  reveal: (() => Promise<void>) | null;
}

/**
 * Use in docs: everything the panel shows and does, derived from three things — the diagram, the
 * pictures beside its file (as the shell describes them), and the person's few choices this time.
 *
 * Each level has its own picture (`names.ts`). The panel opens on the level the editor is showing;
 * once that level is published its picture's note is the starting point (its look and whether it
 * follows saves), so reopening reads as "here is your published diagram", not a fresh export.
 * Choices made in the panel are kept only until it closes; the look and the follow-saves default are
 * remembered as preferences, never as hidden state about a file.
 */
export function useDocsPublishing({
  active,
  file,
  startPath,
  preset,
  notify,
  onFinished,
}: {
  active: boolean;
  file: DraftDocument | null;
  startPath: readonly string[];
  preset: PersonalityPreset;
  notify: (message: string, tone?: 'info' | 'error') => void;
  onFinished: () => void;
}): DocsPublishing | null {
  const onDesktop = __DESKTOP__ && hostKind() === 'desktop';
  // Re-rendered by saves and file switches, so `dirty` and the file name stay true.
  const desktop = useDesktopState();
  const controller = onDesktop ? getDesktopController() : null;
  const desktopFile = controller && desktop.doc.kind === 'file' ? controller.docsFile() : null;
  const handleKey = desktopFile?.handle ?? '';

  const [chosenView, setChosenView] = useState<string | null>(null);
  const [chosenTheme, setChosenTheme] = useState<ThemeName | null>(null);
  const [chosenSync, setChosenSync] = useState<boolean | null>(null);
  const [status, setStatus] = useState<DocsStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [markdown, setMarkdown] = useState<MarkdownFile | null>(null);
  const [chosenPlacement, setChosenPlacement] = useState<Placement | null>(null);
  // The preview, and the settings it was drawn with: one drawn for other settings is still shown
  // while the next is drawn, but never judged against the picture on disk.
  const [drawn, setDrawn] = useState<{ key: string; preview: Preview } | null>(null);
  const [busy, setBusy] = useState(false);
  const [justDone, setJustDone] = useState<string | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  // Bumped to look at the pictures again: after a save's redraw wrote them, say.
  const [statusTick, setStatusTick] = useState(0);
  const running = useRef(false);
  // The editor's level when the panel opened — read once per opening, so walking about afterwards
  // never changes which level would be published. Null until this opening has been set up, so
  // nothing is drawn for the last opening's level first.
  const [openedAt, setOpenedAt] = useState<string[] | null>(null);

  /* oxlint-disable react/set-state-in-effect -- each opening starts from the published picture, not the last opening's choices. */
  useEffect(() => {
    if (!active) {
      setOpenedAt(null);
      return;
    }
    setOpenedAt([...startPath]);
    setChosenView(null);
    setChosenTheme(null);
    setChosenSync(null);
    setMarkdown(null);
    setChosenPlacement(null);
    setJustDone(null);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `startPath` is sampled at opening only.
  }, [active, handleKey]);

  useEffect(() => {
    if (!active || !controller || !handleKey) {
      setStatus(null);
      setStatusFailed(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void controller
      .docsStatus()
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        setStatusFailed(false);
      })
      .catch(() => {
        // Without the listing there is no telling which names are free: nothing is published.
        if (cancelled) return;
        setStatus(null);
        setStatusFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, controller, handleKey, statusTick]);
  /* oxlint-enable react/set-state-in-effect */

  // A save's redraw (yours or an agent's) rewrites pictures while the tab is open: look again, so
  // "current" is judged against what is on disk now.
  useEffect(() => {
    if (!active || !controller || !handleKey) return;
    return controller.onDocsWritten((handle) => {
      if (handle === handleKey) setStatusTick((tick) => tick + 1);
    });
  }, [active, controller, handleKey]);

  const headings = useMemo(() => (markdown ? headingsOf(markdown.text) : []), [markdown]);

  // The level the editor was showing when the panel opened: each level has its own picture, so
  // opening inside a shape is how the person says which one they mean.
  const fallbackView = file && openedAt && levelExists(file, openedAt) ? openedAt : [];
  const viewKey = chosenView ?? fallbackView.join('/');
  const view = useMemo(() => (viewKey ? viewKey.split('/') : []), [viewKey]);
  const stem = desktopFile?.name ?? '';
  const images = status?.images;
  const mine = useMemo(() => (images && stem ? picturesOf(images, stem) : []), [images, stem]);
  const picture = file && images && desktopFile ? pictureFor(images, file, stem, view, mine) : null;
  const published = picture?.state === 'ours' ? picture.marker.settings : undefined;
  const theme = chosenTheme ?? published?.theme ?? readThemePreference();
  const sync = chosenSync ?? published?.sync ?? readSyncPreference();
  // The look a published picture was drawn in stays its look: the app's own personality setting is
  // a preference about the canvas, and changing it shouldn't quietly restyle a README.
  const style = published?.style ?? preset;
  const target: DocsPublishing['target'] = desktopFile ? { kind: 'file', name: desktopFile.name, dirty: desktopFile.dirty } : { kind: 'bundle' };
  const names = file ? bundleNames(file, view) : null;
  const sourceName = desktopFile ? `${desktopFile.name}.draftcanvas` : (names?.source ?? '');
  const imageName = desktopFile ? (picture?.name ?? (file ? levelImageNames(file, stem, view)[0]! : `${stem}.svg`)) : (names?.image ?? '');
  // A download has no file to follow, so it is always a snapshot.
  const follows = desktopFile ? sync : false;
  const settings: DocsSettings = useMemo(() => ({ view, theme, style, sync: follows }), [view, theme, style, follows]);
  const drawKey = `${sourceName}\u0000${JSON.stringify(settings)}`;
  const ready = active && !!file && openedAt !== null;

  /* oxlint-disable react/set-state-in-effect -- the preview is drawn off the render path; it loads icons and the background. */
  useEffect(() => {
    if (!ready || !file) {
      if (!active) setDrawn(null);
      return;
    }
    let cancelled = false;
    void renderDocsImage(file, sourceName, settings)
      .then((rendered) => {
        if (!cancelled) setDrawn({ key: drawKey, preview: rendered.ok ? { svg: rendered.svg, width: rendered.width, height: rendered.height } : 'missing' });
      })
      .catch(() => {
        if (!cancelled) setDrawn({ key: drawKey, preview: 'missing' });
      });
    return () => {
      cancelled = true;
    };
  }, [ready, active, file, sourceName, settings, drawKey]);
  /* oxlint-enable react/set-state-in-effect */

  if (!active || !file) return null;

  // What is shown, and what may be judged: only a preview of exactly these settings says whether
  // the picture on disk is current.
  const preview: Preview = drawn?.preview ?? null;
  const judged: Preview = drawn && drawn.key === drawKey ? drawn.preview : null;

  const levelKey = (path: readonly string[]) => path.join('/');
  const publishedKeys = new Set(mine.map((entry) => levelKey(entry.marker.settings.view)));
  const levels = docsLevels(file).map((level) => ({ ...level, published: publishedKeys.has(levelKey(level.path)) }));
  const orphans = mine.filter((entry) => !levelExists(file, entry.marker.settings.view)).map((entry) => entry.name);
  const title = docsTitleFor(file, view);
  const current = picture?.state === 'ours' && judged !== null && judged !== 'missing' && picture.svg === judged.svg;
  // Until both the shell's answer and the preview are in, "current" can't be judged: saying "Out of
  // date" and offering Update for that moment flipped the button under the pointer.
  const checking = !!desktopFile && !statusFailed && (judged === null || (loading && !status));
  const unapplied = !!published && !current && !sameSettings(published, settings);
  const foreign = picture?.state === 'taken';
  // From the Markdown file when one is chosen; else from beside the diagram (desktop) or from the
  // folder the download is unpacked next to (web) — always a path that is true where it says it is.
  const fromMarkdown = markdown ? (markdown.imageDir ? `${markdown.imageDir}/${imageName}` : imageName) : null;
  const imagePath = fromMarkdown ?? (desktopFile ? imageName : (names?.imagePath ?? ''));
  const snippet = markdownImage(title, imagePath);
  const alreadyIn = markdown && fromMarkdown ? referencesTo(markdown.text, fromMarkdown) > 0 : false;
  // Another level of this diagram already on the page: this one goes in the same section, so a
  // context view and its containers read together. Else the usual guess.
  const besideSibling = markdown ? siblingSection(markdown, mine.map((entry) => entry.name).filter((name) => name !== imageName), headings) : null;
  const placement = chosenPlacement ?? besideSibling ?? defaultPlacement(headings);
  const insertion = markdown && !alreadyIn ? insertImage(markdown.text, placement, snippet) : null;
  // Where it goes, or — once it is there — where it already is.
  const shownAt = markdown && fromMarkdown && !insertion ? referenceLine(markdown.text, fromMarkdown) : -1;
  const excerpt = insertion
    ? { lines: excerptAround(insertion.text, insertion.line), added: true }
    : markdown && shownAt >= 0
      ? { lines: excerptAround(markdown.text, shownAt), added: false }
      : null;

  const guarded = async (work: () => Promise<void>, what: string) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      notify(error instanceof Error ? `${what} failed: ${error.message}` : `${what} failed.`, 'error');
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const refreshStatus = async () => {
    if (controller) setStatus(await controller.docsStatus());
  };

  const publish = async (): Promise<boolean> => {
    if (!controller) return false;
    if (current) return true;
    const result = await controller.publishDocs(settings, imageName, picture?.state === 'none');
    await refreshStatus();
    setJustDone(result.outcome === 'written' ? `Published ${result.imageName}` : `${result.imageName} is already current`);
    return true;
  };

  // A taken name can't be published, so there is nothing to add to a Markdown file either.
  const chooseMarkdown = controller && desktopFile && !foreign
    ? () =>
        guarded(async () => {
          const picked = await controller.pickDocsMarkdown();
          if (!picked) return;
          setMarkdown(picked);
          setChosenPlacement(null);
          setJustDone(null);
        }, 'Choosing a Markdown file')
    : null;

  const reveal = controller && picture?.state === 'ours' ? () => guarded(() => controller.revealDocsImage(picture.name), 'Showing the file') : null;

  let primary: DocsAction;
  if (!desktopFile) {
    primary = {
      label: 'Download for docs',
      busyLabel: 'Preparing…',
      disabled: busy || judged === 'missing',
      run: () =>
        guarded(async () => {
          await downloadDocsBundle(file, settings);
          // The dialog stays open: pasting the Markdown line is the next step, and it's right here.
          setJustDone(`Downloaded ${names?.archive}`);
        }, 'Download'),
    };
  } else if (statusFailed) {
    primary = { label: 'Publish image', busyLabel: '', disabled: true, run: async () => {} };
  } else if (foreign) {
    primary = { label: `${imageName} is taken`, busyLabel: '', disabled: true, run: async () => {} };
  } else if (checking) {
    primary = { label: 'Checking…', busyLabel: '', disabled: true, run: async () => {} };
  } else if (markdown && insertion) {
    const md = markdown;
    primary = {
      label: `Add to ${md.name}`,
      busyLabel: 'Adding…',
      disabled: busy || loading || judged === 'missing',
      run: () =>
        guarded(async () => {
          await publish();
          const result = await controller!.addToMarkdown(md.handle, insertion.text, md.stamp);
          if (result.outcome === 'conflict') {
            setMarkdown(null);
            notify(`${md.name} changed since you chose it, so nothing was added. Choose it again to see it as it is now.`, 'error');
            return;
          }
          setMarkdown({ ...md, text: insertion.text, stamp: result.stamp });
          setJustDone(`Added to ${md.name}`);
        }, `Adding to ${md.name}`),
    };
  } else if (!current) {
    const update = picture?.state === 'ours';
    primary = {
      label: update ? `Update ${imageName}` : 'Publish image',
      busyLabel: target.kind === 'file' && target.dirty ? 'Saving…' : 'Publishing…',
      disabled: busy || loading || judged === 'missing',
      run: () => guarded(async () => void (await publish()), update ? 'Update' : 'Publish'),
    };
  } else if (markdown && alreadyIn) {
    // Published, current and on the page: nothing left to do here.
    primary = { label: 'Done', busyLabel: '', disabled: busy, run: async () => onFinished() };
  } else {
    primary = {
      label: 'Add to a Markdown file…',
      busyLabel: 'Choosing…',
      disabled: busy || !chooseMarkdown,
      run: async () => chooseMarkdown?.(),
    };
  }

  return {
    target,
    levels,
    viewKey,
    setView: (key) => {
      setChosenView(key);
      // Each level is its own picture with its own look: a choice made for the last one isn't this one's.
      setChosenTheme(null);
      setChosenSync(null);
      setJustDone(null);
    },
    orphans,
    statusFailed,
    draftOnDesktop: onDesktop && !desktopFile,
    checking,
    unapplied,
    theme,
    setTheme: (next) => {
      setChosenTheme(next);
      writePreference(THEME_PREFERENCE, next);
      setJustDone(null);
    },
    sync,
    setSync: (next) => {
      setChosenSync(next);
      writePreference(SYNC_PREFERENCE, next ? 'on' : 'off');
      setJustDone(null);
    },
    picture,
    loading,
    imageName,
    sourceName,
    current,
    preview,
    title,
    snippet,
    markdown,
    alreadyIn,
    headings,
    placement,
    setPlacement: setChosenPlacement,
    excerpt,
    justDone,
    busy,
    primary,
    copyText: snippet,
    canCopy: !desktopFile || picture?.state === 'ours',
    chooseMarkdown,
    reveal,
  };
}

