// Imperative three.js viewport (WebGPURenderer, automatic WebGL2 fallback).
// It renders the *display* tessellation only and knows nothing about the
// electromagnetic model; React state is pushed in through the setters.
// Rendering is on demand (after camera or state changes), not continuous.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export type Vec3 = [number, number, number];
export type RGB = [number, number, number]; // linear

export interface ViewBody {
  id: string;
  positions: Float32Array;
  normals?: Float32Array;
  indices: Uint32Array;
  featureEdges: Uint32Array;
  faces: { triFirst: number; triLast: number }[];
}

export interface PickHit {
  bodyId: string;
  faceIndex: number;
  point: Vec3; // model coordinates (before the unit scale)
  normal: Vec3;
}

export interface ViewportEvents {
  onPick(hit: PickHit | null): void;
  onHover(hit: PickHit | null): void;
  onDeviceLost(message: string): void;
}

export interface BodyStyle {
  color: RGB;
  opacity: number; // 1 = opaque
  visible: boolean;
}

export interface Highlight {
  bodyId: string | null;
  faceIndex: number | null;
  hoverBodyId: string | null;
}

export interface ClipSpec {
  enabled: boolean;
  axis: 0 | 1 | 2;
  position: number; // fraction of the extent
  flip: boolean;
}

export interface FeedSpec {
  start: Vec3;
  end: Vec3;
}

/** Simulation previews, in true millimetres (not affected by the unit scale). */
export interface SimOverlay {
  boxes: { min: Vec3; max: Vec3; color: number; opacity: number }[];
  /** Line segments, 6 floats each. */
  grid?: Float32Array;
  pec?: Float32Array;
  port?: Float32Array;
}

/** 3D radiation pattern surface, in true millimetres around `center`. */
export interface PatternOverlay {
  center: Vec3;
  positions: Float32Array;
  colors: Float32Array; // linear RGB per vertex
  indices: Uint32Array;
}

interface BodyEntry {
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  material: THREE.MeshStandardNodeMaterial;
  faces: { triFirst: number; triLast: number }[];
  faceVerts: [number, number][]; // vertex range per face (OCCT emits per-face vertices)
}

const SELECT_COLOR: RGB = [0.95, 0.75, 0.05];
const FACE_COLOR: RGB = [0.1, 0.55, 1.0];

export class Viewport {
  readonly backend: 'webgpu' | 'webgl2';
  private renderer: THREE.WebGPURenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private scaled = new THREE.Group(); // applies the unit scale
  private clipGroup = new THREE.ClippingGroup();
  private overlay = new THREE.Group();
  private simGroup = new THREE.Group(); // mm, unscaled
  private patternGroup = new THREE.Group(); // mm, unscaled
  private axes: THREE.AxesHelper | null = null;
  private bodies = new Map<string, BodyEntry>();
  private styles = new Map<string, BodyStyle>();
  private highlight: Highlight = { bodyId: null, faceIndex: null, hoverBodyId: null };
  private plane = new THREE.Plane();
  private clip: ClipSpec = { enabled: false, axis: 2, position: 0.5, flip: false };
  private modelBox = new THREE.Box3();
  private raycaster = new THREE.Raycaster();
  private frame = 0;
  private resizeObs: ResizeObserver;
  private disposed = false;

  private constructor(private canvas: HTMLCanvasElement, private events: ViewportEvents, renderer: THREE.WebGPURenderer) {
    this.renderer = renderer;
    const backend = (renderer as unknown as { backend: { isWebGPUBackend?: boolean } }).backend;
    this.backend = backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
    this.scene.background = new THREE.Color(0x15191e);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1e5);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(100, -150, 100);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404850, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(1, -1, 2);
    this.camera.add(key);
    this.scene.add(this.camera);
    this.clipGroup.clippingPlanes = [this.plane];
    this.clipGroup.enabled = false;
    this.scaled.add(this.clipGroup, this.overlay);
    this.scene.add(this.scaled, this.simGroup, this.patternGroup);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.addEventListener('change', () => this.requestRender());

    renderer.onDeviceLost = (info) => {
      this.events.onDeviceLost(info.message || info.reason || 'GPU device lost');
    };

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas.parentElement ?? canvas);
    this.installPointer();
    this.resize();
  }

  static async create(canvas: HTMLCanvasElement, events: ViewportEvents, opts: { forceWebGL?: boolean } = {}) {
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: opts.forceWebGL ?? false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    await renderer.init();
    return new Viewport(canvas, events, renderer);
  }

  // ------------------------------------------------------------------ model
  setModel(bodies: ViewBody[]) {
    this.clearModel();
    this.modelBox.makeEmpty();
    for (const b of bodies) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
      if (b.normals && b.normals.length === b.positions.length) g.setAttribute('normal', new THREE.BufferAttribute(b.normals, 3));
      else g.computeVertexNormals();
      // Copy: the model's arrays must never be mutated by rendering code.
      g.setIndex(new THREE.BufferAttribute(b.indices.slice(), 1));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(b.positions.length).fill(0.7), 3));
      g.computeBoundingBox();
      // `indirect` keeps triangle order intact; the default BVH build reorders the
      // index buffer, which would break the triangle ranges of B-rep faces.
      g.computeBoundsTree({ indirect: true });
      const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.55, metalness: 0.05 });
      const mesh = new THREE.Mesh(g, material);
      mesh.userData.bodyId = b.id;

      const ep = new Float32Array(b.featureEdges.length * 3);
      for (let i = 0; i < b.featureEdges.length; i++) ep.set(b.positions.subarray(3 * b.featureEdges[i], 3 * b.featureEdges[i] + 3), 3 * i);
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.BufferAttribute(ep, 3));
      const edges = new THREE.LineSegments(eg, new THREE.LineBasicNodeMaterial({ color: 0x101418, transparent: true, opacity: 0.55 }));
      edges.raycast = () => {};

      const faceVerts = b.faces.map((f): [number, number] => {
        let lo = Infinity, hi = -Infinity;
        for (let t = 3 * f.triFirst; t < 3 * (f.triLast + 1); t++) {
          lo = Math.min(lo, b.indices[t]);
          hi = Math.max(hi, b.indices[t]);
        }
        return [lo, hi];
      });
      this.clipGroup.add(mesh, edges);
      this.bodies.set(b.id, { mesh, edges, material, faces: b.faces, faceVerts });
      this.modelBox.union(g.boundingBox!);
    }
    this.rebuildAxes();
    this.applyStyles();
    this.applyClip();
    this.fit();
  }

  setScale(s: number) {
    this.scaled.scale.setScalar(s);
    this.applyClip();
    this.fit();
  }

  setStyles(styles: Map<string, BodyStyle>) {
    this.styles = styles;
    this.applyStyles();
  }

  setHighlight(h: Highlight) {
    this.highlight = h;
    this.applyStyles();
  }

  setClip(c: ClipSpec) {
    this.clip = c;
    this.applyClip();
  }

  setFeed(feed: FeedSpec | null, picks: { signal?: Vec3; reference?: Vec3 }) {
    for (const c of [...this.overlay.children]) {
      this.overlay.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
    const size = this.modelBox.isEmpty() ? 10 : this.modelBox.getSize(new THREE.Vector3()).length();
    const r = Math.max(size * 0.006, 1e-3);
    const marker = (p: Vec3, color: number, radius = r) => {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 16, 12),
        new THREE.MeshBasicNodeMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }),
      );
      m.position.set(...p);
      m.renderOrder = 10;
      m.raycast = () => {};
      this.overlay.add(m);
    };
    if (picks.signal) marker(picks.signal, 0xff4d4d, r * 0.8);
    if (picks.reference) marker(picks.reference, 0x4d8dff, r * 0.8);
    if (feed) {
      const a = new THREE.Vector3(...feed.start), b = new THREE.Vector3(...feed.end);
      const len = a.distanceTo(b);
      const cyl = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.45, r * 0.45, Math.max(len, r * 0.2), 12),
        new THREE.MeshBasicNodeMaterial({ color: 0xffd23f, depthTest: false, transparent: true, opacity: 0.95 }),
      );
      cyl.position.copy(a).add(b).multiplyScalar(0.5);
      cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      cyl.renderOrder = 11;
      cyl.raycast = () => {};
      this.overlay.add(cyl);
      marker(feed.end, 0xff4d4d); // signal terminal
      marker(feed.start, 0x4d8dff); // reference terminal
    }
    this.requestRender();
  }

  setSimOverlay(o: SimOverlay | null) {
    for (const c of [...this.simGroup.children]) {
      this.simGroup.remove(c);
      (c as THREE.LineSegments).geometry.dispose();
      ((c as THREE.LineSegments).material as THREE.Material).dispose();
    }
    const lines = (pos: Float32Array, color: number, opacity: number, onTop = false) => {
      if (!pos.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const m = new THREE.LineSegments(g, new THREE.LineBasicNodeMaterial({ color, transparent: opacity < 1 || onTop, opacity, depthTest: !onTop }));
      m.raycast = () => {};
      if (onTop) m.renderOrder = 12;
      this.simGroup.add(m);
    };
    if (o) {
      for (const b of o.boxes) lines(boxEdges(b.min, b.max), b.color, b.opacity);
      if (o.grid) lines(o.grid, 0x5a6b7d, 0.45);
      if (o.pec) lines(o.pec, 0xff9f1c, 0.9);
      if (o.port) lines(o.port, 0xff3df2, 1, true);
    }
    this.requestRender();
  }

  setPattern(p: PatternOverlay | null) {
    for (const c of [...this.patternGroup.children]) {
      this.patternGroup.remove(c);
      (c as THREE.Mesh).geometry.dispose();
      ((c as THREE.Mesh).material as THREE.Material).dispose();
    }
    if (p) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
      g.setAttribute('color', new THREE.BufferAttribute(p.colors, 3));
      g.setIndex(new THREE.BufferAttribute(p.indices, 1));
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicNodeMaterial({ vertexColors: true, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
      mesh.position.set(...p.center);
      mesh.raycast = () => {};
      mesh.renderOrder = 5;
      this.patternGroup.add(mesh);
    }
    this.requestRender();
  }

  fit() {
    if (this.modelBox.isEmpty()) return;
    const s = this.scaled.scale.x;
    const box = new THREE.Box3(this.modelBox.min.clone().multiplyScalar(s), this.modelBox.max.clone().multiplyScalar(s));
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3);
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (!Number.isFinite(dir.x) || dir.lengthSq() === 0) dir.set(0.6, -0.9, 0.6).normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist * 1.1);
    this.camera.near = dist / 1000;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObs.disconnect();
    this.controls.dispose();
    this.clearModel();
    this.renderer.dispose();
  }

  // ------------------------------------------------------------------ internals
  private clearModel() {
    for (const e of this.bodies.values()) {
      e.mesh.geometry.disposeBoundsTree();
      e.mesh.geometry.dispose();
      e.material.dispose();
      e.edges.geometry.dispose();
      (e.edges.material as THREE.Material).dispose();
      this.clipGroup.remove(e.mesh, e.edges);
    }
    this.bodies.clear();
  }

  private rebuildAxes() {
    if (this.axes) {
      this.scaled.remove(this.axes);
      this.axes.dispose();
    }
    const size = this.modelBox.isEmpty() ? 10 : this.modelBox.getSize(new THREE.Vector3()).length();
    this.axes = new THREE.AxesHelper(size * 0.25);
    this.axes.raycast = () => {};
    this.scaled.add(this.axes);
  }

  private applyStyles() {
    const h = this.highlight;
    for (const [id, e] of this.bodies) {
      const st = this.styles.get(id) ?? { color: [0.7, 0.7, 0.7] as RGB, opacity: 1, visible: true };
      e.mesh.visible = st.visible;
      e.edges.visible = st.visible;
      e.material.transparent = st.opacity < 1;
      e.material.opacity = st.opacity;
      e.material.depthWrite = st.opacity >= 1;
      const attr = e.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      let c: RGB = st.color;
      if (h.bodyId === id && h.faceIndex === null) c = mix(c, SELECT_COLOR, 0.55);
      else if (h.hoverBodyId === id) c = mix(c, [1, 1, 1], 0.25);
      for (let i = 0; i < arr.length; i += 3) arr.set(c, i);
      if (h.bodyId === id && h.faceIndex !== null && e.faceVerts[h.faceIndex]) {
        const [lo, hi] = e.faceVerts[h.faceIndex];
        for (let v = lo; v <= hi; v++) arr.set(FACE_COLOR, 3 * v);
      }
      attr.needsUpdate = true;
    }
    this.requestRender();
  }

  private applyClip() {
    if (this.modelBox.isEmpty()) return;
    const s = this.scaled.scale.x;
    const a = this.clip.axis;
    const lo = this.modelBox.min.getComponent(a) * s, hi = this.modelBox.max.getComponent(a) * s;
    const pos = lo + this.clip.position * (hi - lo);
    const n = new THREE.Vector3();
    n.setComponent(a, this.clip.flip ? 1 : -1);
    // three.js clips points with negative signed distance. Unflipped, the plane
    // keeps coordinates below `pos`; flipped, it keeps those above.
    this.plane.set(n, this.clip.flip ? -pos : pos);
    this.clipGroup.enabled = this.clip.enabled;
    this.requestRender();
  }

  private isClipped(worldPoint: THREE.Vector3) {
    return this.clip.enabled && this.plane.distanceToPoint(worldPoint) < 0;
  }

  private pick(clientX: number, clientY: number): PickHit | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = [...this.bodies.values()].filter((e) => e.mesh.visible).map((e) => e.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    for (const hit of hits) {
      if (this.isClipped(hit.point)) continue;
      const mesh = hit.object as THREE.Mesh;
      const entry = this.bodies.get(mesh.userData.bodyId as string)!;
      if ((this.styles.get(mesh.userData.bodyId)?.opacity ?? 1) < 0.2) continue; // ghosted bodies are not pickable
      const tri = hit.faceIndex ?? 0;
      const faceIndex = entry.faces.findIndex((f) => tri >= f.triFirst && tri <= f.triLast);
      const local = this.scaled.worldToLocal(hit.point.clone());
      const n = hit.face?.normal ?? new THREE.Vector3(0, 0, 1);
      return { bodyId: mesh.userData.bodyId, faceIndex: Math.max(0, faceIndex), point: [local.x, local.y, local.z], normal: [n.x, n.y, n.z] };
    }
    return null;
  }

  private installPointer() {
    let down: { x: number; y: number } | null = null;
    let hoverPending = false;
    this.canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    this.canvas.addEventListener('pointerup', (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) this.events.onPick(this.pick(e.clientX, e.clientY));
      down = null;
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (e.buttons !== 0 || hoverPending) return;
      hoverPending = true;
      requestAnimationFrame(() => {
        hoverPending = false;
        if (!this.disposed) this.events.onHover(this.pick(e.clientX, e.clientY));
      });
    });
    this.canvas.addEventListener('pointerleave', () => this.events.onHover(null));
  }

  private resize() {
    const host = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  requestRender() {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.disposed) this.renderer.render(this.scene, this.camera);
    });
  }

}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function boxEdges(a: Vec3, b: Vec3): Float32Array {
  const c = (i: number): Vec3 => [i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]];
  const pairs = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  return new Float32Array(pairs.flatMap(([i, j]) => [...c(i), ...c(j)]));
}
