// CADZILLA/Partacular core document model. RULE: no three.js imports in this file, ever.
// The document is plain data; renderers subscribe to change events.

export interface PartTransform {
  position: [number, number, number];
  rotationY: number;
  scale: number;
}

export interface PartMeta {
  id: string;
  name: string;
  triCount: number;
  visible: boolean;
  transform: PartTransform;
}

export const identityTransform = (): PartTransform => ({ position: [0, 0, 0], rotationY: 0, scale: 1 });
const cloneT = (t: PartTransform): PartTransform => ({ position: [...t.position], rotationY: t.rotationY, scale: t.scale });

export type DocEvent =
  | { type: 'reset' }
  | { type: 'parts-added'; ids: string[] }
  | { type: 'part-removed'; id: string }
  | { type: 'part-visibility'; id: string; visible: boolean }
  | { type: 'part-transform'; id: string }
  | { type: 'selection'; id: string | null }
  | { type: 'explode'; factor: number };

type Listener = (e: DocEvent) => void;

type UndoStep =
  | { kind: 'delete'; id: string }
  | { kind: 'hide'; id: string }
  | { kind: 'transform'; id: string; before: PartTransform };

export class Document {
  private parts = new Map<string, PartMeta>();
  private order: string[] = [];
  private removed = new Map<string, PartMeta>(); // kept for undo
  private listeners: Listener[] = [];
  private undoStack: UndoStep[] = [];
  private transformBefore: PartTransform | null = null;
  private transformId: string | null = null;
  selectedId: string | null = null;
  explodeFactor = 0;

  on(fn: Listener) { this.listeners.push(fn); }
  private emit(e: DocEvent) { for (const fn of this.listeners) fn(e); }

  reset() {
    this.parts.clear(); this.order = []; this.removed.clear();
    this.undoStack = []; this.selectedId = null; this.explodeFactor = 0;
    this.transformBefore = null; this.transformId = null;
    this.emit({ type: 'reset' });
  }

  addParts(metas: PartMeta[]) {
    for (const m of metas) { this.parts.set(m.id, m); this.order.push(m.id); }
    this.emit({ type: 'parts-added', ids: metas.map(m => m.id) });
  }

  list(): PartMeta[] { return this.order.filter(id => this.parts.has(id)).map(id => this.parts.get(id)!); }
  get(id: string): PartMeta | undefined { return this.parts.get(id); }
  count(): number { return this.parts.size; }

  select(id: string | null) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.emit({ type: 'selection', id });
  }

  deletePart(id: string) {
    const m = this.parts.get(id); if (!m) return;
    this.parts.delete(id); this.removed.set(id, m);
    this.undoStack.push({ kind: 'delete', id });
    if (this.selectedId === id) this.select(null);
    this.emit({ type: 'part-removed', id });
  }

  setVisible(id: string, visible: boolean, recordUndo = true) {
    const m = this.parts.get(id); if (!m || m.visible === visible) return;
    m.visible = visible;
    if (!visible && recordUndo) this.undoStack.push({ kind: 'hide', id });
    if (this.selectedId === id && !visible) this.select(null);
    this.emit({ type: 'part-visibility', id, visible });
  }

  // ---- transforms: begin -> update... -> end (one undo step per gesture) ----
  beginTransform(id: string) {
    const m = this.parts.get(id); if (!m) return;
    this.transformId = id;
    this.transformBefore = cloneT(m.transform);
  }

  updateTransform(id: string, t: Partial<PartTransform>) {
    const m = this.parts.get(id); if (!m) return;
    if (t.position) m.transform.position = [...t.position];
    if (t.rotationY !== undefined) m.transform.rotationY = t.rotationY;
    if (t.scale !== undefined) m.transform.scale = t.scale;
    this.emit({ type: 'part-transform', id });
  }

  endTransform() {
    if (!this.transformId || !this.transformBefore) { this.transformId = null; this.transformBefore = null; return; }
    const m = this.parts.get(this.transformId);
    if (m) {
      const b = this.transformBefore, a = m.transform;
      const changed = b.rotationY !== a.rotationY || b.scale !== a.scale ||
        b.position[0] !== a.position[0] || b.position[1] !== a.position[1] || b.position[2] !== a.position[2];
      if (changed) this.undoStack.push({ kind: 'transform', id: this.transformId, before: this.transformBefore });
    }
    this.transformId = null; this.transformBefore = null;
  }

  canUndo(): boolean { return this.undoStack.length > 0; }

  undo(): string | null {
    const step = this.undoStack.pop(); if (!step) return null;
    if (step.kind === 'delete') {
      const m = this.removed.get(step.id);
      if (m) { this.removed.delete(step.id); this.parts.set(step.id, m); this.emit({ type: 'parts-added', ids: [step.id] }); }
      return m ? m.name : null;
    }
    if (step.kind === 'hide') {
      const m = this.parts.get(step.id);
      if (m) { m.visible = true; this.emit({ type: 'part-visibility', id: step.id, visible: true }); }
      return m ? m.name : null;
    }
    // transform
    const m = this.parts.get(step.id);
    if (m) { m.transform = cloneT(step.before); this.emit({ type: 'part-transform', id: step.id }); }
    return m ? m.name : null;
  }

  setExplode(factor: number) {
    this.explodeFactor = factor;
    this.emit({ type: 'explode', factor });
  }
}
