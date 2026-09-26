// Runs inside VS Code (see run.mjs). Checks the retired extension keeps out of the way: it's installed,
// a `.draftcanvas` file opens as text by default and is never modified, and its own editor — the
// retirement page — is there under Open With, still touching nothing.
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

  await step('a .draftcanvas file opens as text by default, untouched', async () => {
    const before = fs.readFileSync(payments.fsPath, 'utf8');
    await vscode.commands.executeCommand('vscode.open', payments);
    await until('a text editor for payments.draftcanvas', () => {
      const current = activeInput();
      return current instanceof vscode.TabInputText && current.uri.toString() === payments.toString();
    });
    assert.equal(draftCanvasTabs(payments).length, 0);
    const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === payments.toString());
    assert.equal(document?.languageId, 'draftcanvas');
    assert.equal(fs.readFileSync(payments.fsPath, 'utf8'), before);
  });

  await step('Open With → Draft Canvas shows the retirement page and modifies nothing', async () => {
    const before = fs.readFileSync(payments.fsPath, 'utf8');
    await vscode.commands.executeCommand('vscode.openWith', payments, VIEW_TYPE);
    await until('the Draft Canvas editor for payments.draftcanvas', () => draftCanvasTabs(payments).length === 1);
    assert.ok(extension.isActive, 'opening the page activates the extension');
    await sleep(2000);
    const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === payments.toString());
    assert.equal(document?.isDirty ?? false, false);
    assert.equal(fs.readFileSync(payments.fsPath, 'utf8'), before);
  });

  await step('a file that is not a diagram is left alone too', async () => {
    const before = fs.readFileSync(broken.fsPath, 'utf8');
    await vscode.commands.executeCommand('vscode.openWith', broken, VIEW_TYPE);
    await until('the Draft Canvas editor for broken.draftcanvas', () => draftCanvasTabs(broken).length === 1);
    await sleep(2000);
    assert.equal(fs.readFileSync(broken.fsPath, 'utf8'), before);
  });

  await step('the command exists and opens no editor', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('draftCanvas.newDiagram'));
    const tabsBefore = allTabs().length;
    void vscode.commands.executeCommand('draftCanvas.newDiagram');
    await sleep(1500);
    assert.equal(allTabs().length, tabsBefore);
  });
};
