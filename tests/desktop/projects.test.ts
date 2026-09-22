import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../../src/document/factory';
import { serializeDocument } from '../../src/export/project';
import { createHarness, documentText, type Harness } from './harness';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

const projects = () => h.store.getSnapshot().projects;
const names = () => projects().map((project) => project.info.name);

describe('many projects', () => {
  it('knows every project on the list at start, by name only', async () => {
    const payments = h.addProject('payments', ['checkout.draftcanvas']);
    const search = h.addProject('search', ['index.draftcanvas']);
    h.listProjects(search, payments);

    await h.controller.start();

    expect(names()).toEqual(['search', 'payments']);
    expect(projects().every((project) => project.status === 'unscanned')).toBe(true);
    // Nothing is read from a folder until something shows it.
    expect(h.api.projectScan).not.toHaveBeenCalled();
  });

  it('lists a project’s diagrams when asked, once, unless asked again', async () => {
    const payments = h.addProject('payments', ['checkout.draftcanvas', 'flows/refund.draftcanvas']);
    h.listProjects(payments);
    await h.controller.start();

    await h.controller.scanProjects([payments]);
    await h.controller.scanProjects([payments]);
    expect(h.api.projectScan).toHaveBeenCalledTimes(1);
    expect(projects()[0]!.status).toBe('ready');
    expect(projects()[0]!.files.map((file) => file.relPath)).toEqual(['checkout.draftcanvas', 'flows/refund.draftcanvas']);

    await h.controller.scanProjects([payments], { again: true });
    expect(h.api.projectScan).toHaveBeenCalledTimes(2);
  });

  it('renaming a file from its project lists the project again, so its tile opens the new name', async () => {
    const payments = h.addProject('payments', ['flows/checkout.draftcanvas', 'overview.draftcanvas']);
    h.listProjects(payments);
    await h.controller.start();
    await h.controller.scanProjects([payments]);

    await h.controller.renameProjectFile(payments, 'flows/checkout.draftcanvas', 'checkout-v2');

    expect(projects()[0]!.files.map((file) => file.relPath).sort()).toEqual(['flows/checkout-v2.draftcanvas', 'overview.draftcanvas']);
    await h.controller.openProjectFile(payments, 'flows/checkout-v2.draftcanvas');
    expect(h.store.getSnapshot().doc).toMatchObject({ kind: 'file', name: 'checkout-v2' });
  });

  it('lists many projects two at a time', async () => {
    const handles = Array.from({ length: 12 }, (_, i) => h.addProject(`p${i}`, [`d${i}.draftcanvas`]));
    h.listProjects(...handles);
    await h.controller.start();
    let running = 0;
    let most = 0;
    const scan = h.api.projectScan.getMockImplementation()!;
    h.api.projectScan.mockImplementation(async (handle: string) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return scan(handle);
    });

    await h.controller.scanProjects(handles);

    expect(most).toBe(2);
    expect(projects().every((project) => project.status === 'ready')).toBe(true);
  });

  it('adding a project puts it first and lists it; adding one again moves it', async () => {
    const payments = h.addProject('payments', ['checkout.draftcanvas']);
    const search = h.addProject('search');
    h.listProjects(payments);
    await h.controller.start();

    h.pickFolder(search);
    await h.controller.pickProject();
    expect(names()).toEqual(['search', 'payments']);
    expect(projects()[0]!.status).toBe('ready');

    await h.controller.openProject(payments);
    expect(names()).toEqual(['payments', 'search']);
    expect(h.listedProjects()).toEqual([payments, search]);
  });

  it('removing a project takes it off the list and nothing else', async () => {
    const payments = h.addProject('payments', ['checkout.draftcanvas']);
    const search = h.addProject('search');
    h.listProjects(payments, search);
    await h.controller.start();

    await h.controller.forgetProject(payments);

    expect(names()).toEqual(['search']);
    expect(h.listedProjects()).toEqual([search]);
    expect(h.errors).toEqual([]);
  });

  it('a folder that has gone is shown as missing, not dropped, and comes back', async () => {
    const payments = h.addProject('payments', ['checkout.draftcanvas']);
    h.listProjects(payments);
    await h.controller.start();
    h.setMissing(payments, true);

    await h.controller.scanProjects([payments]);
    expect(projects()[0]!.status).toBe('missing');

    h.setMissing(payments, false);
    await h.controller.refreshProjects();
    expect(projects()[0]!.status).toBe('ready');
  });

  it('opens and draws a diagram from any project, by that project', async () => {
    const payments = h.addProject('payments', ['checkout.draftcanvas']);
    const search = h.addProject('search', ['index.draftcanvas']);
    h.listProjects(payments, search);
    await h.controller.start();

    expect(await h.controller.peek({ kind: 'project', project: search, relPath: 'index.draftcanvas' })).toContain('index');
    await h.controller.openProjectFile(search, 'index.draftcanvas');
    await h.settle();

    expect(h.store.getSnapshot().doc).toMatchObject({ kind: 'file', name: 'index' });
    expect(h.api.projectOpenFile).toHaveBeenCalledWith(search, 'index.draftcanvas');
  });

  describe('creating a canvas in a project or folder', () => {
    it('opens the editor at once, without writing a file', async () => {
      const payments = h.addProject('payments');
      h.listProjects(payments);
      await h.controller.start();

      await h.controller.newCanvasIn(payments, 'flows');
      await h.settle();

      expect(h.loads()).toHaveLength(1);
      expect(h.api.projectSaveNew).not.toHaveBeenCalled();
      expect(h.store.getSnapshot().doc).toEqual({ kind: 'quick', dirty: false });
    });

    it('remembers the folder for the first Save dialog', async () => {
      const payments = h.addProject('payments');
      h.listProjects(payments);
      await h.controller.start();
      await h.controller.newCanvasIn(payments, 'flows');
      await h.settle();
      h.saveAsTo(null);

      await h.controller.save();

      expect(h.lastSaveAsStartIn()).toEqual({ projectHandle: payments, relPath: 'flows' });
    });

    it('still asks every time, until the first save lands', async () => {
      const payments = h.addProject('payments');
      h.listProjects(payments);
      await h.controller.start();
      await h.controller.newCanvasIn(payments);
      await h.settle();

      h.saveAsTo(null);
      await h.controller.save();
      expect(h.api.saveAs).toHaveBeenCalledTimes(1);
      expect(h.store.getSnapshot().doc).toEqual({ kind: 'quick', dirty: false });

      await h.controller.save();
      expect(h.api.saveAs).toHaveBeenCalledTimes(2);
    });

    it('does not open a second dialog or write twice for a second request while one is pending', async () => {
      const payments = h.addProject('payments');
      h.listProjects(payments);
      await h.controller.start();
      await h.controller.newCanvasIn(payments);
      await h.settle();
      h.saveAsTo({ name: 'meeting', displayPath: '~/work/payments/meeting.draftcanvas' });

      await Promise.all([h.controller.save(), h.controller.save()]);

      expect(h.api.saveAs).toHaveBeenCalledTimes(1);
    });

    it('canceling the first save leaves the canvas open, dirty, and file-less', async () => {
      const payments = h.addProject('payments');
      h.listProjects(payments);
      await h.controller.start();
      await h.controller.newCanvasIn(payments);
      await h.settle();
      const doc = createDocument('Untitled canvas');
      doc.nodes.push(createNode({ type: 'service', x: 0, y: 0 }));
      h.edit(serializeDocument(doc));
      h.saveAsTo(null);

      await h.controller.save();

      expect(h.store.getSnapshot().doc).toEqual({ kind: 'quick', dirty: true });
      expect(h.api.projectSaveNew).not.toHaveBeenCalled();
    });

    it('a subsequent save writes the same file without reopening the dialog', async () => {
      const payments = h.addProject('payments');
      h.listProjects(payments);
      await h.controller.start();
      await h.controller.newCanvasIn(payments);
      await h.settle();
      h.saveAsTo({ name: 'meeting', displayPath: '~/work/payments/meeting.draftcanvas' });
      await h.controller.save();
      expect(h.api.saveAs).toHaveBeenCalledTimes(1);

      const doc = createDocument('meeting');
      doc.nodes.push(createNode({ type: 'service', x: 0, y: 0 }));
      h.edit(serializeDocument(doc));
      await h.controller.save();

      expect(h.api.saveAs).toHaveBeenCalledTimes(1);
      expect(h.api.saveDocument).toHaveBeenCalledTimes(1);
    });

    it('Save As from a pending canvas keeps it open, same as from a Quick Draft', async () => {
      const payments = h.addProject('payments');
      h.listProjects(payments);
      await h.controller.start();
      await h.controller.newCanvasIn(payments);
      await h.settle();
      h.saveAsTo({ name: 'meeting', displayPath: '~/work/payments/meeting.draftcanvas' });

      await h.controller.saveAs();

      expect(h.store.getSnapshot().doc).toMatchObject({ kind: 'file', name: 'meeting', dirty: false });
    });
  });

  it('moves a Quick Draft into the most recent project, or the one named', async () => {
    const payments = h.addProject('payments');
    const search = h.addProject('search');
    h.listProjects(payments, search);
    await h.controller.start();
    await h.controller.newQuickDraft();
    await h.settle();
    const doc = createDocument('Quick Draft');
    doc.nodes.push(createNode({ type: 'service', x: 0, y: 0 }));
    h.edit(serializeDocument(doc));

    await h.controller.moveIntoProject(search);

    expect(h.api.projectSaveNew).toHaveBeenCalledWith(search, expect.any(String), expect.anything());
    expect(h.store.getSnapshot().doc.kind).toBe('file');
    expect(projects().find((project) => project.info.handle === search)!.files).toHaveLength(1);
  });
});

describe('opening from a project’s folders', () => {
  const titleLoaded = () => (JSON.parse(h.loads().at(-1)!.text) as { metadata: { title: string } }).metadata.title;

  it('opens the file at its own path, however many folders share its name — spaces, Unicode and all', async () => {
    const demo = h.addProject('Demo Project', [
      'Untitled canvas.draftcanvas',
      'sub Folder/Untitled canvas.draftcanvas',
      'sub Folder/設計 é/Untitled canvas.draftcanvas',
    ]);
    h.listProjects(demo);
    await h.controller.start();
    await h.controller.scanProjects([demo]);

    for (const relPath of ['sub Folder/設計 é/Untitled canvas.draftcanvas', 'Untitled canvas.draftcanvas', 'sub Folder/Untitled canvas.draftcanvas']) {
      await h.controller.openProjectFile(demo, relPath);
      await h.settle();
      expect(h.api.projectOpenFile).toHaveBeenLastCalledWith(demo, relPath);
      // The harness titles each file by its own path, so this is the file asked for, not a namesake.
      expect(titleLoaded()).toBe(relPath.replace(/\.draftcanvas$/, ''));
      expect(h.store.getSnapshot().doc).toMatchObject({ kind: 'file', name: 'Untitled canvas', displayPath: `~/work/Demo Project/${relPath}` });
    }
    expect(h.errors).toEqual([]);
  });

  it('lists what it can from a listing the shell sent with a field missing or misnamed, instead of crashing Find a Diagram', async () => {
    const demo = h.addProject('Demo Project', ['a.draftcanvas', 'sub/b.draftcanvas']);
    h.listProjects(demo);
    await h.controller.start();
    // What an older shell sent: `truncated_dirs`, not `truncatedDirs` — and a stray entry that isn't a file.
    h.api.projectScan.mockResolvedValueOnce({
      files: [{ relPath: 'a.draftcanvas', name: 'a', mtimeMs: 1, size: 2 }, { relPath: 'sub/b.draftcanvas', name: 'b' }, null, { name: 'no path' }],
      truncated_dirs: [],
    } as never);

    await h.controller.scanProjects([demo]);

    const [project] = projects();
    expect(project!.status).toBe('ready');
    expect(project!.truncatedDirs).toEqual([]);
    expect(project!.files).toEqual([
      { relPath: 'a.draftcanvas', name: 'a', mtimeMs: 1, size: 2 },
      { relPath: 'sub/b.draftcanvas', name: 'b', mtimeMs: 0, size: 0 },
    ]);
  });

  it('a file gone since the folder was listed says so, and leaves the open diagram and its edits alone', async () => {
    const demo = h.addProject('Demo Project', ['open.draftcanvas', 'sub/gone.draftcanvas']);
    h.listProjects(demo);
    await h.controller.start();
    await h.controller.scanProjects([demo]);
    await h.controller.openProjectFile(demo, 'open.draftcanvas');
    await h.settle();
    h.edit(documentText('open, edited'));
    await h.settle();
    const before = h.store.getSnapshot().doc;

    h.setProjectFile(demo, 'sub/gone.draftcanvas', null);
    await h.controller.openProjectFile(demo, 'sub/gone.draftcanvas');
    await h.settle();

    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]!.message).toMatch(/couldn’t find/i);
    expect(h.store.getSnapshot().doc).toEqual(before);
    expect(h.loads()).toHaveLength(1);
  });

  it('a file in a subfolder that isn’t a diagram is refused by name, and the open diagram stays', async () => {
    const demo = h.addProject('Demo Project', ['open.draftcanvas', 'sub/broken.draftcanvas']);
    h.listProjects(demo);
    await h.controller.start();
    await h.controller.scanProjects([demo]);
    await h.controller.openProjectFile(demo, 'open.draftcanvas');
    await h.settle();

    h.setProjectFile(demo, 'sub/broken.draftcanvas', '{ "format": "draft-canvas", truncated');
    await h.controller.openProjectFile(demo, 'sub/broken.draftcanvas');
    await h.settle();

    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]!.title).toContain('broken.draftcanvas');
    expect(h.store.getSnapshot().doc).toMatchObject({ kind: 'file', name: 'open' });
    expect(h.loads()).toHaveLength(1);
  });
});
