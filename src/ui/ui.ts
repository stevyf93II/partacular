import { Document } from '../core/document';

export interface UIHooks {
  onFile: (f: File) => void;
  onDemo: () => void;
  onRotate: () => void;
}

export function initUI(doc: Document, hooks: UIHooks) {
  const $ = (id: string) => document.getElementById(id)!;
  const drop = $('drop'), pill = $('pill'), pillname = $('pillname');
  const partcount = $('partcount'), toast = $('toast'), undoBtn = $('undo') as HTMLButtonElement;
  const fileinput = $('fileinput') as HTMLInputElement;

  const pickFile = () => fileinput.click();
  $('uploadbtn').addEventListener('click', pickFile);
  $('openbtn').addEventListener('click', pickFile);
  $('demobtn').addEventListener('click', () => hooks.onDemo());
  fileinput.addEventListener('change', () => { const f = fileinput.files?.[0]; if (f) hooks.onFile(f); fileinput.value = ''; });

  addEventListener('dragover', e => e.preventDefault());
  addEventListener('drop', e => { e.preventDefault(); const f = (e as DragEvent).dataTransfer?.files?.[0]; if (f) hooks.onFile(f); });

  ($('explode') as HTMLInputElement).addEventListener('input', e =>
    doc.setExplode(Number((e.target as HTMLInputElement).value) / 100));

  $('pilldel').addEventListener('click', () => { if (doc.selectedId) doc.deletePart(doc.selectedId); });
  $('pillrot').addEventListener('click', () => hooks.onRotate());
  $('pillhide').addEventListener('click', () => { if (doc.selectedId) doc.setVisible(doc.selectedId, false); });
  undoBtn.addEventListener('click', () => { const name = doc.undo(); if (name) showToast(`Restored ${name}`); refresh(); });

  let toastTimer = 0;
  function showToast(msg: string) {
    toast.textContent = msg; toast.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2200) as unknown as number;
  }

  function refresh() {
    const n = doc.count();
    partcount.textContent = n === 0 ? 'no model' : `${n} part${n === 1 ? '' : 's'}`;
    undoBtn.classList.toggle('show', doc.canUndo());
    const sel = doc.selectedId;
    if (sel) { pillname.textContent = doc.get(sel)?.name ?? 'part'; pill.classList.add('show'); }
    else pill.classList.remove('show');
  }

  doc.on(e => {
    if (e.type === 'part-transform') { refresh(); return; }
    refresh();
    if (e.type === 'parts-added' && drop.classList.contains('hidden') === false && doc.count() > 0) drop.classList.add('hidden');
    if (e.type === 'part-removed') showToast('Part deleted — Undo is top right');
  });

  return { showToast, showHome: () => drop.classList.remove('hidden') };
}
