import { flushSync } from 'react-dom';
import { isEditableTarget } from '../../lib/isEditableTarget';
import { useEffect, useRef, useState } from 'react';
import { ToolbarMenu } from '../Editor/toolbar/ToolbarMenu';
import { useUiStore } from '../../store/uiStore';
import { Button } from './Button';
import { Modal } from './Modal';

export function BrowserFileButtons({ editor = false }: { editor?: boolean }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ rect: DOMRect; trigger: HTMLElement } | null>(null);
  const files = useUiStore((state) => state.browserFiles);
  const readOnly = useUiStore((state) => state.readOnly);
  if (!files) return null;
  if (!editor) return <Button variant="quiet" onClick={() => void files.open()}>Open file…</Button>;
  const close = () => { setMenu(null); trigger.current?.focus(); };
  return <>
    <Button ref={trigger} variant="quiet" icon="file" aria-label="File" aria-haspopup="menu" aria-expanded={menu !== null} onClick={(event) => {
      const element = event.currentTarget;
      setMenu(menu ? null : { rect: element.getBoundingClientRect(), trigger: element });
    }} />
    {menu && <ToolbarMenu label="File" anchorRect={menu.rect} trigger={menu.trigger} onDismiss={close} items={[
      { id: 'open', label: 'Open file…', onSelect: () => { close(); void files.open(); } },
      ...(!readOnly ? [
        { id: 'save', label: 'Save', onSelect: () => { close(); void files.save(); } },
        { id: 'save-as', label: 'Save As…', onSelect: () => { close(); void files.save(true); } },
      ] : []),
    ]} />}
  </>;
}

export function BrowserFileDialog() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const ui = useUiStore.getState();
      const files = ui.browserFiles;
      if (!files || event.defaultPrevented || document.querySelector('[role="dialog"]') || ui.flowTrace || ui.interactionActive) return;
      const key = event.key.toLowerCase();
      if (!(event.metaKey || event.ctrlKey) || !['s', 'o'].includes(key)) return;
      if (key === 's' && !document.querySelector('.dc-editor')) return;
      event.preventDefault();
      event.stopPropagation();
      // Capture reaches chords that inline editors keep from bubbling. Commit their blur before
      // taking the snapshot, synchronously so the picker retains this same user activation.
      const active = document.activeElement;
      if (isEditableTarget(active)) flushSync(() => (active as HTMLElement).blur());
      if (key === 'o') void files.open();
      else void files.save(event.shiftKey);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const question = useUiStore((state) => state.fileQuestion);
  if (!question) return null;
  return <Modal title={question.title} onClose={() => question.answer('cancel')} footer={<>
    {question.options.map((option) => <Button key={option.id} variant="quiet" onClick={() => question.answer(option.id)}>{option.label}</Button>)}
  </>}><p>{question.message}</p></Modal>;
}
