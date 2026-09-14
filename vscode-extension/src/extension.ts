import * as vscode from 'vscode';

const APP_URL = 'https://acltabontabon.com/draft-canvas/';
const VIEW_TYPE = 'draftCanvas.editor';
const EXTENSION = '.draftcanvas';
const LANGUAGE_ID = 'draftcanvas';
/** What a link in the app may open. Anything else it sends is ignored. */
const EXTERNAL_SCHEMES = new Set(['http', 'https', 'mailto']);
/** How long the app gets to say it loaded before the fallback is offered. */
const READY_TIMEOUT_MS = 15_000;

export function activate(context: vscode.ExtensionContext): void {
  // Lets the Extension Development Host point at a local build (e.g. `vite preview`) before a web
  // release is deployed. An installed extension always loads the hosted app.
  const appUrl =
    context.extensionMode === vscode.ExtensionMode.Development && process.env.DRAFT_CANVAS_URL
      ? process.env.DRAFT_CANVAS_URL
      : APP_URL;

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new DraftCanvasEditor(context, appUrl), {
      // The app's state (undo history, selection, an open dialog) lives inside a cross-origin frame
      // that setState can't reach, so a hidden tab keeps its frame instead of reloading the app.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('draftCanvas.newDiagram', newDiagram),
  );
}

/** Opens an untitled `.draftcanvas` file; saving it asks where it goes, like any new file. */
async function newDiagram(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.path ?? '';
  const taken = new Set(vscode.workspace.textDocuments.map((document) => document.uri.path));
  let n = 1;
  while (taken.has(`${folder}/Untitled-${n}${EXTENSION}`)) n++;
  const uri = vscode.Uri.from({ scheme: 'untitled', path: `${folder}/Untitled-${n}${EXTENSION}` });
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
}

/**
 * The file is a plain text document, so VS Code owns dirty state, saving, hot exit and undo across
 * restarts. The webview only relays: the app sends the whole serialized document on every edit,
 * and gets the file's text back whenever it changes outside the canvas.
 */
class DraftCanvasEditor implements vscode.CustomTextEditorProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly appUrl: string,
  ) {}

  resolveCustomTextEditor(initialDocument: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    let document = initialDocument;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.png');
    panel.webview.options = {
      // Also required for the framed app itself: without it VS Code sandboxes the webview without
      // allow-scripts, and the nested frame inherits that.
      enableScripts: true,
      localResourceRoots: [],
    };
    panel.webview.html = html(this.appUrl);

    // What the app holds, so its own edits aren't sent straight back to it.
    let appText: string | undefined;
    // Edits are applied one at a time, always with the app's latest text; while one is being applied
    // the document can briefly differ from `appText`, and that isn't a change made elsewhere.
    let applying = 0;
    let queue = Promise.resolve();
    const load = () => {
      appText = document.getText();
      const title = document.uri.path.split('/').pop()?.replace(/\.draftcanvas$/i, '');
      void panel.webview.postMessage({ type: 'draft-canvas:load', text: appText, title });
    };

    const subscriptions = [
      panel.webview.onDidReceiveMessage((message: unknown) => {
        if (!isRecord(message)) return;
        switch (message.type) {
          case 'draft-canvas:ready':
            load();
            break;
          case 'draft-canvas:change':
            if (typeof message.text === 'string') {
              appText = message.text;
              queue = queue.then(async () => {
                applying++;
                try {
                  await replaceText(document, appText ?? '');
                } finally {
                  applying--;
                }
              });
            }
            break;
          case 'draft-canvas:save':
            // The key was pressed inside this tab, so it's the active editor the save commands act on.
            void vscode.commands.executeCommand(message.saveAs === true ? 'workbench.action.files.saveAs' : 'workbench.action.files.save');
            break;
          case 'draft-canvas:open-external':
            if (typeof message.url === 'string') openExternal(message.url);
            break;
          case 'openInBrowser':
            void vscode.env.openExternal(vscode.Uri.parse(APP_URL));
            break;
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        // A revert, an undo in VS Code, a git checkout: anything that isn't the app's own edit.
        if (event.document !== document || event.contentChanges.length === 0 || applying > 0) return;
        if (document.getText() !== appText) load();
      }),
      // A language change closes and reopens the document, so keep hold of whichever one is open.
      vscode.workspace.onDidOpenTextDocument((opened) => {
        if (opened.uri.toString() === document.uri.toString()) document = opened;
      }),
    ];
    panel.onDidDispose(() => subscriptions.forEach((subscription) => subscription.dispose()));

    // An untitled file's contents are JSON, and VS Code's language detection would call it that. Save
    // then names the file after the language, `Untitled-1.json`, which no longer opens in this editor.
    if (document.isUntitled && document.languageId !== LANGUAGE_ID) {
      void vscode.languages.setTextDocumentLanguage(document, LANGUAGE_ID);
    }
  }
}

async function replaceText(document: vscode.TextDocument, text: string): Promise<void> {
  if (document.getText() === text) return;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
  if (!(await vscode.workspace.applyEdit(edit))) {
    void vscode.window.showErrorMessage('Draft Canvas could not update the file. Your latest change may not be in it.');
  }
}

/** A link clicked in the app. VS Code asks before opening a site the user hasn't trusted yet. */
function openExternal(url: string): void {
  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(url, true);
  } catch {
    return;
  }
  if (EXTERNAL_SCHEMES.has(uri.scheme)) void vscode.env.openExternal(uri);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function html(appUrl: string): string {
  const url = new URL(appUrl);
  const frameSrc = url.origin + url.pathname;
  url.searchParams.set('host', 'vscode');
  const nonce = createNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${frameSrc}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  html, body, iframe { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; }
  body { background: var(--vscode-editor-background); }
  iframe { display: block; border: 0; }
  #fallback {
    position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 16px; background: var(--vscode-editor-background); color: var(--vscode-foreground);
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
  }
  #fallback[hidden] { display: none; }
  #fallback p { margin: 0; }
  #fallback div { display: flex; gap: 8px; }
  button {
    font: inherit; padding: 4px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>
<iframe id="app" src="${escapeAttribute(url.href)}" title="Draft Canvas" allow="clipboard-read; clipboard-write"></iframe>
<div id="fallback" role="alert" hidden>
  <p>Draft Canvas couldn't be loaded.</p>
  <div>
    <button id="retry">Retry</button>
    <button id="browser" class="secondary">Open in browser</button>
  </div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const fallback = document.getElementById('fallback');
  const appOrigin = ${JSON.stringify(url.origin)};
  const fromApp = ['draft-canvas:ready', 'draft-canvas:change', 'draft-canvas:save', 'draft-canvas:open-external'];
  let timer;

  // A cross-origin frame fires "load" for an error page too, so only the app saying so counts.
  const waitForApp = () => {
    clearTimeout(timer);
    timer = setTimeout(() => (fallback.hidden = false), ${READY_TIMEOUT_MS});
  };
  window.addEventListener('message', (event) => {
    const type = event.data && event.data.type;
    if (event.source === app.contentWindow) {
      if (event.origin !== appOrigin || !fromApp.includes(type)) return;
      if (type === 'draft-canvas:ready') {
        clearTimeout(timer);
        fallback.hidden = true;
      }
      vscode.postMessage(event.data);
    } else if (type === 'draft-canvas:load') {
      // From the extension: VS Code delivers those to this page directly, never from a frame.
      app.contentWindow.postMessage(event.data, appOrigin);
    }
  });
  document.getElementById('retry').addEventListener('click', () => {
    fallback.hidden = true;
    app.src = app.src;
    waitForApp();
  });
  document.getElementById('browser').addEventListener('click', () => vscode.postMessage({ type: 'openInBrowser' }));
  // Focus lands on this wrapper page when the tab is activated; hand it to the app so keys reach the canvas.
  window.addEventListener('focus', () => {
    if (fallback.hidden) app.focus();
  });
  waitForApp();
</script>
</body>
</html>`;
}

function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
