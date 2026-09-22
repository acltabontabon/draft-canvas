import * as vscode from 'vscode';

/**
 * The hosted editor.
 *
 * Every version released before this one pointed at https://acltabontabon.com/draft-canvas/, which
 * is now the landing page. Those copies keep working: that page ships a small script that forwards
 * a `?host=vscode` frame — the only URL parameter the app has ever understood — on to the editor,
 * and the webview CSP below permits it because a `frame-src` whose path ends in `/` matches by
 * prefix. Changing this constant only removes that hop for people who update.
 */
const APP_URL = 'https://acltabontabon.com/draft-canvas/editor/';
/** Where to send someone who asks to open Draft Canvas in a browser: the front door, not the app. */
const SITE_URL = 'https://acltabontabon.com/draft-canvas/';
const VIEW_TYPE = 'draftCanvas.editor';
const EXTENSION = '.draftcanvas';
const LANGUAGE_ID = 'draftcanvas';
/** What a link in the app may open. Anything else it sends is ignored. */
const EXTERNAL_SCHEMES = new Set(['http', 'https', 'mailto']);
/** How long the app gets to say it loaded before the fallback is offered. */
const READY_TIMEOUT_MS = 15_000;
/** The app's own ceiling for a diagram file; copied shapes are a diagram too. */
const MAX_CLIPBOARD_BYTES = 24 * 1024 * 1024;
/** Text copied from, or pasted into, a field in the app: a note or a label, never a file. */
const MAX_PLAIN_CLIPBOARD_CHARS = 1_000_000;
/** The canvas background images the app takes, by the extension its sidecar file gets. */
const BACKGROUND_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const BACKGROUND_MIMES = Object.fromEntries(Object.entries(BACKGROUND_EXTENSIONS).map(([mime, extension]) => [extension, mime]));
/** The app downscales to 4096 px on a side; anything past this isn't one of its images. */
const MAX_BACKGROUND_BYTES = 16 * 1024 * 1024;

/**
 * Chords pressed in the app's frame that run a VS Code command. A key pressed in the frame never
 * reaches VS Code's keybindings, so the app is told these (`keys` on load) and posts the ones it
 * doesn't use itself. VS Code's default bindings, not the user's own. Named as the app names them:
 * `cmd` on macOS and `ctrl` elsewhere, then `shift`, then the key.
 */
const KEY_COMMANDS: Record<string, string> = {
  p: 'workbench.action.quickOpen',
  'shift+p': 'workbench.action.showCommands',
  w: 'workbench.action.closeActiveEditor',
  'shift+t': 'workbench.action.reopenClosedEditor',
  'shift+f': 'workbench.action.findInFiles',
  j: 'workbench.action.togglePanel',
  ',': 'workbench.action.openSettings',
};
const MOD = process.platform === 'darwin' ? 'cmd' : 'ctrl';
const HOST_KEYS = Object.fromEntries(Object.entries(KEY_COMMANDS).map(([chord, command]) => [`${MOD}+${chord}`, command]));

export function activate(context: vscode.ExtensionContext): void {
  // Lets the Extension Development Host point at a local build (e.g. `vite preview`) before a web
  // release is deployed. An installed extension always loads the hosted app.
  const appUrl =
    context.extensionMode === vscode.ExtensionMode.Development && process.env.DRAFT_CANVAS_URL
      ? process.env.DRAFT_CANVAS_URL
      : APP_URL;

  context.subscriptions.push(
    // A diagram renamed in VS Code takes its background image with it. Best effort: a rename made
    // outside VS Code (Finder, git) can't be followed.
    vscode.workspace.onDidRenameFiles((event) => {
      for (const { oldUri, newUri } of event.files) void moveBackground(oldUri, newUri);
    }),
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
    // Changes from the app accepted but not applied yet.
    let waiting = 0;
    let queue = Promise.resolve();
    // Numbers every load. An app that sends `baseSeq` back says which load its edit was made on; an
    // edit made before the file was last replaced from outside (a revert, a checkout) would write the
    // old contents back over the new, so it's dropped — the app is about to show the new ones.
    let loadSeq = 0;
    const load = () => {
      appText = document.getText();
      loadSeq += 1;
      const title = document.uri.path.split('/').pop()?.replace(/\.draftcanvas$/i, '');
      // `clipboard`: keys pressed in the app's frame never reach VS Code's Copy/Paste, and the frame
      // is refused the Clipboard API, so the app copies and pastes through here instead. `textEditing`
      // and `keys` are the same story for a text field's Edit shortcuts and for VS Code's own.
      void panel.webview.postMessage({
        type: 'draft-canvas:load',
        text: appText,
        title,
        seq: loadSeq,
        clipboard: true,
        textEditing: true,
        keys: Object.keys(HOST_KEYS),
        background: true,
      });
    };
    // The background image the app last asked for. It reaches the disk with the file, on save, so an edit
    // that is never saved (or is reverted) leaves nothing behind, like the diagram's own text.
    let pendingBackground: { mime: string; bytes: Buffer } | 'remove' | undefined;
    /**
     * The file changed under the app — a revert, an undo in VS Code, a git checkout. The unsaved background
     * went with the unsaved edits it belonged to: saving next must not write it beside text that no longer
     * refers to it, and the app, which keeps what it already loaded, asks the disk for anything new.
     */
    const loadFromElsewhere = () => {
      pendingBackground = undefined;
      load();
    };
    /** Runs after every edit already on its way. One that fails is reported, and the rest still run. */
    const enqueue = (task: () => Promise<unknown>) => {
      queue = queue.then(task).then(
        () => undefined,
        (error: unknown) => console.error('[draft-canvas]', error),
      );
    };

    const subscriptions = [
      panel.webview.onDidReceiveMessage((message: unknown) => {
        if (!isRecord(message)) return;
        switch (message.type) {
          case 'draft-canvas:ready':
            // After any edit still being applied (the app reloaded right after one), so the load
            // carries it rather than the text from before it.
            enqueue(async () => load());
            break;
          case 'draft-canvas:change':
            if (typeof message.text !== 'string') break;
            if (typeof message.baseSeq === 'number' && message.baseSeq < loadSeq) break;
            appText = message.text;
            waiting++;
            enqueue(async () => {
              applying++;
              try {
                await replaceText(document, appText ?? '');
              } finally {
                applying--;
                waiting--;
              }
              // A change from elsewhere that landed while this was applying was skipped by the
              // listener below; catch it now — once no newer edit from the app is still to come.
              if (waiting === 0 && document.getText() !== appText) loadFromElsewhere();
            });
            break;
          case 'draft-canvas:save':
            // Queued behind the edits it's meant to save. The key was pressed inside this tab, so
            // it's the active editor the save commands act on.
            enqueue(() =>
              Promise.resolve(
                vscode.commands.executeCommand(message.saveAs === true ? 'workbench.action.files.saveAs' : 'workbench.action.files.save'),
              ),
            );
            break;
          case 'draft-canvas:open-external':
            if (typeof message.url === 'string') openExternal(message.url);
            break;
          case 'draft-canvas:clipboard-write':
            if (typeof message.text === 'string' && isClipboardText(message.text, message.plain === true)) {
              void vscode.env.clipboard.writeText(message.text);
            }
            break;
          case 'draft-canvas:clipboard-read': {
            const id = message.id;
            if (typeof id !== 'number') break;
            const plain = message.plain === true;
            void Promise.resolve(vscode.env.clipboard.readText()).then(
              (text) => panel.webview.postMessage({ type: 'draft-canvas:clipboard', id, text: isClipboardText(text, plain) ? text : '' }),
              () => panel.webview.postMessage({ type: 'draft-canvas:clipboard', id, text: '' }),
            );
            break;
          }
          case 'draft-canvas:key': {
            // Only from the tab being looked at, and only for a chord the app was told about.
            const command = typeof message.chord === 'string' ? HOST_KEYS[message.chord] : undefined;
            if (command && panel.active) void vscode.commands.executeCommand(command);
            break;
          }
          case 'draft-canvas:background-write': {
            const { mime, data } = message;
            if (typeof mime !== 'string' || typeof data !== 'string' || !(mime in BACKGROUND_EXTENSIONS)) break;
            // base64 is a third longer than the bytes it holds.
            if (data.length > (MAX_BACKGROUND_BYTES * 4) / 3 + 4) break;
            pendingBackground = { mime, bytes: Buffer.from(data, 'base64') };
            break;
          }
          case 'draft-canvas:background-remove':
            pendingBackground = 'remove';
            break;
          case 'draft-canvas:background-read': {
            const id = message.id;
            if (typeof id !== 'number') break;
            const reply = (image?: { mime: string; bytes: Uint8Array }) =>
              panel.webview.postMessage({
                type: 'draft-canvas:background',
                id,
                ...(image ? { mime: image.mime, data: Buffer.from(image.bytes).toString('base64') } : {}),
              });
            // What the app itself last chose wins over the disk, which is behind it until the next save.
            if (pendingBackground) {
              void reply(pendingBackground === 'remove' ? undefined : pendingBackground);
              break;
            }
            void readBackground(document).then(reply, () => reply());
            break;
          }
          case 'openInBrowser':
            void vscode.env.openExternal(vscode.Uri.parse(SITE_URL));
            break;
        }
      }),
      vscode.workspace.onDidSaveTextDocument((saved) => {
        // A Save As — a new diagram's first save, or ⌘⇧S on one already saved — is a new document that
        // this panel is about to be replaced by, and it announces the save here first. It's this
        // diagram's when its text is exactly ours: the text carries the diagram's own id, so no other
        // file can match.
        const sameFile = saved.uri.toString() === document.uri.toString();
        const savedAs = !sameFile && saved.uri.path.toLowerCase().endsWith(EXTENSION) && saved.getText() === appText;
        if (!sameFile && !savedAs) return;
        const target = sameFile ? document : saved;
        const pending = pendingBackground;
        if (!pending) {
          // Nothing new to write — but a copy saved elsewhere takes the background already on disk along.
          if (savedAs) {
            const source = document;
            enqueue(async () => {
              const image = await readBackground(source).catch(() => undefined);
              if (image) await writeBackground(target, image);
            });
          }
          return;
        }
        enqueue(async () => {
          await writeBackground(target, pending);
          // Unless the app changed its mind while that was being written.
          if (pendingBackground === pending) pendingBackground = undefined;
        });
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        // A revert, an undo in VS Code, a git checkout: anything that isn't the app's own edit.
        if (event.document !== document || event.contentChanges.length === 0 || applying > 0) return;
        if (document.getText() !== appText) loadFromElsewhere();
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

/** The files beside a diagram that hold its background image: `<name>.draftcanvas.background.<ext>`. */
async function backgroundFiles(diagram: vscode.Uri): Promise<Array<{ uri: vscode.Uri; extension: string }>> {
  const folder = vscode.Uri.joinPath(diagram, '..');
  const prefix = `${diagram.path.split('/').pop()}.background.`;
  const entries = await vscode.workspace.fs.readDirectory(folder);
  return entries
    .filter(([name, type]) => type === vscode.FileType.File && name.startsWith(prefix) && name.slice(prefix.length).toLowerCase() in BACKGROUND_MIMES)
    .map(([name]) => ({ uri: vscode.Uri.joinPath(folder, name), extension: name.slice(prefix.length).toLowerCase() }));
}

async function readBackground(document: vscode.TextDocument): Promise<{ mime: string; bytes: Uint8Array } | undefined> {
  if (document.isUntitled) return undefined;
  const [file] = await backgroundFiles(document.uri).catch(() => []);
  if (!file) return undefined;
  const bytes = await vscode.workspace.fs.readFile(file.uri);
  return bytes.length <= MAX_BACKGROUND_BYTES ? { mime: BACKGROUND_MIMES[file.extension]!, bytes } : undefined;
}

/** Puts the app's background image beside the diagram — replacing an earlier one whatever its type — or removes it. */
async function writeBackground(document: vscode.TextDocument, image: { mime: string; bytes: Uint8Array } | 'remove'): Promise<void> {
  if (document.isUntitled) return;
  try {
    const wanted = image === 'remove' ? undefined : BACKGROUND_EXTENSIONS[image.mime];
    for (const file of await backgroundFiles(document.uri).catch(() => [])) {
      if (file.extension !== wanted) await vscode.workspace.fs.delete(file.uri);
    }
    if (image !== 'remove' && wanted) {
      await vscode.workspace.fs.writeFile(document.uri.with({ path: `${document.uri.path}.background.${wanted}` }), image.bytes);
    }
  } catch (error) {
    void vscode.window.showErrorMessage(`Draft Canvas could not save the background image beside the diagram. ${error instanceof Error ? error.message : ''}`.trim());
  }
}

/** A renamed diagram's background image goes with it. */
async function moveBackground(from: vscode.Uri, to: vscode.Uri): Promise<void> {
  if (!from.path.toLowerCase().endsWith(EXTENSION) || !to.path.toLowerCase().endsWith(EXTENSION)) return;
  try {
    for (const file of await backgroundFiles(from)) {
      await vscode.workspace.fs.rename(file.uri, to.with({ path: `${to.path}.background.${file.extension}` }), { overwrite: true });
    }
  } catch {
    // Nothing beside it, or not ours to move: the diagram simply opens without its background.
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

/**
 * What may cross between the clipboard and the app. The app is a website, and by default only shapes
 * copied in Draft Canvas do: nothing else on the clipboard (a password, a token) is its business. A
 * `plain` request is the app's text fields (Copy and Paste inside a note, say), which is any text —
 * asked for by a key pressed there, which the extension has no way to check.
 */
function isClipboardText(text: string, plain: boolean): boolean {
  return plain ? text.length <= MAX_PLAIN_CLIPBOARD_CHARS : isCopiedShapes(text);
}

function isCopiedShapes(text: string): boolean {
  if (text.length > MAX_CLIPBOARD_BYTES || !text.trimStart().startsWith('{')) return false;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) && value.format === 'draft-canvas';
  } catch {
    return false;
  }
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
  const fromApp = [
    'draft-canvas:ready',
    'draft-canvas:change',
    'draft-canvas:save',
    'draft-canvas:open-external',
    'draft-canvas:clipboard-write',
    'draft-canvas:clipboard-read',
    'draft-canvas:key',
    'draft-canvas:background-write',
    'draft-canvas:background-remove',
    'draft-canvas:background-read',
  ];
  const toApp = ['draft-canvas:load', 'draft-canvas:clipboard', 'draft-canvas:background'];
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
    } else if (toApp.includes(type)) {
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
