import * as vscode from 'vscode';

/**
 * Draft Canvas for VS Code is retired. This is its last release, and it does one job: tell someone
 * who still has it installed what happened and where their diagrams open now, without ever standing
 * between them and a file.
 *
 * A `.draftcanvas` file is plain JSON that the web editor imports and the desktop app opens directly,
 * so nothing here is needed to get at a diagram. The custom editor is registered at `option`
 * priority — a file opens as text by default and this page is under "Open With" — and the page never
 * edits, never loads anything from the network, and never writes to the file.
 */
const VIEW_TYPE = 'draftCanvas.editor';
const EDITOR_URL = 'https://acltabontabon.com/draft-canvas/editor/';
const DESKTOP_URL = 'https://github.com/acltabontabon/draft-canvas/releases/latest';
const GUIDE_URL = 'https://github.com/acltabontabon/draft-canvas/blob/main/docs/guides/vscode-retired.md';
/** The only places a click in the page may send someone. */
const LINKS: Record<string, string> = { editor: EDITOR_URL, desktop: DESKTOP_URL, guide: GUIDE_URL };
const NOTICE_KEY = 'draftCanvas.retirementNoticeShown';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new RetiredEditor(), {
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.commands.registerCommand('draftCanvas.newDiagram', () => showNotice(context, true)),
  );
  // Once per installation, the first time a diagram is opened after updating — never again after
  // that, whatever is chosen. The page inside each tab says the same, for anyone who dismissed it.
  void showNotice(context, false);
}

async function showNotice(context: vscode.ExtensionContext, always: boolean): Promise<void> {
  if (!always && context.globalState.get<boolean>(NOTICE_KEY)) return;
  await context.globalState.update(NOTICE_KEY, true);
  const choice = await vscode.window.showInformationMessage(
    'Draft Canvas for VS Code has been retired. Your .draftcanvas files are unchanged: open them in the Draft Canvas web editor (Import) or the desktop app.',
    'Open the web editor',
    'Download the desktop app',
    'How to move my diagrams',
  );
  if (choice === 'Open the web editor') void vscode.env.openExternal(vscode.Uri.parse(EDITOR_URL));
  else if (choice === 'Download the desktop app') void vscode.env.openExternal(vscode.Uri.parse(DESKTOP_URL));
  else if (choice === 'How to move my diagrams') void vscode.env.openExternal(vscode.Uri.parse(GUIDE_URL));
}

/** The one page the retired extension shows: what happened, and the ways out. It reads nothing but the file's name. */
class RetiredEditor implements vscode.CustomTextEditorProvider {
  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    panel.webview.options = { enableScripts: true, localResourceRoots: [] };
    panel.webview.html = html(document.uri.path.split('/').pop() ?? document.uri.path);
    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!isRecord(message)) return;
      if (message.type === 'reopenAsText') {
        void vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
      } else if (message.type === 'open' && typeof message.link === 'string' && message.link in LINKS) {
        void vscode.env.openExternal(vscode.Uri.parse(LINKS[message.link]!));
      }
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function html(fileName: string): string {
  const nonce = createNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Draft Canvas for VS Code has been retired</title>
<style nonce="${nonce}">
  body { font: 14px/1.5 var(--vscode-font-family); color: var(--vscode-foreground); padding: 32px; max-width: 560px; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  p { margin: 0 0 12px; }
  ol { margin: 0 0 16px 20px; padding: 0; }
  li { margin-bottom: 6px; }
  code { font-family: var(--vscode-editor-font-family); }
  button { font: inherit; margin: 0 8px 8px 0; padding: 6px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer; }
  .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .quiet { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<h1>Draft Canvas for VS Code has been retired</h1>
<p>Draft Canvas now lives in two places: the web editor and the desktop app. This extension no longer opens the editor, and this is its last release.</p>
<p><code>${escapeHtml(fileName)}</code> has not been touched. It is an ordinary <code>.draftcanvas</code> file — plain JSON — and it opens exactly as it is:</p>
<ol>
  <li><strong>In the desktop app</strong>: open the file, or add its folder as a project.</li>
  <li><strong>In the web editor</strong>: choose <strong>Import</strong> in the Library and pick the file. Export it back as a <code>.draftcanvas</code> to keep it in the repository.</li>
</ol>
<p>
  <button class="primary" data-link="desktop">Download the desktop app</button>
  <button class="secondary" data-link="editor">Open the web editor</button>
  <button class="secondary" id="text">Reopen as text</button>
</p>
<p class="quiet">To stop seeing this page, uninstall the extension; <code>.draftcanvas</code> files then open as text. <button class="secondary" data-link="guide">Read the guide</button></p>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  for (const button of document.querySelectorAll('[data-link]')) {
    button.addEventListener('click', () => vscode.postMessage({ type: 'open', link: button.dataset.link }));
  }
  document.getElementById('text').addEventListener('click', () => vscode.postMessage({ type: 'reopenAsText' }));
</script>
</body>
</html>`;
}

function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
