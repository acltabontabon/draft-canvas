import { PRODUCT } from '../product';

/**
 * What an un-updated copy of Draft Canvas for VS Code (0.1.0–0.1.7) sees. Those extensions framed the
 * editor at `?host=vscode` and waited for the host protocol, which is gone with them; without this
 * page they would sit on a spinner for fifteen seconds and then offer a retry that can never work.
 *
 * Deliberately not the editor: inside an IDE's webview the Library would open this origin's IndexedDB
 * — a stranger's storage from the person's point of view — for a file the page cannot even see. Plain
 * links only; nothing is fetched, and nothing about the file reaches this page.
 */
const EDITOR_URL = './';
const DESKTOP_URL = 'https://github.com/acltabontabon/draft-canvas/releases/latest';
const GUIDE_URL = 'https://github.com/acltabontabon/draft-canvas/blob/main/docs/guides/vscode-retired.md';

export function RetiredHostNotice() {
  return (
    <main className="dc-retired-host">
      <h1>Draft Canvas for VS Code has been retired</h1>
      <p>
        {PRODUCT.name} now lives in two places: the web editor and the desktop app. The extension that opened this
        page no longer works; your <code>.draftcanvas</code> file has not been touched, and it opens exactly as it is.
      </p>
      <ol>
        <li>
          <strong>In the desktop app</strong>: open the file, or add its folder as a project.
        </li>
        <li>
          <strong>In the web editor</strong>: choose <strong>Import</strong> in the Library and pick the file.
        </li>
      </ol>
      <p className="dc-retired-host-actions">
        <a className="dc-button dc-button-solid" href={DESKTOP_URL} target="_blank" rel="noreferrer">
          Download the desktop app
        </a>
        <a className="dc-button" href={EDITOR_URL} target="_blank" rel="noreferrer">
          Open the web editor
        </a>
        <a href={GUIDE_URL} target="_blank" rel="noreferrer">
          How to move a diagram
        </a>
      </p>
      <p className="dc-muted">
        To stop seeing this page, update the extension to 0.2.0 or uninstall it; <code>.draftcanvas</code> files then
        open as text in VS Code.
      </p>
    </main>
  );
}
