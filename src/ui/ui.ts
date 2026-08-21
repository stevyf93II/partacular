import { Document } from '../core/document';

export interface UIHooks {
  onFile: (f: File) => void;
  onDemo: () => void;
  onRotate: () => void;
  onDuplicate: () => void;
  onRecolor: () => void;
  onExport: (kind: 'glb' | 'stl' | '3mf') => void;
  onFit: () => void;
  onSplitToggle: () => void;
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
  $('pillcopy').addEventListener('click', () => hooks.onDuplicate());
  $('pillcolor').addEventListener('click', () => hooks.onRecolor());
  $('fitbtn').addEventListener('click', () => hooks.onFit());
  $('splitbtn').addEventListener('click', () => hooks.onSplitToggle());
  const sheet = $('sheet');
  $('savebtn').addEventListener('click', () => sheet.classList.add('show'));
  $('sheetcancel').addEventListener('click', () => sheet.classList.remove('show'));
  sheet.addEventListener('click', e => { if (e.target === sheet) sheet.classList.remove('show'); });
  $('exportglb').addEventListener('click', () => { sheet.classList.remove('show'); hooks.onExport('glb'); });
  $('exportstl').addEventListener('click', () => { sheet.classList.remove('show'); hooks.onExport('stl'); });
  $('export3mf').addEventListener('click', () => { sheet.classList.remove('show'); hooks.onExport('3mf'); });
  $('pillhide').addEventListener('click', () => { if (doc.selectedId) doc.setVisible(doc.selectedId, false); });

  // ---- per-axis resize: Size button toggles three log-scale sliders (0.1x-10x).
  // Each slider stroke is one undo step (beginTransform on grab, endTransform on release).
  const sizerow = $('sizerow');
  let sizeOpen = false;
  const sliders = [
    { input: $('scalex') as HTMLInputElement, out: $('scalexv'), axis: 0 },
    { input: $('scaley') as HTMLInputElement, out: $('scaleyv'), axis: 1 },
    { input: $('scalez') as HTMLInputElement, out: $('scalezv'), axis: 2 },
  ];
  const toScale = (v: number) => Math.pow(10, (v - 50) / 50);        // 0..100 -> 0.1x..10x
  const toSlider = (sc: number) => Math.max(0, Math.min(100, 50 + 50 * Math.log10(sc)));
  function syncSliders() {
    const sel = doc.selectedId; if (!sel) return;
    const m = doc.get(sel); if (!m) return;
    for (const s of sliders) {
      s.input.value = String(toSlider(m.transform.scale[s.axis]));
      s.out.textContent = m.transform.scale[s.axis].toFixed(2) + '×';
    }
  }
  function setSizeOpen(open: boolean) {
    sizeOpen = open && doc.selectedId !== null;
    sizerow.style.display = sizeOpen ? 'flex' : 'none';
    if (sizeOpen) syncSliders();
  }
  $('pillsize').addEventListener('click', () => setSizeOpen(!sizeOpen));
  for (const s of sliders) {
    s.input.addEventListener('pointerdown', () => { if (doc.selectedId) doc.beginTransform(doc.selectedId); });
    s.input.addEventListener('input', () => {
      const sel = doc.selectedId; if (!sel) return;
      const m = doc.get(sel); if (!m) return;
      const scale = [...m.transform.scale] as [number, number, number];
      scale[s.axis] = toScale(Number(s.input.value));
      doc.updateTransform(sel, { scale });
      s.out.textContent = scale[s.axis].toFixed(2) + '×';
    });
    s.input.addEventListener('change', () => doc.endTransform());
  }
  undoBtn.addEventListener('click', () => { const name = doc.undo(); if (name) showToast(`Restored ${name}`); refresh(); });

  let toastTimer = 0;
  function showToast(msg: string) {
    toast.textContent = msg; toast.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2200) as unknown as number;
  }

  function refresh() {
    const n = doc.count();
    partcount.textContent = n === 0 ? 'no model' : `${n} part${n === 1 ? '' : 's'}`;
    const splitBtn = $('splitbtn') as HTMLButtonElement;
    splitBtn.style.display = n === 0 ? 'none' : 'inline-block';
    splitBtn.textContent = n > 1 ? 'Merge' : 'Split';
    undoBtn.classList.toggle('show', doc.canUndo());
    const sel = doc.selectedId;
    if (sel) {
      const meta = doc.get(sel);
      pillname.textContent = meta?.name ?? 'part';
      ($('pillcolor') as HTMLButtonElement).style.background = '#' + (meta?.color ?? 0x4da3ff).toString(16).padStart(6, '0');
      pill.classList.add('show');
    }
    else { pill.classList.remove('show'); setSizeOpen(false); }
  }

  doc.on(e => {
    if (e.type === 'part-transform') { refresh(); if (sizeOpen) syncSliders(); return; }
    if (e.type === 'selection' && sizeOpen) syncSliders();
    refresh();
    if (e.type === 'parts-added' && drop.classList.contains('hidden') === false && doc.count() > 0) drop.classList.add('hidden');
    if (e.type === 'part-removed') showToast('Part deleted — Undo is top right');
  });

  return { showToast, showHome: () => drop.classList.remove('hidden') };
}
