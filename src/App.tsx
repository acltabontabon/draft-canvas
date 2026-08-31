import { ReactFlowProvider } from '@xyflow/react';
import { useDocumentSession } from './store/useDocumentSession';
import { EditorScreen } from './ui/Editor/EditorScreen';
import { LibraryScreen } from './ui/Library/LibraryScreen';
import { AboutDialog } from './ui/common/AboutDialog';
import { Toasts } from './ui/common/Toasts';
import { ThemeProvider } from './ui/theme/ThemeProvider';
import { PersonalityProvider } from './ui/personality/PersonalityProvider';

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
      {session.openId ? (
        <ReactFlowProvider>
          <EditorScreen session={session} />
        </ReactFlowProvider>
      ) : (
        <LibraryScreen session={session} />
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
