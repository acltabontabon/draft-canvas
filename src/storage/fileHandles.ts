/** Browser file capabilities stay outside the portable document and desktop API. */
export interface LocalFileHandle {
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
  queryPermission(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  isSameEntry(other: LocalFileHandle): Promise<boolean>;
}

export interface FileAssociation {
  documentId: string;
  handle: LocalFileHandle;
  diskHash: string;
  savedContentHash: string;
  savedAt: number | null;
}

export interface BrowserFileAdapter {
  open(): Promise<LocalFileHandle | null>;
  save(name: string): Promise<LocalFileHandle | null>;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
}

type PickerWindow = Window & {
  showOpenFilePicker?: (options: unknown) => Promise<LocalFileHandle[]>;
  showSaveFilePicker?: (options: unknown) => Promise<LocalFileHandle>;
};

export function supportsBrowserFiles(): boolean {
  if (typeof window === 'undefined') return false;
  const browser = window as PickerWindow;
  return window.isSecureContext && window.top === window && !!browser.showOpenFilePicker && !!browser.showSaveFilePicker && !!navigator.locks;
}

const types = [{ description: 'Draft Canvas diagram', accept: { 'application/json': ['.draftcanvas'] } }];
export const browserFileAdapter: BrowserFileAdapter = {
  async open() { return (await (window as PickerWindow).showOpenFilePicker!({ multiple: false, types }))[0] ?? null; },
  save(name) { return (window as PickerWindow).showSaveFilePicker!({ suggestedName: name, types }); },
  // One origin-wide lock also serializes Save As attempts targeting the same previously unknown file.
  exclusive(work) { return navigator.locks.request('draft-canvas:file-write', work); },
};

export interface BrowserFileActions {
  open: () => Promise<void>;
  save: (as?: boolean) => Promise<void>;
  refreshOnOpen: (id: string) => Promise<boolean>;
  updateStatus: () => Promise<void>;
}

export interface FileQuestion {
  title: string;
  message: string;
  options: { id: string; label: string }[];
  answer: (id: string) => void;
}
