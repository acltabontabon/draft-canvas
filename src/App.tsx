import { Suspense, useEffect } from 'react';
import { embeddedHost } from './host/embeddedHost';
import { useHostDocument } from './host/useHostDocument';
import { useDocumentSession } from './store/useDocumentSession';
import { LibraryScreen } from './ui/Library/LibraryScreen';
import { AboutDialog } from './ui/common/AboutDialog';
import { ErrorBoundary } from './ui/common/ErrorBoundary';
import { retryableLazy } from './ui/common/retryableLazy';
import { Toasts } from './ui/common/Toasts';
import { ThemeProvider } from './ui/theme/ThemeProvider';
import { PersonalityProvider } from './ui/personality/PersonalityProvider';
import { logDiagnostic } from './lib/diagnostics';
import { retirePreferences } from './lib/preferences';

// The editor is most of the app's code, and the Library is what every visit opens on — so the
// editor arrives as its own chunk (React Flow included), fetched in the background once the Library
// is up (see `Shell`) so opening a canvas never waits on the network. The offline Service Worker
// precaches it either way.
const loadEditor = () => import('./ui/Editor/EditorScreen');
// Retryable: `lazy()` alone remembers a failed fetch for good, so after one offline open (or a deploy
// that replaced the chunk under an old tab) every later open would crash the same way.
const EditorChunk = retryableLazy(() => loadEditor().then((module) => ({ default: module.EditorRoute })));

/**
 * There is no router.
 *
 * The library and the editor are two states of one screen, which keeps the app
 * deployable under any path — /workbench/draft-canvas or anywhere else — with
 * no base-path configuration and no server rewrite rules.
 */
function Shell() {
  const session = useDocumentSession();
  const host = useHostDocument(session);

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
          ...(session.openId && !embeddedHost
            ? [{ label: 'Return home', onClick: () => void session.closeDocument() }]
            : []),
          { label: 'Reload app', onClick: () => window.location.reload() },
        ]}
        onError={(error, componentStack) => {
          EditorChunk.reset();
          logDiagnostic(error, { operation: 'app-shell', documentId: session.openId }, componentStack);
        }}
      >
        {session.openId ? (
          <Suspense fallback={<div className="dc-editor-loading" aria-busy="true" />}>
            <EditorChunk.Component session={session} />
          </Suspense>
        ) : embeddedHost ? (
          // The host's file is the only document there is, so there's no Library to fall back to.
          <div className="dc-editor-loading dc-host-waiting" aria-busy={host.error ? undefined : true}>
            {host.error && <p role="alert">This file couldn't be opened as a diagram. {host.error}</p>}
          </div>
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
      <Toasts />
      <AboutDialog />
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
