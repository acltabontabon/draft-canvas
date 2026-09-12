import { lazy, Suspense, useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useDocumentSession } from './store/useDocumentSession';
import { LibraryScreen } from './ui/Library/LibraryScreen';
import { AboutDialog } from './ui/common/AboutDialog';
import { ErrorBoundary } from './ui/common/ErrorBoundary';
import { Toasts } from './ui/common/Toasts';
import { ThemeProvider } from './ui/theme/ThemeProvider';
import { PersonalityProvider } from './ui/personality/PersonalityProvider';
import { HintsProvider } from './learning/HintsProvider';
import { logDiagnostic } from './lib/diagnostics';

// The editor is most of the app's code, and the Library is what every visit opens on — so the
// editor arrives as its own chunk, fetched in the background once the Library is up (see `Shell`)
// so opening a canvas never waits on the network. The offline Service Worker precaches it either way.
const loadEditor = () => import('./ui/Editor/EditorScreen');
const EditorScreen = lazy(() => loadEditor().then((module) => ({ default: module.EditorScreen })));

/**
 * There is no router.
 *
 * The library and the editor are two states of one screen, which keeps the app
 * deployable under any path — /workbench/draft-canvas or anywhere else — with
 * no base-path configuration and no server rewrite rules.
 */
function Shell() {
  const session = useDocumentSession();

  useEffect(() => {
    const warm = () => void loadEditor();
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
        actions={[
          ...(session.openId
            ? [{ label: 'Return home', onClick: () => void session.closeDocument() }]
            : []),
          { label: 'Reload app', onClick: () => window.location.reload() },
        ]}
        onError={(error, componentStack) =>
          logDiagnostic(error, { operation: 'app-shell', documentId: session.openId }, componentStack)
        }
      >
        {session.openId ? (
          <ReactFlowProvider>
            <Suspense fallback={<div className="dc-editor-loading" aria-busy="true" />}>
              <EditorScreen session={session} />
            </Suspense>
          </ReactFlowProvider>
        ) : (
          <LibraryScreen session={session} />
        )}
      </ErrorBoundary>
      <Toasts />
      <AboutDialog />
    </>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <PersonalityProvider>
        <HintsProvider>
          <Shell />
        </HintsProvider>
      </PersonalityProvider>
    </ThemeProvider>
  );
}
