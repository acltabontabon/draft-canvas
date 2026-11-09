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
  const [preview, setPreview] = useState<Preview>(null);
  const [busy, setBusy] = useState(false);
  const [justDone, setJustDone] = useState<string | null>(null);
  const running = useRef(false);
  // The editor's level when the panel opened — read once per opening, so walking about afterwards
  // never changes which level would be published.
  const openedAt = useRef<string[]>([]);

  /* oxlint-disable react/set-state-in-effect -- each opening starts from the published picture, not the last opening's choices. */
  useEffect(() => {
    if (!active) return;
    openedAt.current = [...startPath];
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
      return;
    }
    let cancelled = false;
    setLoading(true);
    void controller
      .docsStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, controller, handleKey]);
  /* oxlint-enable react/set-state-in-effect */

  // The level the editor was showing when the panel opened: each level has its own picture, so
  // opening inside a shape is how the person says which one they mean.
  const fallbackView = file && levelExists(file, openedAt.current) ? openedAt.current : [];
  const viewKey = chosenView ?? fallbackView.join('/');
  const view = useMemo(() => (viewKey ? viewKey.split('/') : []), [viewKey]);
  const stem = desktopFile?.name ?? '';
  const images = status?.images;
  const mine = useMemo(() => (images && stem ? picturesOf(images, stem) : []), [images, stem]);
  const picture = file && images && desktopFile ? pictureFor(images, file, stem, view) : null;
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

  /* oxlint-disable react/set-state-in-effect -- the preview is drawn off the render path; it loads icons and the background. */
  useEffect(() => {
    if (!active || !file) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    void renderDocsImage(file, sourceName, settings)
      .then((rendered) => {
        if (!cancelled) setPreview(rendered.ok ? { svg: rendered.svg, width: rendered.width, height: rendered.height } : 'missing');
      })
      .catch(() => {
        if (!cancelled) setPreview('missing');
      });
    return () => {
      cancelled = true;
    };
  }, [active, file, sourceName, settings]);
  /* oxlint-enable react/set-state-in-effect */

  if (!active || !file) return null;

  const levelKey = (path: readonly string[]) => path.join('/');
  const publishedKeys = new Set(mine.map((entry) => levelKey(entry.marker.settings.view)));
  const levels = docsLevels(file).map((level) => ({ ...level, published: publishedKeys.has(levelKey(level.path)) }));
  const orphans = mine.filter((entry) => !levelExists(file, entry.marker.settings.view)).map((entry) => entry.name);
  const title = docsTitleFor(file, view);
  const current = picture?.state === 'ours' && preview !== null && preview !== 'missing' && picture.svg === preview.svg;
  // Until both the shell's answer and the preview are in, "current" can't be judged: saying "Out of
  // date" and offering Update for that moment flipped the button under the pointer.
  const checking = !!desktopFile && (preview === null || (loading && !status));
  const unapplied = !!published && !current && !sameSettings(published, settings);
  const foreign = picture?.state === 'taken';
  // From the Markdown file when one is chosen; else from beside the diagram (desktop) or from the
  // folder the download is unpacked next to (web) — always a path that is true where it says it is.
  const fromMarkdown = markdown ? (markdown.imageDir ? `${markdown.imageDir}/${imageName}` : imageName) : null;
  const imagePath = fromMarkdown ?? (desktopFile ? imageName : (names?.imagePath ?? ''));
  const snippet = markdownImage(title, imagePath);
  const alreadyIn = markdown && fromMarkdown ? referencesTo(markdown.text, fromMarkdown) > 0 : false;
  const headings = markdown ? headingsOf(markdown.text) : [];
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
    const result = await controller.publishDocs(settings, imageName);
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
      disabled: busy || preview === 'missing',
      run: () =>
        guarded(async () => {
          await downloadDocsBundle(file, settings);
          // The dialog stays open: pasting the Markdown line is the next step, and it's right here.
          setJustDone(`Downloaded ${names?.archive}`);
        }, 'Download'),
    };
  } else if (foreign) {
    primary = { label: `${imageName} is taken`, busyLabel: '', disabled: true, run: async () => {} };
  } else if (checking) {
    primary = { label: 'Checking…', busyLabel: '', disabled: true, run: async () => {} };
  } else if (markdown && insertion) {
    const md = markdown;
    primary = {
      label: `Add to ${md.name}`,
      busyLabel: 'Adding…',
      disabled: busy || loading || preview === 'missing',
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
      disabled: busy || loading || preview === 'missing',
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
      setJustDone(null);
    },
    orphans,
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

