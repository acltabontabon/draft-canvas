import { useEffect, useMemo, useRef, useState } from 'react';
import type { DraftDocument } from '../../document/types';
import type { ThemeName } from '../../render/theme/tokens';
import type { PersonalityPreset } from '../../theme/usePersonality';
import { docsLevels, docsTitleFor, levelExists, renderDocsImage } from '../../export/docs/image';
import { readMarker, type DocsSettings } from '../../export/docs/marker';
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
  levels: { path: string[]; label: string }[];
  viewKey: string;
  setView: (key: string) => void;
  /** The published level is gone; the picture would show another one. */
  lostView: boolean;
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
  sync: boolean;
  setSync: (sync: boolean) => void;
  status: DocsStatus | null;
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
 * picture beside its file (as the shell describes it), and the person's few choices this time.
 *
 * Once a picture is published its own note is the starting point (its level, look and whether it
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

  const marker = status?.state === 'ours' && status.svg ? readMarker(status.svg) : null;
  const published = marker?.settings;
  const lostView = !!file && !!published && !levelExists(file, published.view);
  const fallbackView = file && levelExists(file, openedAt.current) ? openedAt.current : [];
  const viewKey = chosenView ?? (published && !lostView ? published.view.join('/') : fallbackView.join('/'));
  const view = useMemo(() => (viewKey ? viewKey.split('/') : []), [viewKey]);
  const theme = chosenTheme ?? published?.theme ?? readThemePreference();
  const sync = chosenSync ?? published?.sync ?? readSyncPreference();
  // The look a published picture was drawn in stays its look: the app's own personality setting is
  // a preference about the canvas, and changing it shouldn't quietly restyle a README.
  const style = published?.style ?? preset;
  const target: DocsPublishing['target'] = desktopFile ? { kind: 'file', name: desktopFile.name, dirty: desktopFile.dirty } : { kind: 'bundle' };
  const names = file ? bundleNames(file) : null;
  const sourceName = desktopFile ? `${desktopFile.name}.draftcanvas` : (names?.source ?? '');
  const imageName = desktopFile ? (status?.imageName ?? `${desktopFile.name}.svg`) : (names?.image ?? '');
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

  const levels = docsLevels(file);
  const title = docsTitleFor(file, view);
  const current = status?.state === 'ours' && preview !== null && preview !== 'missing' && status.svg === preview.svg;
  // From the Markdown file when one is chosen; else from beside the diagram (desktop) or from the
  // folder the download is unpacked next to (web) — always a path that is true where it says it is.
  const imagePath = markdown ? markdown.imagePath : desktopFile ? imageName : (names?.imagePath ?? '');
  const snippet = markdownImage(title, imagePath);
  const alreadyIn = markdown ? referencesTo(markdown.text, markdown.imagePath) > 0 : false;
  const headings = markdown ? headingsOf(markdown.text) : [];
  const placement = chosenPlacement ?? defaultPlacement(headings);
  const insertion = markdown && !alreadyIn ? insertImage(markdown.text, placement, snippet) : null;
  // Where it goes, or — once it is there — where it already is.
  const shownAt = markdown && !insertion ? referenceLine(markdown.text, markdown.imagePath) : -1;
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
    const result = await controller.publishDocs(settings);
    await refreshStatus();
    setJustDone(result.outcome === 'written' ? `Published ${result.imageName}` : `${result.imageName} is already current`);
    return true;
  };

  const chooseMarkdown = controller && desktopFile
    ? () =>
        guarded(async () => {
          const picked = await controller.pickDocsMarkdown();
          if (!picked) return;
          setMarkdown(picked);
          setChosenPlacement(null);
          setJustDone(null);
        }, 'Choosing a Markdown file')
    : null;

  const reveal = controller && status?.state === 'ours' ? () => guarded(() => controller.revealDocsImage(), 'Showing the file') : null;

  let primary: DocsAction;
  if (!desktopFile) {
    primary = {
      label: 'Download for docs',
      busyLabel: 'Preparing…',
      disabled: busy || preview === 'missing',
      run: () =>
        guarded(async () => {
          await downloadDocsBundle(file, settings);
          notify(`Downloaded ${names?.archive}. Unzip it next to your Markdown file.`);
          onFinished();
        }, 'Download'),
    };
  } else if (status?.state === 'foreign') {
    primary = { label: `${imageName} is taken`, busyLabel: '', disabled: true, run: async () => {} };
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
    const update = status?.state === 'ours';
    primary = {
      label: update ? `Update ${imageName}` : 'Publish image',
      busyLabel: target.kind === 'file' && target.dirty ? 'Saving…' : 'Publishing…',
      disabled: busy || loading || preview === 'missing',
      run: () => guarded(async () => void (await publish()), update ? 'Update' : 'Publish'),
    };
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
    lostView,
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
    status,
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
    canCopy: !desktopFile || status?.state === 'ours',
    chooseMarkdown,
    reveal,
  };
}

