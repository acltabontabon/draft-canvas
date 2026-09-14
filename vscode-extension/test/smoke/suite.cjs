// Runs inside VS Code (see run.mjs). Checks the packaged extension's part of the file workflow:
// that it's installed, stays idle until a diagram is opened, and opens `.draftcanvas` files in its
// own editor without touching them. Drawing and saving happen inside the Draft Canvas app, which this
// can't drive; the app's side is covered by tests/host-document.test.tsx.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vscode = require('vscode');

const EXTENSION_ID = 'acltabontabon.draft-canvas';
const VIEW_TYPE = 'draftCanvas.editor';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Generous: a VS Code that has just been downloaded can take a while to open its first editor.
async function until(what, check, timeout = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = check();
    if (value) return value;
    await sleep(100);
  }
  assert.fail(`Timed out waiting for: ${what}`);
}

const allTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs);
const draftCanvasTabs = (uri) =>
  allTabs().filter(
    (tab) => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === VIEW_TYPE && tab.input.uri.toString() === uri.toString(),
  );
const activeInput = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input;

async function step(name, body) {
  await body();
  process.stdout.write(`  ✓ ${name}\n`);
}

exports.run = async () => {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(folder, 'The fixture workspace is open');
  const payments = vscode.Uri.joinPath(folder, 'docs', 'architecture', 'payments.draftcanvas');
  const broken = vscode.Uri.joinPath(folder, 'docs', 'architecture', 'broken.draftcanvas');

  await step('the VSIX is installed with the expected version', async () => {
    assert.ok(extension, `${EXTENSION_ID} is installed`);
    assert.equal(extension.packageJSON.version, process.env.DRAFT_CANVAS_EXPECTED_VERSION);
  });

  await step('it does not activate at startup', async () => {
    assert.equal(extension.isActive, false);
  });

  await step('a .draftcanvas file opens in the Draft Canvas editor', async () => {
    await vscode.commands.executeCommand('vscode.open', payments);
    await until('the Draft Canvas editor for payments.draftcanvas', () => draftCanvasTabs(payments).length === 1);
    assert.ok(extension.isActive, 'opening a diagram activates the extension');
  });

  await step('opening it again reuses the same tab', async () => {
    await vscode.commands.executeCommand('vscode.open', payments);
    await sleep(500);
    assert.equal(draftCanvasTabs(payments).length, 1);
  });

  await step('opening a file does not modify it', async () => {
    const before = fs.readFileSync(payments.fsPath, 'utf8');
    await sleep(3000);
    const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === payments.toString());
    assert.equal(document?.isDirty ?? false, false);
    assert.equal(document?.languageId, 'draftcanvas');
    assert.equal(fs.readFileSync(payments.fsPath, 'utf8'), before);
  });

  await step('a file that is not a diagram opens without being modified', async () => {
    const before = fs.readFileSync(broken.fsPath, 'utf8');
    await vscode.commands.executeCommand('vscode.open', broken);
    await until('the Draft Canvas editor for broken.draftcanvas', () => draftCanvasTabs(broken).length === 1);
    await sleep(3000);
    const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === broken.toString());
    assert.equal(document?.isDirty ?? false, false);
    assert.equal(fs.readFileSync(broken.fsPath, 'utf8'), before);
  });

  await step('Draft Canvas: New Diagram opens an untitled .draftcanvas in the editor', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('draftCanvas.newDiagram'));
    await vscode.commands.executeCommand('draftCanvas.newDiagram');
    const input = await until('an untitled Draft Canvas editor', () => {
      const current = activeInput();
      return current instanceof vscode.TabInputCustom && current.viewType === VIEW_TYPE && current.uri.scheme === 'untitled' ? current : null;
    });
    assert.ok(input.uri.path.endsWith('.draftcanvas'));
    // The blank diagram the app writes is JSON; language detection must not rename it, or Save
    // suggests `Untitled-1.json`, which doesn't reopen in Draft Canvas.
    await sleep(3000);
    const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === input.uri.toString());
    assert.equal(document?.languageId, 'draftcanvas');
    // Once the hosted app has written a blank diagram into it, it's dirty; close it without asking.
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });
};
