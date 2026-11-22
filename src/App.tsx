import { Suspense, useEffect } from 'react';
import { currentDesktopHost, hostKind, returnHome } from './host/hostInfo';
import { useHostDocument } from './host/useHostDocument';
import { useDocumentSession } from './store/useDocumentSession';
import { LibraryScreen } from './ui/Library/LibraryScreen';
import { useHandoffReceiver } from './ui/Library/useHandoffReceiver';
import { DrawingLoader } from './ui/common/DrawingLoader';
import { ErrorBoundary } from './ui/common/ErrorBoundary';
import { PanelBoundary } from './ui/common/PanelBoundary';
import { retryableLazy } from './ui/common/retryableLazy';
import { loadFailureNotice } from './lib/staleChunk';
import { Toasts } from './ui/common/Toasts';
import { DiagnosticsDialog } from './ui/common/DiagnosticsDialog';
import { LiveAnnouncer } from './ui/common/LiveAnnouncer';
import { ThemeProvider } from './ui/theme/ThemeProvider';
import { PersonalityProvider } from './ui/personality/PersonalityProvider';
import { logDiagnostic } from './lib/diagnostics';
import { reloadApp } from './lib/serviceWorker';
import { retirePreferences } from './lib/preferences';
import { clearJoinFragment, joinPayloadFromHash } from './lib/joinFragment';
import { useUiStore } from './store/uiStore';
import { SharedUnlockScreen } from './ui/Editor/SharedUnlockScreen';

// The editor is most of the app's code, and the Library is what every visit opens on — so the
// editor arrives as its own chunk (React Flow included), fetched in the background once the Library
// is up (see `Shell`) so opening a canvas never waits on the network. The offline Service Worker
// precaches it either way.
const loadEditor = () => import('./ui/Editor/EditorScreen');
// Only for a page opened from an invite link: the collaboration code stays out of everyone else's load.
const JoinChunk = retryableLazy(() => import('./ui/collab/JoinDialog').then((module) => ({ default: module.JoinDialog })));
// Retryable: `lazy()` alone remembers a failed fetch for good, so after one offline open (or a deploy
// that replaced the chunk under an old tab) every later open would crash the same way.
const EditorChunk = retryableLazy(() => loadEditor().then((module) => ({ default: module.EditorRoute })));
// About (and every release's notes with it) is opened now and then, from Home or the editor — fetched
// the first time, so neither screen's first chunk carries it.
const AboutChunk = retryableLazy(() => import('./ui/common/AboutDialog').then((module) => ({ default: module.AboutDialog })));
// The shortcuts sheet lists the editor's commands, so it comes with their code. It is mounted here,
// not in the editor: the desktop Help menu can ask for it on Home, and a sheet that only the editor
// drew stayed queued there and opened over the next canvas instead.
const ShortcutsChunk = retryableLazy(() => import('./ui/Editor/ShortcutSheet').then((module) => ({ default: module.ShortcutSheet })));
// The desktop app's Home takes the Library's place. `__DESKTOP__` is false in the web build, which
// drops this — and everything under src/desktop/ — from it.
const DesktopHomeChunk = __DESKTOP__
  ? retryableLazy(() => import('./desktop/ui/DesktopHome').then((module) => ({ default: module.DesktopHome })))
  : null;
const DesktopSettingsChunk = __DESKTOP__
  ? retryableLazy(() => import('./desktop/ui/settings/SettingsDialog').then((module) => ({ default: module.DesktopSettings })))
  : null;
// What AI agents are doing — the status line and the generation view. Renders nothing while idle.
const AgentActivityChunk = __DESKTOP__
  ? retryableLazy(() => import('./desktop/ui/AgentActivity').then((module) => ({ default: module.AgentActivity })))
  : null;

function LazyAboutDialog() {
  const open = useUiStore((state) => state.aboutOpen);
  if (!open) return null;
  return (
    <PanelBoundary
      onError={panelFailed('about-panel', AboutChunk, 'About couldn’t open. Check your connection and try again.', () =>
        useUiStore.getState().setAboutOpen(false),
      )}
    >
      <Suspense fallback={null}>
        <AboutChunk.Component />
      </Suspense>
    </PanelBoundary>
  );
}

function LazyShortcutSheet() {
  const open = useUiStore((state) => state.shortcutsOpen);
  if (!open) return null;
  return (
    <PanelBoundary
      onError={panelFailed('shortcuts-panel', ShortcutsChunk, 'Keyboard shortcuts couldn’t open. Check your connection and try again.', () =>
        useUiStore.getState().setShortcutsOpen(false),
      )}
    >
      <Suspense fallback={null}>
        <ShortcutsChunk.Component />
      </Suspense>
    </PanelBoundary>
  );
}

/**
 * What a panel mounted beside the screens does when its chunk, or its own render, fails: says so,
 * closes, and stays out of the way. The invite, Settings and agent-activity panels once sat outside
 * every boundary, so one that could not be fetched (an invite link opened in a tab a deploy had left
 * behind) took the whole app down to a blank page.
 */
function panelFailed(operation: string, chunk: { reset: () => void }, message: string, close?: () => void) {
  return (error: Error, componentStack: string) => {
    logDiagnostic(error, { operation }, componentStack);
    chunk.reset();
    close?.();
    const notice = loadFailureNotice(error, message);
    useUiStore.getState().notify(notice.message, 'error', notice.action);
  };
}

/**
 * There is no router.
 *
 * The library and the editor are two states of one screen, which keeps the app
 * deployable under any path — /workbench/draft-canvas or anywhere else — with
 * no base-path configuration and no server rewrite rules.
 */
function Shell() {
  const session = useDocumentSession();
  const host = useHostDocument(session, currentDesktopHost()?.channel);
  // Diagrams arriving from the editor's old address, when it opened this tab to send them.
  useHandoffReceiver(session);
  // "Try an example" and a gallery starter's "Open as new diagram": a canvas made the way this host
  // makes one — a Quick Draft on desktop, a Library document on the web.
  const newCanvasRequest = useUiStore((state) => state.newCanvasRequest);
  useEffect(() => {
    if (!newCanvasRequest) return;
    useUiStore.setState({ newCanvasRequest: null });
    const starter = newCanvasRequest.kind === 'example' ? 'example' as const : newCanvasRequest.document;
    if (__DESKTOP__ && hostKind() === 'desktop') {
      void import('./desktop/useDesktop').then(({ getDesktopController }) => getDesktopController().newQuickDraft(starter));
    } else {
      void session.replaceWithNew(starter);
    }
  }, [newCanvasRequest, session]);

  // An invite link (`#join=…`): read once, taken off the address, and offered as a dialog. The web
  // app only — an invite opens in a browser, never in the desktop app's own window.
  const joinInvite = useUiStore((state) => state.joinInvite);
  useEffect(() => {
    if (hostKind()) return;
    const arrive = () => {
      const payload = joinPayloadFromHash(window.location.hash);
      if (payload === null) return;
      clearJoinFragment();
      useUiStore.getState().setJoinInvite(payload);
    };
    arrive();
    window.addEventListener('hashchange', arrive);
    return () => window.removeEventListener('hashchange', arrive);
  }, []);

  // Keys older builds left behind (a pinned theme, the old Learn mode's hints) — see
  // `RETIRED_PREFERENCE_KEYS`. Documents are never touched: they live in IndexedDB.
  useEffect(() => retirePreferences(), []);

  useEffect(() => {
    // Only a head start: a failed fetch here is retried when the editor is opened.
    const warm = () => void loadEditor().catch(() => {});
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(warm, { timeout: 2000 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(warm, 500);
    return () => clearTimeout(id);
  }, []);

  return (
    <>
      <ErrorBoundary
        message="Something went wrong."
        // Leaving the canvas that crashed shows Home again, instead of this message staying up.
        resetKey={session.openId}
        actions={[
          ...(session.openId ? [{ label: 'Return home', onClick: () => returnHome(session.closeDocument) }] : []),
          // Activates a waiting update first — a crash caused by a stale chunk must not reload into itself.
          { label: 'Reload app', onClick: reloadApp },
        ]}
        onError={(error, componentStack) => {
          EditorChunk.reset();
          logDiagnostic(error, { operation: 'app-shell', documentId: session.openId }, componentStack);
        }}
      >
        {session.sharedLink?.locked ? (
          <SharedUnlockScreen link={session.sharedLink} ready={session.ready} />
        ) : session.openId ? (
          <Suspense fallback={<DrawingLoader />}>
            <EditorChunk.Component session={session} />
          </Suspense>
        ) : hostKind() === 'desktop' && DesktopHomeChunk ? (
          <Suspense fallback={<DrawingLoader />}>
            <DesktopHomeChunk.Component />
          </Suspense>
        ) : (
          <LibraryScreen session={session} />
        )}
      </ErrorBoundary>
      {host.invalidWhileOpen && session.openId && (
        <p className="dc-host-invalid" role="alert">
          The file’s text isn’t a valid diagram right now. The canvas shows its last valid version and won’t
          change the file until the text is fixed.
        </p>
      )}
      {joinInvite !== null && (
        // Keyed by the invite: a second link opened over the dialog starts a dialog of its own, and the
        // first one's attempt is cancelled as it unmounts — not finished under the second's name. The
        // boundary is keyed with it, so a link that failed once is tried afresh when opened again.
        <PanelBoundary
          key={joinInvite}
          onError={panelFailed('join-panel', JoinChunk, 'The invitation couldn’t open. Check your connection and open the link again.', () =>
            useUiStore.getState().setJoinInvite(null),
          )}
        >
          <Suspense fallback={null}>
            <JoinChunk.Component session={session} invite={joinInvite} />
          </Suspense>
        </PanelBoundary>
      )}
      <Toasts />
      <LiveAnnouncer />
      <LazyAboutDialog />
      <LazyShortcutSheet />
      {!__DESKTOP__ && <DiagnosticsDialog />}
      {DesktopSettingsChunk && hostKind() === 'desktop' && (
        <PanelBoundary onError={panelFailed('desktop-settings-panel', DesktopSettingsChunk, 'Settings couldn’t open. Restart Draft Canvas and try again.')}>
          <Suspense fallback={null}>
            <DesktopSettingsChunk.Component />
          </Suspense>
        </PanelBoundary>
      )}
      {AgentActivityChunk && hostKind() === 'desktop' && (
        <PanelBoundary onError={panelFailed('agent-activity-panel', AgentActivityChunk, 'Agent activity can’t be shown. Restart Draft Canvas to see it again.')}>
          <Suspense fallback={null}>
            <AgentActivityChunk.Component />
          </Suspense>
        </PanelBoundary>
      )}
    </>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <PersonalityProvider>
        <Shell />
      </PersonalityProvider>
    </ThemeProvider>
  );
}
