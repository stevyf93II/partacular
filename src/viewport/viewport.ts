import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Document } from '../core/document';
import { getGeometry } from '../geometry/store';

interface PartVisual { mesh: THREE.Mesh; baseCenter: THREE.Vector3; explodeDir: THREE.Vector3; }

type GestureMode = 'none' | 'camera' | 'move' | 'pinch';

export class Viewport {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private visuals = new Map<string, PartVisual>();
  private modelCenter = new THREE.Vector3();
  private modelRadius = 1;
  private lastTap = { x: -999, y: -999, hits: [] as string[], cursor: 0 };

  // gesture state
  private pointers = new Map<number, { x: number; y: number }>();
  private mode: GestureMode = 'none';
  private moved = false;
  private downX = 0; private downY = 0; private downT = 0;
  private dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private dragStartHit = new THREE.Vector3();
  private dragStartPos: [number, number, number] = [0, 0, 0];
  private pinchStartDist = 1; private pinchStartAngle = 0;
  private pinchStartScale = 1; private pinchStartRotY = 0;

  constructor(container: HTMLElement, private doc: Document) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    container.appendChild(this.renderer.domElement);

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
    this.scene.add(new THREE.GridHelper(10, 20, 0x2a3140, 0x1d2330));

    addEventListener('resize', () => {
      // iOS/desktop can fire resize with zero dimensions mid-transition;
      // 0/0 = NaN aspect poisons the projection matrix (kills raycast + render).
      if (innerWidth <= 0 || innerHeight <= 0) return;
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
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

  private planeHit(x: number, y: number, out: THREE.Vector3): boolean {
    const ndc = new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray.intersectPlane(this.dragPlane, out) !== null;
  }

  private resetGestures() {
    this.pointers.clear();
    if (this.mode === 'move' || this.mode === 'pinch') this.doc.endTransform();
    this.mode = 'none';
    this.controls.enabled = true;
  }

  private onPointerDown(e: PointerEvent) {
    try { this.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.downX = e.clientX; this.downY = e.clientY; this.downT = performance.now(); this.moved = false;
      const sel = this.doc.selectedId;
      const hits = this.raycastAt(e.clientX, e.clientY);
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
      this.pinchStartScale = m.transform.scale;
      this.pinchStartRotY = m.transform.rotationY;
    }
  }

  private onPointerMove(e: PointerEvent) {
    const p = this.pointers.get(e.pointerId); if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > 8) this.moved = true;
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
      const scale = THREE.MathUtils.clamp(this.pinchStartScale * (dist / this.pinchStartDist), 0.05, 50);
      const rotY = this.pinchStartRotY - (angle - this.pinchStartAngle); // screen twist -> Y spin
      this.doc.updateTransform(sel, { scale, rotationY: rotY });
      this.moved = true;
    }
  }

  private onPointerUp(e: PointerEvent) {
    if (!this.pointers.has(e.pointerId)) return; // already handled (canvas + window both listen)
    this.pointers.delete(e.pointerId);
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
    this.doc.updateTransform(sel, { scale: THREE.MathUtils.clamp(m.transform.scale * factor, 0.05, 50) });
    this.doc.endTransform();
  }

  rotateSelected45() {
    const sel = this.doc.selectedId; if (!sel) return;
    const m = this.doc.get(sel)!;
    this.doc.beginTransform(sel);
    this.doc.updateTransform(sel, { rotationY: m.transform.rotationY + Math.PI / 4 });
    this.doc.endTransform();
  }

  // ---------- visuals ----------
  private clearVisuals() {
    for (const v of this.visuals.values()) { this.scene.remove(v.mesh); (v.mesh.material as THREE.Material).dispose(); }
    this.visuals.clear();
  }

  private addVisual(id: string) {
    if (this.visuals.has(id)) { const v = this.visuals.get(id)!; v.mesh.visible = this.doc.get(id)?.visible ?? true; this.applyOne(id); return; }
    const geo = getGeometry(id); if (!geo) return;
    const color = this.doc.get(id)?.color ?? 0x4da3ff;
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.1, transparent: true, opacity: 1 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.partId = id;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const center = geo.boundingBox!.getCenter(new THREE.Vector3());
    this.scene.add(mesh);
    this.visuals.set(id, { mesh, baseCenter: center, explodeDir: new THREE.Vector3() });
  }

  private removeVisual(id: string) {
    const v = this.visuals.get(id); if (!v) return;
    this.scene.remove(v.mesh); this.visuals.delete(id);
    this.applySelectionStyle();
  }

  refreshModelBounds(fit = false) {
    // Bounds come from the DOCUMENT (un-exploded positions + geometry spheres).
    // Never measure exploded meshes: that fed explode offsets back into the
    // explode directions and amplified them every gesture (runaway scatter bug).
    const box = new THREE.Box3();
    let any = false;
    for (const [id, v] of this.visuals) {
      const m = this.doc.get(id); if (!m) continue;
      const geo = v.mesh.geometry as THREE.BufferGeometry;
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      const r = (geo.boundingSphere?.radius ?? 0.1) * m.transform.scale;
      const p = new THREE.Vector3(...m.transform.position);
      box.expandByPoint(p.clone().addScalar(r));
      box.expandByPoint(p.clone().addScalar(-r));
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
      this.controls.target.copy(this.modelCenter);
      const d = this.modelRadius * 2.2;
      this.camera.position.copy(this.modelCenter).add(new THREE.Vector3(d, d * 0.7, d));
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
    v.mesh.rotation.set(0, m.transform.rotationY, 0);
    v.mesh.scale.setScalar(m.transform.scale);
  }

  private applyAll() { for (const id of this.visuals.keys()) this.applyOne(id); }

  private handleTap(x: number, y: number) {
    const hitIds = this.raycastAt(x, y);
    if (hitIds.length === 0) { this.doc.select(null); this.lastTap.hits = []; return; }
    const near = Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < 24;
    const sameStack = near && JSON.stringify(hitIds) === JSON.stringify(this.lastTap.hits);
    const cursor = sameStack ? (this.lastTap.cursor + 1) % hitIds.length : 0;
    this.lastTap = { x, y, hits: hitIds, cursor };
    this.doc.select(hitIds[cursor]);
  }

  private applySelectionStyle() {
    const sel = this.doc.selectedId;
    for (const [id, v] of this.visuals) {
      const mat = v.mesh.material as THREE.MeshStandardMaterial;
      if (sel === null) { mat.opacity = 1; mat.emissive.setHex(0x000000); }
      else if (id === sel) { mat.opacity = 1; mat.emissive.setHex(0x1c3f66); }
      else { mat.opacity = 0.22; mat.emissive.setHex(0x000000); }
    }
  }
}
