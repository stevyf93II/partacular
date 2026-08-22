import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { Document } from '../core/document';
import { getGeometry } from '../geometry/store';
import { PickIndex, Touched, cachedPickIndex, maskFor, pickIndexFor, rungCount, touchAt } from '../geometry/pickClient';

// BVH-accelerated raycasting: without this, every tap tests every triangle —
// a 2M-tri AI scan made selection take hundreds of ms per pointer event
// (reads as \"touch is dead\"). With a bounds tree it's sub-millisecond.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

interface PartVisual { mesh: THREE.Mesh; baseCenter: THREE.Vector3; explodeDir: THREE.Vector3; }

type GestureMode = 'none' | 'camera' | 'move' | 'pinch' | 'stroke' | 'picking';

/** A live touch-selection: what was touched, and how far out it has been grown. */
export interface PickState {
  partId: string;
  index: PickIndex;
  touch: Touched;
  level: number;
  triangles: number;
}

/** Above this the highlight overlay is not worth building; the whole part lights instead. */
const HIGHLIGHT_CAP = 800_000;

/** A repair the user armed from the UI but has not yet drawn or picked. */
type RepairMode =
  | null
  | { kind: 'lasso'; done: (strokeNDC: Float32Array, mvp: Float32Array) => void }
  | { kind: 'merge'; done: (otherId: string) => void };

export class Viewport {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private raycaster = (() => { const r = new THREE.Raycaster(); r.firstHitOnly = true; return r; })();
  private visuals = new Map<string, PartVisual>();
  private modelCenter = new THREE.Vector3();
  private grid!: THREE.GridHelper;
  private gridSize = 10;
  private modelRadius = 1;
  private lastTap = { x: -999, y: -999, hits: [] as string[], cursor: 0 };

  // repair: freehand stroke capture, drawn on a 2D canvas above the GL canvas
  private overlay!: HTMLCanvasElement;
  private octx!: CanvasRenderingContext2D;
  private repairMode: RepairMode = null;
  private strokePx: number[] = [];

  // touch-to-select
  private pick: PickState | null = null;
  private highlight: THREE.Mesh | null = null;
  private pickLevelAtGrab = 0;
  /** finger landed on the lit piece; a drag from here pulls it out */
  private pullArmed = false;
  /** told when the live selection changes, so the UI can show what is held */
  onPick: (state: PickState | null) => void = () => {};
  /** told when a part's index has to be built first (slow, once per part) */
  onPickPending: (partId: string, ready: boolean) => void = () => {};
  /**
   * Asked to turn the held selection into a real part, returning its id.
   *
   * Lives outside the viewport because it mutates the document, but has to be
   * callable mid-gesture: grabbing a highlighted piece and pulling it away is
   * one motion, not select-then-press-a-button-then-drag.
   */
  onExtractRequest: () => string | null = () => null;

  // gesture state
  private pointers = new Map<number, { x: number; y: number }>();
  private mode: GestureMode = 'none';
  private moved = false;
  private downX = 0; private downY = 0; private downT = 0;
  private dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private dragStartHit = new THREE.Vector3();
  private dragStartPos: [number, number, number] = [0, 0, 0];
  private pinchStartDist = 1; private pinchStartAngle = 0;
  private pinchStartScale: [number, number, number] = [1, 1, 1];
  private pinchStartQuat: [number, number, number, number] = [0, 0, 0, 1];

  constructor(container: HTMLElement, private doc: Document) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    container.appendChild(this.renderer.domElement);

    // Stroke overlay. A separate 2D canvas keeps freehand ink out of the GL
    // pipeline entirely -- no scene objects, no re-render per pointer sample.
    this.overlay = document.createElement('canvas');
    this.overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5';
    container.appendChild(this.overlay);
    this.octx = this.overlay.getContext('2d')!;
    this.sizeOverlay();

    this.scene.background = new THREE.Color(0x0d0f14);
    // Guard the initial aspect too: a hidden/zero-size window at load time gives 0/0 = NaN.
    const safeAspect = innerWidth > 0 && innerHeight > 0 ? innerWidth / innerHeight : 1;
    this.camera = new THREE.PerspectiveCamera(55, safeAspect, 0.01, 1000);
    this.camera.position.set(3, 2.2, 3.5);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x2a2418, 1.0);
    const key = new THREE.DirectionalLight(0xffffff, 2.0); key.position.set(4, 7, 4);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.7); rim.position.set(-5, 3, -4);
    this.scene.add(hemi, key, rim);
    this.grid = new THREE.GridHelper(10, 20, 0x2a3140, 0x1d2330);
    this.scene.add(this.grid);

    addEventListener('resize', () => {
      // iOS/desktop can fire resize with zero dimensions mid-transition;
      // 0/0 = NaN aspect poisons the projection matrix (kills raycast + render).
      if (innerWidth <= 0 || innerHeight <= 0) return;
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
      this.sizeOverlay();
    });

    // Gesture routing (capture phase so we can mute OrbitControls before it reacts):
    // tap = select; drag ON the selected part = move; two fingers starting on it = pinch scale + twist;
    // anything else = camera.
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', e => this.onPointerDown(e), true);
    el.addEventListener('pointermove', e => this.onPointerMove(e), true);
    el.addEventListener('pointerup', e => this.onPointerUp(e), true);
    el.addEventListener('pointercancel', e => this.onPointerUp(e), true);
    el.addEventListener('wheel', e => this.onWheel(e), { capture: true, passive: false });
    // Safety nets: a finger-up that escapes the canvas, or the app losing focus,
    // must never leave a phantom pointer behind (stale pointers = dead touch UI).
    window.addEventListener('pointerup', e => this.onPointerUp(e));
    window.addEventListener('pointercancel', e => this.onPointerUp(e));
    window.addEventListener('blur', () => this.resetGestures());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.resetGestures(); });

    doc.on(e => {
      if (e.type === 'reset') this.clearVisuals();
      else if (e.type === 'parts-added') { for (const id of e.ids) this.addVisual(id); this.refreshModelBounds(); this.applyAll(); }
      else if (e.type === 'part-removed') this.removeVisual(e.id);
      else if (e.type === 'part-visibility') { const v = this.visuals.get(e.id); if (v) v.mesh.visible = e.visible; }
      else if (e.type === 'part-transform') this.applyOne(e.id);
      else if (e.type === 'part-color') { const v = this.visuals.get(e.id); if (v) (v.mesh.material as THREE.MeshStandardMaterial).color.setHex(e.color); }
      else if (e.type === 'selection') this.applySelectionStyle();
      else if (e.type === 'explode') this.applyAll();
    });

    const loop = () => {
      requestAnimationFrame(loop);
      // Self-heal: if NaN ever reaches the projection matrix, rebuild it.
      if (!Number.isFinite(this.camera.projectionMatrix.elements[0])) {
        if (innerWidth > 0 && innerHeight > 0) {
          this.camera.aspect = innerWidth / innerHeight;
          if (!Number.isFinite(this.camera.near) || this.camera.near <= 0) this.camera.near = 0.01;
          if (!Number.isFinite(this.camera.far) || this.camera.far <= this.camera.near) this.camera.far = 1000;
          this.camera.updateProjectionMatrix();
          this.renderer.setSize(innerWidth, innerHeight);
        }
      }
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  // ---------- repair modes ----------
  private sizeOverlay() {
    const dpr = Math.min(devicePixelRatio, 2);
    this.overlay.width = Math.max(1, Math.floor(innerWidth * dpr));
    this.overlay.height = Math.max(1, Math.floor(innerHeight * dpr));
    this.overlay.style.width = innerWidth + 'px';
    this.overlay.style.height = innerHeight + 'px';
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  isRepairing(): boolean { return this.repairMode !== null; }

  /** Arm freehand mode: the next drag draws a lasso or cut over the selection. */
  beginLasso(done: (strokeNDC: Float32Array, mvp: Float32Array) => void) {
    this.repairMode = { kind: 'lasso', done };
    this.controls.enabled = false;
  }

  /** Arm merge mode: the next tap on another part reports its id. */
  beginMerge(done: (otherId: string) => void) {
    this.repairMode = { kind: 'merge', done };
  }

  cancelRepair() {
    this.repairMode = null;
    this.strokePx = [];
    this.clearOverlay();
    this.controls.enabled = true;
  }

  private clearOverlay() { this.octx.clearRect(0, 0, innerWidth, innerHeight); }

  private drawStroke() {
    this.clearOverlay();
    const n = this.strokePx.length / 2;
    if (n < 2) return;
    const c = this.octx;
    c.lineWidth = 2.5; c.lineJoin = 'round'; c.lineCap = 'round';
    c.strokeStyle = '#4da3ff';
    c.beginPath();
    c.moveTo(this.strokePx[0], this.strokePx[1]);
    for (let i = 1; i < n; i++) c.lineTo(this.strokePx[i * 2], this.strokePx[i * 2 + 1]);
    c.stroke();
    // A dashed chord back to the start shows, while the finger is still down,
    // that closing the loop turns the stroke into a region select.
    if (n > 4) {
      c.save();
      c.setLineDash([5, 5]);
      c.strokeStyle = 'rgba(77,163,255,0.35)';
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(this.strokePx[(n - 1) * 2], this.strokePx[(n - 1) * 2 + 1]);
      c.lineTo(this.strokePx[0], this.strokePx[1]);
      c.stroke();
      c.restore();
    }
  }

  /** MVP for a part AS CURRENTLY DRAWN, explode offset included. */
  private mvpFor(id: string): Float32Array | null {
    const v = this.visuals.get(id); if (!v) return null;
    v.mesh.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    const m = new THREE.Matrix4()
      .multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)
      .multiply(v.mesh.matrixWorld);
    return new Float32Array(m.elements);
  }

  private finishStroke() {
    const mode = this.repairMode;
    const sel = this.doc.selectedId;
    this.clearOverlay();
    if (!mode || mode.kind !== 'lasso' || !sel || this.strokePx.length < 6) {
      this.cancelRepair();
      return;
    }
    const mvp = this.mvpFor(sel);
    if (!mvp) { this.cancelRepair(); return; }
    const n = this.strokePx.length / 2;
    const ndc = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      ndc[i * 2] = (this.strokePx[i * 2] / innerWidth) * 2 - 1;
      ndc[i * 2 + 1] = -(this.strokePx[i * 2 + 1] / innerHeight) * 2 + 1;
    }
    this.repairMode = null;
    this.strokePx = [];
    this.controls.enabled = true;
    mode.done(ndc, mvp);
  }

  // ---------- gesture handlers ----------
  private selectedVisual(): PartVisual | null {
    return this.doc.selectedId ? this.visuals.get(this.doc.selectedId) ?? null : null;
  }

  private raycastAt(x: number, y: number): string[] {
    const ndc = new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = [...this.visuals.values()].filter(v => v.mesh.visible).map(v => v.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    const ids: string[] = [];
    for (const h of hits) { const id = (h.object as THREE.Mesh).userData.partId; if (!ids.includes(id)) ids.push(id); }
    return ids;
  }

  /** First hit with its triangle index — touch-select needs to know WHICH triangle. */
  private raycastFace(x: number, y: number): { partId: string; face: number } | null {
    const ndc = new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = [...this.visuals.values()].filter(v => v.mesh.visible).map(v => v.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit || hit.faceIndex == null) return null;
    return { partId: (hit.object as THREE.Mesh).userData.partId, face: hit.faceIndex };
  }

  // ---------- touch to select ----------

  /**
   * Whether a tap reaches INTO a part or just selects it.
   *
   * Split is the switch. Before it, the model is one fused mass and "select the
   * whole thing" says nothing, so a tap must mean a piece of it. After Split the
   * parts are real and a tap selects them, exactly as it always did.
   *
   * Deliberately not keyed on part count: taking a piece out leaves two parts
   * but the remainder is still a fused mass, and tapping it again has to keep
   * working.
   */
  private pickEnabled = true;
  setPickEnabled(on: boolean) {
    this.pickEnabled = on;
    if (!on) this.clearPick();
  }
  private wantsPick(_partId: string): boolean { return this.pickEnabled; }

  private beginPick(partId: string, face: number) {
    const index = cachedPickIndex(partId);
    if (!index) {
      // First touch on this part: the analysis is slow, so kick it off and say so.
      const geo = getGeometry(partId);
      if (!geo) return;
      this.onPickPending(partId, false);
      pickIndexFor(partId, geo)
        .then(() => this.onPickPending(partId, true))
        .catch(err => { console.error(err); this.onPickPending(partId, true); });
      return;
    }
    const touch = touchAt(index, face);
    if (!touch) return;
    this.pick = { partId, index, touch, level: touch.rung, triangles: 0 };
    this.pickLevelAtGrab = touch.rung;
    this.applyPick();
  }

  /** Grow or shrink the held selection. */
  setPickLevel(level: number) {
    if (!this.pick) return;
    const clamped = Math.max(0, Math.min(rungCount(this.pick.touch), level));
    if (clamped === this.pick.level) return;
    this.pick.level = clamped;
    this.applyPick();
  }

  clearPick() {
    if (this.highlight) {
      this.scene.remove(this.highlight);
      this.highlight.geometry.dispose();
      (this.highlight.material as THREE.Material).dispose();
      this.highlight = null;
    }
    this.pick = null;
    this.applySelectionStyle();
    this.onPick(null);
  }

  currentPick(): PickState | null { return this.pick; }

  /** The held selection as a triangle mask, for turning it into a real part. */
  pickMask(): Uint8Array | null {
    if (!this.pick) return null;
    return maskFor(this.pick.index, this.pick.touch, this.pick.level);
  }

  private applyPick() {
    const pk = this.pick;
    if (!pk) return;
    const mask = maskFor(pk.index, pk.touch, pk.level);
    let count = 0;
    for (let i = 0; i < mask.length; i++) count += mask[i];
    pk.triangles = count;

    if (this.highlight) {
      this.scene.remove(this.highlight);
      this.highlight.geometry.dispose();
      (this.highlight.material as THREE.Material).dispose();
      this.highlight = null;
    }

    const v = this.visuals.get(pk.partId);
    const base = getGeometry(pk.partId);
    if (!v || !base) return;

    // Everything not held drops back; the held piece is the only lit thing.
    for (const [id, vis] of this.visuals) {
      const mat = vis.mesh.material as THREE.MeshStandardMaterial;
      mat.opacity = id === pk.partId ? 0.16 : 0.1;
      mat.emissive.setHex(0x000000);
    }

    if (count > 0 && count <= HIGHLIGHT_CAP) {
      const geo = subsetGeometry(base, mask, count);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: 0x4da3ff, roughness: 0.5, metalness: 0.1,
        emissive: 0x143a66, side: THREE.DoubleSide,
        // The overlay is a copy of triangles that are still in the base mesh, so
        // it is exactly coplanar with them. Without a depth bias the two fight
        // for every pixel and the selection reads as torn.
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }));
      mesh.position.copy(v.mesh.position);
      mesh.rotation.copy(v.mesh.rotation);
      mesh.scale.copy(v.mesh.scale);
      this.scene.add(mesh);
      this.highlight = mesh;
    } else if (count > HIGHLIGHT_CAP) {
      // Too big to be worth a copy: light the whole part instead of an overlay.
      const mat = v.mesh.material as THREE.MeshStandardMaterial;
      mat.opacity = 1;
      mat.emissive.setHex(0x143a66);
    }
    this.onPick(pk);
  }

  /** Does this screen point land on the lit piece rather than the rest of the part? */
  private hitsHighlight(x: number, y: number): boolean {
    if (!this.highlight) return false;
    const ndc = new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.intersectObject(this.highlight, false).length > 0;
  }

  /** Start a move gesture on a part, as if the finger had landed on it. */
  private beginMoveOn(id: string, x: number, y: number) {
    const m = this.doc.get(id);
    if (!m) { this.mode = 'camera'; return; }
    this.doc.select(id);
    this.mode = 'move';
    this.controls.enabled = false;
    const worldCenter = new THREE.Vector3(...m.transform.position);
    const viewDir = new THREE.Vector3();
    this.camera.getWorldDirection(viewDir);
    this.dragPlane.setFromNormalAndCoplanarPoint(viewDir, worldCenter);
    this.planeHit(x, y, this.dragStartHit);
    this.dragStartPos = [...m.transform.position];
    this.doc.beginTransform(id);
  }

  private planeHit(x: number, y: number, out: THREE.Vector3): boolean {
    const ndc = new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray.intersectPlane(this.dragPlane, out) !== null;
  }

  private resetGestures() {
    this.pointers.clear();
    if (this.mode === 'move' || this.mode === 'pinch') this.doc.endTransform();
    if (this.mode === 'stroke') { this.strokePx = []; this.clearOverlay(); }
    this.pullArmed = false;
    this.mode = 'none';
    this.repairMode = null;
    this.controls.enabled = true;
  }

  private onPointerDown(e: PointerEvent) {
    try { this.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.repairMode && this.repairMode.kind === 'lasso' && this.pointers.size === 1) {
      this.mode = 'stroke';
      this.controls.enabled = false;
      this.strokePx = [e.clientX, e.clientY];
      this.downX = e.clientX; this.downY = e.clientY;
      this.downT = performance.now(); this.moved = false;
      return;
    }
    if (this.pointers.size === 1) {
      this.downX = e.clientX; this.downY = e.clientY; this.downT = performance.now(); this.moved = false;
      const sel = this.doc.selectedId;
      const hits = this.raycastAt(e.clientX, e.clientY);

      // A held selection takes the gesture. Landing ON the lit piece pulls it
      // out and drags it; landing on the rest of the part adjusts how much is
      // held. Both start from the same touch, which is what "pull that piece
      // away" has to mean.
      if (this.pick && hits.includes(this.pick.partId)) {
        this.controls.enabled = false;
        this.mode = 'picking';
        this.pickLevelAtGrab = this.pick.level;
        // Landing on the lit piece ARMS a pull, but does not perform it: a tap
        // has to leave the selection alone, or looking at what you have picked
        // would keep tearing it out of the model.
        this.pullArmed = !!this.highlight && this.hitsHighlight(e.clientX, e.clientY);
        return;
      }

      // Order matters. Dragging a part you already selected must still move it,
      // so that check comes first; anything else on a fused model reaches INSIDE
      // the part rather than selecting the whole of it.
      if (!(sel && hits.includes(sel)) && hits.length && this.wantsPick(hits[0])) {
        const face = this.raycastFace(e.clientX, e.clientY);
        if (face) {
          this.mode = 'picking';
          this.controls.enabled = false;
          this.beginPick(face.partId, face.face);
          return;
        }
      }

      if (sel && hits.includes(sel)) {
        // start MOVE on the selected part
        this.mode = 'move';
        this.controls.enabled = false;
        const m = this.doc.get(sel)!;
        const worldCenter = new THREE.Vector3(...m.transform.position);
        // screen-parallel plane through the part's center: finger up moves the part up
        const viewDir = new THREE.Vector3();
        this.camera.getWorldDirection(viewDir);
        this.dragPlane.setFromNormalAndCoplanarPoint(viewDir, worldCenter);
        this.planeHit(e.clientX, e.clientY, this.dragStartHit);
        this.dragStartPos = [...m.transform.position];
        this.doc.beginTransform(sel);
      } else {
        this.mode = 'camera';
      }
    } else if (this.pointers.size === 2 && (this.mode === 'move' || this.mode === 'pinch')) {
      // second finger while holding the part -> PINCH (scale + twist)
      this.mode = 'pinch';
      const [a, b] = [...this.pointers.values()];
      this.pinchStartDist = Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1);
      this.pinchStartAngle = Math.atan2(b.y - a.y, b.x - a.x);
      const m = this.doc.get(this.doc.selectedId!)!;
      this.pinchStartScale = [...m.transform.scale];
      this.pinchStartQuat = [...m.transform.rotation];
    }
  }

  private onPointerMove(e: PointerEvent) {
    const p = this.pointers.get(e.pointerId); if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > 8) this.moved = true;
    if (this.mode === 'picking') {
      if (!this.pick) return;
      if (this.pullArmed) {
        // Wait for a real drag before committing; below the slop this is still
        // a tap that happened to land on the piece.
        if (Math.hypot(e.clientX - this.downX, e.clientY - this.downY) < 8) return;
        this.pullArmed = false;
        const newId = this.onExtractRequest();
        if (newId) { this.beginMoveOn(newId, this.downX, this.downY); this.onPointerMove(e); }
        return;
      }
      // Up grows, down shrinks. A rung is now one neighbouring basin rather
      // than a whole cluster, so the travel per rung is shorter to match.
      this.setPickLevel(this.pickLevelAtGrab + Math.round((this.downY - e.clientY) / 22));
      return;
    }
    if (this.mode === 'stroke') {
      const n = this.strokePx.length;
      // Drop samples closer than 2px: they add cost and jitter, not shape.
      if (n < 2 || Math.hypot(e.clientX - this.strokePx[n - 2], e.clientY - this.strokePx[n - 1]) > 2) {
        this.strokePx.push(e.clientX, e.clientY);
        this.drawStroke();
      }
      return;
    }
    const sel = this.doc.selectedId;
    if (!sel) return;
    if (this.mode === 'move' && this.pointers.size === 1) {
      const hit = new THREE.Vector3();
      if (this.planeHit(e.clientX, e.clientY, hit)) {
        const d = hit.clone().sub(this.dragStartHit);
        this.doc.updateTransform(sel, { position: [this.dragStartPos[0] + d.x, this.dragStartPos[1] + d.y, this.dragStartPos[2] + d.z] });
      }
    } else if (this.mode === 'pinch' && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const f = dist / this.pinchStartDist; // uniform pinch preserves axis ratios
      const scale = this.pinchStartScale.map(v => THREE.MathUtils.clamp(v * f, 0.05, 50)) as [number, number, number];
      // Screen twist spins the part about Y, applied on top of whatever
      // orientation it already had rather than replacing it.
      const spin = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0), -(angle - this.pinchStartAngle));
      const q = new THREE.Quaternion().fromArray(this.pinchStartQuat).premultiply(spin);
      this.doc.updateTransform(sel, { scale, rotation: q.toArray() as [number, number, number, number] });
      this.moved = true;
    }
  }

  private onPointerUp(e: PointerEvent) {
    if (!this.pointers.has(e.pointerId)) return; // already handled (canvas + window both listen)
    this.pointers.delete(e.pointerId);
    if (this.mode === 'stroke') {
      if (this.pointers.size > 0) return;
      this.mode = 'none';
      this.finishStroke();
      return;
    }
    if (this.mode === 'picking') {
      if (this.pointers.size > 0) return;
      this.mode = 'none';
      this.pullArmed = false;
      this.controls.enabled = true;
      return;
    }
    if (this.pointers.size > 0) {
      // dropped one finger of a pinch: fall back to move with remaining finger re-anchored
      if (this.mode === 'pinch' && this.pointers.size === 1 && this.doc.selectedId) {
        const rest = [...this.pointers.values()][0];
        const m = this.doc.get(this.doc.selectedId)!;
        this.planeHit(rest.x, rest.y, this.dragStartHit);
        this.dragStartPos = [...m.transform.position];
        this.mode = 'move';
      }
      return;
    }
    // last finger lifted
    const dt = performance.now() - this.downT;
    const dist = Math.hypot(e.clientX - this.downX, e.clientY - this.downY);
    const wasTap = dt < 350 && dist < 10 && !this.moved;
    if (this.mode === 'move' || this.mode === 'pinch') {
      this.doc.endTransform();
      this.refreshModelBounds();
    }
    this.controls.enabled = true;
    this.mode = 'none';
    if (wasTap) this.handleTap(e.clientX, e.clientY);
  }

  private onWheel(e: WheelEvent) {
    // desktop: wheel over the SELECTED part scales it; elsewhere it zooms the camera
    const sel = this.doc.selectedId; if (!sel) return;
    const hits = this.raycastAt(e.clientX, e.clientY);
    if (!hits.includes(sel)) return;
    e.preventDefault(); e.stopPropagation();
    const m = this.doc.get(sel)!;
    this.doc.beginTransform(sel);
    const factor = Math.exp(-e.deltaY * 0.001);
    const scale = m.transform.scale.map(v => THREE.MathUtils.clamp(v * factor, 0.05, 50)) as [number, number, number];
    this.doc.updateTransform(sel, { scale });
    this.doc.endTransform();
  }

  rotateSelected45() {
    const sel = this.doc.selectedId; if (!sel) return;
    const m = this.doc.get(sel)!;
    this.doc.beginTransform(sel);
    const step = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4);
    const q = new THREE.Quaternion().fromArray(m.transform.rotation).premultiply(step);
    this.doc.updateTransform(sel, { rotation: q.toArray() as [number, number, number, number] });
    this.doc.endTransform();
  }

  // ---------- visuals ----------
  private clearVisuals() {
    if (this.pick) this.clearPick();
    for (const v of this.visuals.values()) { this.scene.remove(v.mesh); (v.mesh.material as THREE.Material).dispose(); }
    this.visuals.clear();
  }

  private addVisual(id: string) {
    if (this.visuals.has(id)) { const v = this.visuals.get(id)!; v.mesh.visible = this.doc.get(id)?.visible ?? true; this.applyOne(id); return; }
    const geo = getGeometry(id); if (!geo) return;
    const color = this.doc.get(id)?.color ?? 0x4da3ff;
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.1, transparent: true, opacity: 1 });
    if (!geo.boundsTree) geo.computeBoundsTree();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.partId = id;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const center = geo.boundingBox!.getCenter(new THREE.Vector3());
    this.scene.add(mesh);
    this.visuals.set(id, { mesh, baseCenter: center, explodeDir: new THREE.Vector3() });
  }

  private removeVisual(id: string) {
    if (this.pick && this.pick.partId === id) this.clearPick();
    const v = this.visuals.get(id); if (!v) return;
    this.scene.remove(v.mesh); this.visuals.delete(id);
    this.applySelectionStyle();
  }

  refreshModelBounds(fit = false) {
    // Bounds come from the DOCUMENT, never from the meshes as drawn: measuring
    // exploded meshes fed explode offsets back into the explode directions and
    // amplified them every gesture (runaway scatter bug).
    //
    // Each part contributes its real oriented bounding BOX. It used to
    // contribute a CUBE of side 2r around its centre, r being the bounding
    // SPHERE radius -- and a sphere radius is half the diagonal, so anything
    // long and flat was measured far larger than it is. On a car that inflated
    // the model radius enough to park the camera at roughly twice the distance
    // it should be, which is why models arrived tiny in the corner of the view.
    const box = new THREE.Box3();
    const mtx = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const partBox = new THREE.Box3();
    let any = false;
    for (const [id, v] of this.visuals) {
      const m = this.doc.get(id); if (!m) continue;
      const geo = v.mesh.geometry as THREE.BufferGeometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      if (!geo.boundingBox) continue;
      mtx.compose(
        new THREE.Vector3(...m.transform.position),
        quat.fromArray(m.transform.rotation),
        new THREE.Vector3(...m.transform.scale),
      );
      partBox.copy(geo.boundingBox).applyMatrix4(mtx);
      box.union(partBox);
      any = true;
    }
    if (!any) return;
    box.getCenter(this.modelCenter);
    this.modelRadius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.001);
    for (const [id, v] of this.visuals) {
      const m = this.doc.get(id); if (!m) continue;
      v.explodeDir.copy(new THREE.Vector3(...m.transform.position)).sub(this.modelCenter);
      if (v.explodeDir.lengthSq() < 1e-12) v.explodeDir.set(0, 1, 0).multiplyScalar(this.modelRadius * 0.05);
    }
    if (fit) {
      // Adaptive grid: a fixed 10-unit grid at the wrong model scale renders as
      // giant lines crossing the whole view (or an invisible speck). Rebuild it
      // near the model's own scale, and only when meaningfully off.
      const want = Math.pow(2, Math.ceil(Math.log2(Math.max(this.modelRadius * 3, 0.001))));
      if (want / this.gridSize > 1.9 || this.gridSize / want > 1.9) {
        this.scene.remove(this.grid);
        this.grid.geometry.dispose(); (this.grid.material as THREE.Material).dispose();
        this.grid = new THREE.GridHelper(want, 20, 0x2a3140, 0x1d2330);
        this.scene.add(this.grid);
        this.gridSize = want;
      }
      this.controls.target.copy(this.modelCenter);
      // Fit for the NARROWER of the two field-of-view angles. Framing on the
      // vertical alone leaves a wide model running off the sides of a phone in
      // portrait; framing on the horizontal alone does the same to a tall one.
      const size = box.getSize(new THREE.Vector3());
      const vFov = (this.camera.fov * Math.PI) / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(this.camera.aspect, 0.2));
      const dV = (Math.max(size.y, 0.001) / 2) / Math.tan(vFov / 2);
      const dH = (Math.max(size.x, size.z, 0.001) / 2) / Math.tan(hFov / 2);
      const d = Math.max(dV, dH, this.modelRadius * 0.5) * 1.35;
      // A three-quarter view: enough angle to read depth, flat enough that a
      // car still looks like a car rather than a plan drawing.
      const dir = new THREE.Vector3(0.62, 0.42, 0.9).normalize().multiplyScalar(d);
      this.camera.position.copy(this.modelCenter).add(dir);
      this.camera.near = this.modelRadius / 200; this.camera.far = this.modelRadius * 200;
      if (innerWidth > 0 && innerHeight > 0) this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      // Leash the camera so pinch-zoom can never run away to infinity.
      this.controls.minDistance = this.modelRadius * 0.15;
      this.controls.maxDistance = this.modelRadius * 8;
    }
  }

  fitCamera() { this.refreshModelBounds(true); }

  /** doc transform + explode offset -> mesh */
  private applyOne(id: string) {
    const v = this.visuals.get(id); const m = this.doc.get(id);
    if (!v || !m) return;
    const k = this.doc.explodeFactor;
    v.mesh.position.set(...m.transform.position).addScaledVector(v.explodeDir, k * 1.1);
    v.mesh.quaternion.fromArray(m.transform.rotation);
    v.mesh.scale.set(...m.transform.scale);
  }

  private applyAll() { for (const id of this.visuals.keys()) this.applyOne(id); }

  private handleTap(x: number, y: number) {
    const hitIds = this.raycastAt(x, y);
    if (this.pick && (hitIds.length === 0 || !hitIds.includes(this.pick.partId))) {
      this.clearPick();
      if (hitIds.length === 0) return;
    }
    // A tap that took hold of a piece has already said what it meant. Falling
    // through would ALSO select the whole part, and then the next tap would try
    // to move that part instead of reaching inside it again.
    if (this.pick) return;
    const mode = this.repairMode;
    if (mode && mode.kind === 'merge') {
      const other = hitIds.find(id => id !== this.doc.selectedId);
      this.repairMode = null;
      if (other) mode.done(other);
      return;
    }
    if (hitIds.length === 0) { this.doc.select(null); this.lastTap.hits = []; return; }
    const near = Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < 24;
    const sameStack = near && JSON.stringify(hitIds) === JSON.stringify(this.lastTap.hits);
    const cursor = sameStack ? (this.lastTap.cursor + 1) % hitIds.length : 0;
    this.lastTap = { x, y, hits: hitIds, cursor };
    this.doc.select(hitIds[cursor]);
  }

  private applySelectionStyle() {
    if (this.pick) return; // a held touch-selection owns the styling
    const doc = this.doc;
    const any = doc.selectedIds.size > 0;
    for (const [id, v] of this.visuals) {
      const mat = v.mesh.material as THREE.MeshStandardMaterial;
      if (!any) { mat.opacity = 1; mat.emissive.setHex(0x000000); continue; }
      if (!doc.isSelected(id)) { mat.opacity = 0.22; mat.emissive.setHex(0x000000); continue; }
      mat.opacity = 1;
      // The gesture target glows brighter than the rest of the selection, so it
      // is obvious which one a drag is about to move.
      mat.emissive.setHex(id === doc.selectedId ? 0x1c3f66 : 0x11293f);
    }
  }
}

/** The masked triangles of a geometry, copied out as a standalone soup. */
function subsetGeometry(src: THREE.BufferGeometry, mask: Uint8Array, count: number): THREE.BufferGeometry {
  const pos = src.getAttribute('position') as THREE.BufferAttribute;
  const index = src.getIndex();
  const out = new Float32Array(count * 9);
  let o = 0;
  for (let t = 0; t < mask.length; t++) {
    if (!mask[t]) continue;
    for (let c = 0; c < 3; c++) {
      const v = index ? index.getX(t * 3 + c) : t * 3 + c;
      out[o++] = pos.getX(v); out[o++] = pos.getY(v); out[o++] = pos.getZ(v);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  g.computeVertexNormals();
  return g;
}
