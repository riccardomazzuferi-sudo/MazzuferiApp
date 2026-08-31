// Motore 3D della simulazione di riempimento: incapsula la scena Three.js, i controlli orbita
// (portati identici da CycleTime Pro — OrbitControls non è incluso nel bundle qui e i controlli
// custom sono già collaudati), il posizionamento gate via raycasting e il loop di animazione.
// Logica di calcolo (grafo, Dijkstra, tabelle Yudo) è in ./flow-sim.js — questo file è solo
// l'orchestrazione imperativa three.js/DOM, tenuta fuori da React (i re-render ad ogni frame
// dell'animazione sarebbero troppo costosi: lo stato del motore vive qui, React riceve solo
// aggiornamenti tramite callback).
import * as THREE from "three";
import { buildFlowGraph, runFlowSimulation, colorAt } from "./flow-sim";

export class FlowEngine {
  constructor({ onGatesChange, onSimResult, onSimInvalidated, onTimeChange, onPlayingChange, onMeshInfo } = {}) {
    this.onGatesChange = onGatesChange || (() => {});
    this.onSimResult = onSimResult || (() => {});
    this.onSimInvalidated = onSimInvalidated || (() => {});
    this.onTimeChange = onTimeChange || (() => {});
    this.onPlayingChange = onPlayingChange || (() => {});
    this.onMeshInfo = onMeshInfo || (() => {});

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b1220);
    this.camera = new THREE.PerspectiveCamera(45, 2, 0.1, 100000);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x33415c, 0.9));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.7); dirLight.position.set(1, 1, 2); this.scene.add(dirLight);
    const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.35); dirLight2.position.set(-1, -2, -1); this.scene.add(dirLight2);

    this.mesh = null; this.meshGeom = null; this.meshDiag = 100;
    this.meshCenter = new THREE.Vector3(); this.meshVolCm3 = null;
    this.graph = null; this.sim = null;
    this.gates = []; this.gateMode = false;
    this.weldLines = null; this.airMarkers = [];

    this.orbit = { theta: Math.PI / 4, phi: Math.PI / 3, dist: 300, target: new THREE.Vector3(), pan: new THREE.Vector3() };
    this.raycaster = new THREE.Raycaster();
    this._dragBtn = -1; this._lastX = 0; this._lastY = 0; this._downX = 0; this._downY = 0;

    this.animPointer = 0; this.curT = 0; this.playing = false; this._lastFrame = 0; this.animSpeedMult = 1;

    this._rafId = null;
    this._destroyed = false;
    this._handlers = {};
  }

  // ── ciclo di vita ──
  mount(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this._bindPointerEvents();
    this._applyCamera();
    this._loop();
  }

  destroy() {
    this._destroyed = true;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._unbindPointerEvents();
    this.clearGates();
    this._clearSimOverlays();
    if (this.mesh) { this.scene.remove(this.mesh); this.meshGeom?.dispose(); }
    this.renderer?.dispose();
  }

  // ── controlli orbita (drag=rotazione, tasto destro=pan, rotella=zoom) ──
  _applyCamera() {
    const p = Math.max(0.05, Math.min(Math.PI - 0.05, this.orbit.phi));
    const t = this.orbit.target.clone().add(this.orbit.pan);
    this.camera.position.set(
      t.x + this.orbit.dist * Math.sin(p) * Math.cos(this.orbit.theta),
      t.y + this.orbit.dist * Math.sin(p) * Math.sin(this.orbit.theta),
      t.z + this.orbit.dist * Math.cos(p));
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(t);
  }

  _bindPointerEvents() {
    const c = this.canvas;
    this._handlers.ctx = (e) => e.preventDefault();
    this._handlers.down = (e) => { this._dragBtn = e.button; this._lastX = this._downX = e.clientX; this._lastY = this._downY = e.clientY; c.setPointerCapture(e.pointerId); };
    this._handlers.move = (e) => {
      if (this._dragBtn < 0) return;
      const dx = e.clientX - this._lastX, dy = e.clientY - this._lastY; this._lastX = e.clientX; this._lastY = e.clientY;
      if (this._dragBtn === 0) { this.orbit.theta -= dx * 0.008; this.orbit.phi -= dy * 0.008; }
      else if (this._dragBtn === 2) {
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
        this.orbit.pan.add(right.multiplyScalar(-dx * this.orbit.dist * 0.0016)).add(up.multiplyScalar(dy * this.orbit.dist * 0.0016));
      }
      this._applyCamera();
    };
    this._handlers.up = (e) => {
      const moved = Math.hypot(e.clientX - this._downX, e.clientY - this._downY);
      if (this._dragBtn === 0 && moved < 5 && this.gateMode && this.mesh) this._placeGateFromClick(e);
      this._dragBtn = -1;
    };
    this._handlers.wheel = (e) => {
      e.preventDefault();
      this.orbit.dist *= (e.deltaY > 0 ? 1.12 : 0.89);
      this.orbit.dist = Math.max(this.meshDiag * 0.05, Math.min(this.meshDiag * 10, this.orbit.dist));
      this._applyCamera();
    };
    c.addEventListener("contextmenu", this._handlers.ctx);
    c.addEventListener("pointerdown", this._handlers.down);
    c.addEventListener("pointermove", this._handlers.move);
    c.addEventListener("pointerup", this._handlers.up);
    c.addEventListener("wheel", this._handlers.wheel, { passive: false });
  }

  _unbindPointerEvents() {
    const c = this.canvas; if (!c) return;
    c.removeEventListener("contextmenu", this._handlers.ctx);
    c.removeEventListener("pointerdown", this._handlers.down);
    c.removeEventListener("pointermove", this._handlers.move);
    c.removeEventListener("pointerup", this._handlers.up);
    c.removeEventListener("wheel", this._handlers.wheel);
  }

  resizeRenderer() {
    if (!this.canvas || !this.renderer) return;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  resetView() {
    this.orbit.target.copy(this.meshCenter); this.orbit.pan.set(0, 0, 0);
    this.orbit.dist = this.meshDiag * 1.7; this.orbit.theta = Math.PI / 4; this.orbit.phi = Math.PI / 3;
    this._applyCamera();
  }

  // ── mesh ──
  loadGeometry(geom, fname) {
    if (this.mesh) { this.scene.remove(this.mesh); this.meshGeom.dispose(); }
    this.clearGates(); this._clearSimOverlays(); this.sim = null;

    this.meshGeom = geom;
    const pos = geom.attributes.position;
    const nTri = pos.count / 3;

    let vol = 0;
    for (let i = 0; i < nTri; i++) {
      const ax = pos.getX(i * 3), ay = pos.getY(i * 3), az = pos.getZ(i * 3);
      const bx = pos.getX(i * 3 + 1), by = pos.getY(i * 3 + 1), bz = pos.getZ(i * 3 + 1);
      const cx = pos.getX(i * 3 + 2), cy = pos.getY(i * 3 + 2), cz = pos.getZ(i * 3 + 2);
      vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    this.meshVolCm3 = Math.abs(vol) / 1000;

    geom.computeBoundingBox();
    const bb = geom.boundingBox;
    this.meshCenter = bb.getCenter(new THREE.Vector3());
    this.meshDiag = bb.getSize(new THREE.Vector3()).length() || 100;

    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) { colors[i * 3] = 0.55; colors[i * 3 + 1] = 0.58; colors[i * 3 + 2] = 0.63; }
    geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geom.computeVertexNormals();

    const material = new THREE.MeshPhongMaterial({ vertexColors: true, side: THREE.DoubleSide, shininess: 18, specular: 0x222222 });
    this.mesh = new THREE.Mesh(geom, material);
    this.scene.add(this.mesh);
    this.resetView();

    this.graph = buildFlowGraph(geom);

    let nCross = 0;
    if (this.graph.crossN) for (let i = 0; i < this.graph.nNodes; i++) if (this.graph.crossN[i * 3] >= 0 || this.graph.crossN[i * 3 + 1] >= 0 || this.graph.crossN[i * 3 + 2] >= 0) nCross++;
    this.onMeshInfo({ fname, nTri, nNodes: this.graph.nNodes, nCross, heavy: nTri > 400000, meshVolCm3: this.meshVolCm3 });
    this.onGatesChange(this.gates.length);
  }

  // ── gate ──
  toggleGateMode() { this.gateMode = !this.gateMode; return this.gateMode; }

  _placeGateFromClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.mesh);
    if (!hits.length) return;
    const hit = hits[0];
    const f = hit.faceIndex * 3;
    let best = -1, bestD = Infinity;
    for (let v = 0; v < 3; v++) {
      const nid = this.graph.vert2node[f + v];
      const d = (this.graph.nodeX[nid] - hit.point.x) ** 2 + (this.graph.nodeY[nid] - hit.point.y) ** 2 + (this.graph.nodeZ[nid] - hit.point.z) ** 2;
      if (d < bestD) { bestD = d; best = nid; }
    }
    this.addGate(best);
  }

  addGate(nodeId) {
    const r = Math.max(this.meshDiag * 0.012, 0.6);
    const marker = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 14), new THREE.MeshPhongMaterial({ color: 0xf59e0b, emissive: 0x7c4a03 }));
    marker.position.set(this.graph.nodeX[nodeId], this.graph.nodeY[nodeId], this.graph.nodeZ[nodeId]);
    this.scene.add(marker);
    this.gates.push({ nodeId, marker });
    this.onGatesChange(this.gates.length);
    this._invalidateSim("Gate modificati: riesegui la simulazione.");
  }

  clearGates() {
    this.gates.forEach((g) => { this.scene.remove(g.marker); g.marker.geometry.dispose(); g.marker.material.dispose(); });
    this.gates = [];
    this.onGatesChange(0);
    this._invalidateSim(null);
  }

  // ── simulazione ──
  _invalidateSim(msg) {
    if (this.sim) {
      this._clearSimOverlays(); this._resetMeshColors(); this.sim = null;
      this.onSimInvalidated(msg);
    }
  }

  _resetMeshColors() {
    if (!this.meshGeom) return;
    const c = this.meshGeom.attributes.color;
    for (let i = 0; i < c.count; i++) c.setXYZ(i, 0.55, 0.58, 0.63);
    c.needsUpdate = true;
  }

  _clearSimOverlays() {
    if (this.weldLines) { this.scene.remove(this.weldLines); this.weldLines.geometry.dispose(); this.weldLines.material.dispose(); this.weldLines = null; }
    this.airMarkers.forEach((m) => { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); });
    this.airMarkers = [];
  }

  _drawSimOverlays() {
    this._clearSimOverlays();
    if (this.sim.weldPts.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.sim.weldPts), 3));
      this.weldLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xef4444 }));
      this.scene.add(this.weldLines);
    }
    const r = Math.max(this.meshDiag * 0.009, 0.5);
    this.sim.airSel.forEach((u) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), new THREE.MeshPhongMaterial({ color: 0xfb923c, emissive: 0x7c2d12 }));
      m.position.set(this.graph.nodeX[u], this.graph.nodeY[u], this.graph.nodeZ[u]);
      this.scene.add(m); this.airMarkers.push(m);
    });
  }

  runSimulation(velAf) {
    if (!this.mesh || !this.gates.length || !velAf || velAf <= 0) return null;
    this.sim = runFlowSimulation(this.graph, this.meshGeom, this.gates, velAf);
    this._drawSimOverlays();
    this.animPointer = 0; this.curT = 0; this.playing = false;
    this.setTimeThreshold(this.sim.tMax);
    this.onSimResult(this.sim, this.meshVolCm3);
    return this.sim;
  }

  setTimeThreshold(T) {
    if (!this.sim) return;
    this.curT = Math.max(0, Math.min(this.sim.tMax, T));
    const c = this.meshGeom.attributes.color;
    const vt = (i) => this.sim.time[this.graph.vert2node[i]];
    if (this.animPointer > 0 && this.animPointer <= this.sim.sorted.length) {
      const prevIdx = this.sim.sorted[this.animPointer - 1];
      if (vt(prevIdx) > this.curT + 1e-9) { this._resetMeshColors(); this.animPointer = 0; }
    }
    while (this.animPointer < this.sim.sorted.length) {
      const vi = this.sim.sorted[this.animPointer];
      const t = vt(vi);
      if (!(t <= this.curT)) break;
      const col = colorAt(this.sim.tMax > 0 ? t / this.sim.tMax : 0);
      c.setXYZ(vi, col[0], col[1], col[2]);
      this.animPointer++;
    }
    c.needsUpdate = true;
    this.onTimeChange(this.curT, this.sim.tMax);
  }

  togglePlay() {
    if (!this.sim) return;
    this.playing = !this.playing;
    if (this.playing && this.curT >= this.sim.tMax * 0.999) { this._resetMeshColors(); this.animPointer = 0; this.curT = 0; }
    this._lastFrame = performance.now();
    this.onPlayingChange(this.playing);
  }

  _stepAnimation() {
    if (!this.playing || !this.sim) return;
    const now = performance.now();
    const dt = (now - this._lastFrame) / 1000; this._lastFrame = now;
    const speed = (this.sim.tMax / 4) * (this.animSpeedMult || 1); // a 1x il riempimento dura ~4s di animazione
    this.setTimeThreshold(this.curT + dt * speed);
    if (this.curT >= this.sim.tMax) { this.playing = false; this.onPlayingChange(false); }
  }

  _loop = () => {
    if (this._destroyed) return;
    this._rafId = requestAnimationFrame(this._loop);
    this.resizeRenderer();
    this._stepAnimation();
    this.renderer.render(this.scene, this.camera);
  };
}
