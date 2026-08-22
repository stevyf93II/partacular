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
  onCarve: () => void;
  onJoin: () => void;
  onTidy: () => void;
  onBulkDelete: () => void;
  onBulkHide: () => void;
  onBulkMerge: () => void;
  onSelectTiny: () => void;
  onRake: (deg: number, phase: 'start' | 'move' | 'end') => void;
  onStanceTargets: () => string;
  onPickTake: () => void;
  onPickDelete: () => void;
  onPickColor: () => void;
  onPickCancel: () => void;
  onPickStep: (delta: number) => void;
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
  $('picktake').addEventListener('click', () => hooks.onPickTake());
  $('pickdelete').addEventListener('click', () => hooks.onPickDelete());
  $('pickcolor').addEventListener('click', () => hooks.onPickColor());
  $('pickcancel').addEventListener('click', () => hooks.onPickCancel());
  $('pickmore').addEventListener('click', () => hooks.onPickStep(1));
  $('pickless').addEventListener('click', () => hooks.onPickStep(-1));
  $('pillcarve').addEventListener('click', () => hooks.onCarve());
  $('pilljoin').addEventListener('click', () => hooks.onJoin());
  $('pillcopy').addEventListener('click', () => hooks.onDuplicate());
  $('pillcolor').addEventListener('click', () => hooks.onRecolor());
  $('fitbtn').addEventListener('click', () => hooks.onFit());
  $('tidybtn').addEventListener('click', () => hooks.onTidy());

  // ---- stance: one rake slider, one undo step per stroke ---------------------
  const stancerow = $('stancerow');
  const rake = $('rake') as HTMLInputElement;
  const rakev = $('rakev');
  let raking = false;
  const showStance = (on: boolean) => {
    stancerow.style.display = on ? 'flex' : 'none';
    if (on) {
      rake.value = '0';
      rakev.textContent = '0.0°';
      $('stancename').textContent = hooks.onStanceTargets();
    }
  };
  $('stancebtn').addEventListener('click', () => showStance(stancerow.style.display === 'none'));
  $('stancedone').addEventListener('click', () => showStance(false));
  $('stancelevel').addEventListener('click', () => {
    // Back to flat from wherever the slider is, as one action.
    hooks.onRake(0, 'start');
    hooks.onRake(0, 'end');
    rake.value = '0';
    rakev.textContent = '0.0°';
  });
  rake.addEventListener('input', () => {
    const deg = Number(rake.value) / 10;
    rakev.textContent = deg.toFixed(1) + '°';
    if (!raking) { raking = true; hooks.onRake(deg, 'start'); }
    hooks.onRake(deg, 'move');
  });
  const endRake = () => {
    if (!raking) return;
    raking = false;
    hooks.onRake(Number(rake.value) / 10, 'end');
  };
  rake.addEventListener('change', endRake);
  rake.addEventListener('pointerup', endRake);

  // ---- parts list -----------------------------------------------------------
  const panel = $('partspanel');
  const list = $('partslist');
  const bulk = $('partsbulk');
  const openPanel = (on: boolean) => panel.classList.toggle('show', on);
  $('partsbtn').addEventListener('click', () => openPanel(!panel.classList.contains('show')));
  $('partsclose').addEventListener('click', () => openPanel(false));
  $('selectall').addEventListener('click', () => doc.selectMany(doc.list().map(m => m.id)));
  $('selectnone').addEventListener('click', () => doc.select(null));
  $('selecttiny').addEventListener('click', () => hooks.onSelectTiny());
  $('bulkdelete').addEventListener('click', () => hooks.onBulkDelete());
  $('bulkhide').addEventListener('click', () => hooks.onBulkHide());
  $('bulkmerge').addEventListener('click', () => hooks.onBulkMerge());

  /**
   * Rebuild the list.
   *
   * Rows are rebuilt wholesale rather than diffed: a hundred rows is nothing to
   * build, and any cleverness here would be a source of stale state for no
   * measurable gain.
   */
  function renderParts() {
    const metas = doc.list();
    $('partspanelcount').textContent = `${metas.length}`;
    list.innerHTML = '';
    for (const m of metas) {
      const row = document.createElement('button');
      row.className = 'prow' + (doc.isSelected(m.id) ? ' on' : '') + (m.visible ? '' : ' off');
      const sw = document.createElement('span');
      sw.className = 'sw';
      sw.style.background = '#' + m.color.toString(16).padStart(6, '0');
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = m.name;
      const ct = document.createElement('span');
      ct.className = 'ct';
      ct.textContent = m.triCount.toLocaleString();
      row.append(sw, nm, ct);
      if (!m.visible) {
        const eye = document.createElement('span');
        eye.className = 'eye';
        eye.textContent = 'hidden';
        row.append(eye);
      }
      // Tap adds to the selection instead of replacing it: picking out twenty
      // scraps to delete is the whole reason this list exists.
      row.addEventListener('click', () => doc.toggleSelect(m.id));
      list.appendChild(row);
    }
    const n = doc.selectedIds.size;
    bulk.classList.toggle('show', n > 0);
    $('partsbulkn').textContent = `${n} selected`;
    ($('bulkmerge') as HTMLButtonElement).disabled = n < 2;
  }

  doc.on(e => {
    if (e.type === 'parts-added' || e.type === 'part-removed' || e.type === 'reset'
      || e.type === 'selection' || e.type === 'part-visibility' || e.type === 'part-color') {
      renderParts();
    }
  });
  renderParts();
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
    // phones: the pill + sliders + explode stack buries the model — while the
    // size panel is open it is the ONLY bottom row, with its own Done button.
    pill.classList.toggle('hidden-for-size', sizeOpen);
    $('exploderow').style.display = sizeOpen ? 'none' : 'flex';
    if (sizeOpen) {
      $('sizename').textContent = doc.get(doc.selectedId!)?.name ?? 'part';
      syncSliders();
    }
  }
  $('pillsize').addEventListener('click', () => setSizeOpen(!sizeOpen));
  $('sizedone').addEventListener('click', () => setSizeOpen(false));
  const bottombar = document.querySelector('.bottombar') as HTMLElement;
  const stopAdjusting = () => bottombar.classList.remove('adjusting');
  window.addEventListener('pointerup', stopAdjusting);
  window.addEventListener('pointercancel', stopAdjusting);
  for (const s of sliders) {
    s.input.addEventListener('pointerdown', () => {
      if (doc.selectedId) doc.beginTransform(doc.selectedId);
      // ghost the panel while dragging so the part resizes in full view
      bottombar.classList.add('adjusting');
    });
    s.input.addEventListener('input', () => {
      const sel = doc.selectedId; if (!sel) return;
      const m = doc.get(sel); if (!m) return;
      const scale = [...m.transform.scale] as [number, number, number];
      scale[s.axis] = toScale(Number(s.input.value));
      doc.updateTransform(sel, { scale });
      s.out.textContent = scale[s.axis].toFixed(2) + '×';
    });
    s.input.addEventListener('change', () => { doc.endTransform(); stopAdjusting(); });
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
