import { ReactFlowProvider } from '@xyflow/react';
import { useDocumentSession } from './store/useDocumentSession';
import { EditorScreen } from './ui/Editor/EditorScreen';
import { LibraryScreen } from './ui/Library/LibraryScreen';
import { AboutDialog } from './ui/common/AboutDialog';
import { ErrorBoundary } from './ui/common/ErrorBoundary';
import { Toasts } from './ui/common/Toasts';
import { ThemeProvider } from './ui/theme/ThemeProvider';
import { PersonalityProvider } from './ui/personality/PersonalityProvider';
import { HintsProvider } from './learning/HintsProvider';
import { logDiagnostic } from './lib/diagnostics';

/**
 * There is no router.
 *
 * The library and the editor are two states of one screen, which keeps the app
 * deployable under any path — /workbench/draft-canvas or anywhere else — with
 * no base-path configuration and no server rewrite rules.
 */
function Shell() {
  const session = useDocumentSession();

  return (
    <>
      <ErrorBoundary
        scope="app"
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
            <EditorScreen session={session} />
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
