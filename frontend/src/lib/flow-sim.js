// Simulazione di riempimento (fronte di flusso) — portata da CycleTime Pro (pages/riempimento.html).
// Modello geometrico/cinematico: propaga il fronte dai gate lungo la superficie della mesh alla
// velocità di avanzamento fronte del materiale (vademecum), con le due pelli della stessa parete
// accoppiate "attraverso lo spessore" (il materiale scorre dentro la parete, non lungo il bordo).
// Non è un solutore reologico (niente viscosità, pressioni locali, variazioni di spessore) — per
// quello serve un FEM dedicato (Moldflow, Cadmould). Tutte le funzioni qui sono pure (nessun
// accesso al DOM/three.js scene): calcolano su un grafo di nodi derivato dalla mesh importata.

// ── Tabelle Yudo — percorso di flusso ammissibile per serie ugello ──
// Fonte: catalogo Yudo Italy "Tabelle di selezione — Graphic flow path" (Hot Runner Systems).
// Punti letti a vista dai grafici del catalogo (passo 0,5 mm). Percorso di flusso in mm per
// spessore parte in mm. Come da catalogo: "i valori sono da confermarsi in fase di progetto".
export const YUDO_SERIES = ["206.5/2510", "3012", "4015", "5017", "6226"];

export const YUDO_FLOW = {
  "206.5/2510": { sp: [0.5, 1.0, 1.5, 2.0, 2.5], PP: [50, 140, 240, 340, 400], ABS: [35, 85, 170, 250, 330], PA6GF: [30, 60, 115, 150, 190], PC: [15, 25, 35, 45, 65] },
  "3012": { sp: [0.5, 1.0, 1.5, 2.0, 2.5], PP: [55, 160, 285, 355, 370], ABS: [45, 110, 185, 290, 330], PA6GF: [35, 95, 130, 205, 245], PC: [20, 42, 78, 100, 135] },
  "4015": { sp: [0.5, 1.0, 1.5, 2.0, 2.5, 3.0], PP: [90, 230, 340, 530, 720, 800], ABS: [55, 150, 250, 390, 510, 630], PA6GF: [50, 130, 200, 300, 400, 505], PC: [30, 60, 120, 160, 210, 240] },
  "5017": { sp: [0.5, 1.0, 1.5, 2.0, 2.5, 3.0], PP: [100, 260, 450, 640, 750, 830], ABS: [55, 160, 290, 380, 530, 690], PA6GF: [50, 130, 230, 350, 490, 600], PC: [30, 70, 120, 185, 245, 320] },
  "6226": { sp: [0.5, 1.0, 1.5, 2.0, 2.5, 3.0], PP: [110, 290, 470, 640, 740, 830], ABS: [55, 160, 300, 450, 660, 745], PA6GF: [50, 150, 255, 365, 530, 695], PC: [30, 80, 150, 220, 290, 390] },
};

// Peso massimo [g] per singolo ugello, per classe di viscosità (tabella "Selezione ugello").
// null = il catalogo rimanda a Yudo ("contattateci per informazioni").
export const YUDO_PESO_MAX = {
  LOW: { "206.5/2510": 30, "3012": 80, "4015": 250, "5017": 500, "6226": 3000 },
  MEDIUM: { "206.5/2510": 10, "3012": 50, "4015": 100, "5017": 300, "6226": 600 },
  HIGH: { "206.5/2510": null, "3012": null, "4015": 30, "5017": 80, "6226": 400 },
};

export const CURVA_LABEL = { PP: "PP", ABS: "ABS", PA6GF: "PA6+30%GF", PC: "PC" };

// Suggerimento curva/viscosità/velAf di partenza in base a famiglia materiale (poi sempre
// modificabile a mano nella UI) — stessa logica di assegnazione famiglia→curva di CycleTime Pro
// (LOW→PP, MEDIUM→ABS, caricati vetro/minerale→PA6+30%GF, HIGH→PC).
const FAMILY_YUDO_HINT = [
  { test: /PA ?6.*(FV|GF|VETRO|GLASS)|PA ?66.*(FV|GF)|POM.*(FV|GF)|PET.*(FV|GF)|PP.*(FV|GF)/i, curva: "PA6GF", visc: "MEDIUM", velAf: 20 },
  { test: /PC\b|PMMA|PPO|PPE|PPS|PBT|POLICARBON/i, curva: "PC", visc: "HIGH", velAf: 20 },
  { test: /PA ?6\b|PA ?66\b|PA ?61\d|SAN\b|POM\b|PET\b|CA\b|CAB\b|\bCP\b|PVC/i, curva: "ABS", visc: "MEDIUM", velAf: 20 },
  { test: /ABS/i, curva: "ABS", visc: "MEDIUM", velAf: 24 },
  { test: /PP\b|POLIPROPIL|PE\b|POLIETIL|PS\b|TPE|SEBS/i, curva: "PP", visc: "LOW", velAf: 20 },
];
export function guessYudoHint(material) {
  const hay = `${material?.family || ""} ${material?.code || ""} ${material?.name || ""}`;
  for (const h of FAMILY_YUDO_HINT) if (h.test.test(hay)) return { curva: h.curva, visc: h.visc, velAf: material?.front_velocity || h.velAf };
  return { curva: "ABS", visc: "MEDIUM", velAf: material?.front_velocity || 20 };
}

// Interpolazione lineare del percorso ammissibile sulla curva Yudo. Ritorna {val, clamped}:
// fuori dal campo coperto dal grafico NON si estrapola, si blocca all'estremo e lo si segnala.
export function yudoFlowMax(serie, curva, sp) {
  const d = YUDO_FLOW[serie];
  if (!d || !d[curva] || sp == null) return null;
  const xs = d.sp, ys = d[curva];
  if (sp <= xs[0]) return { val: ys[0], clamped: sp < xs[0] ? "low" : null };
  if (sp >= xs[xs.length - 1]) return { val: ys[ys.length - 1], clamped: sp > xs[xs.length - 1] ? "high" : null };
  for (let i = 0; i < xs.length - 1; i++) {
    if (sp <= xs[i + 1]) {
      const u = (sp - xs[i]) / (xs[i + 1] - xs[i]);
      return { val: ys[i] + (ys[i + 1] - ys[i]) * u, clamped: null };
    }
  }
  return null;
}

// Serie minima che copre il percorso richiesto con un margine dato
export function yudoSerieMinima(curva, sp, percorso, margine) {
  for (const s of YUDO_SERIES) {
    const f = yudoFlowMax(s, curva, sp);
    if (f && !f.clamped && f.val >= percorso * (1 + margine)) return { serie: s, val: f.val };
  }
  return null;
}

// ── Grafo dei nodi di flusso ──
// Unisce i vertici duplicati della mesh triangolata (chiave a 0.01 mm) in nodi, costruisce
// l'adiacenza dai lati dei triangoli e le normali per-nodo (somma pesata per area delle normali
// di faccia). Il grafo è poi usato sia per l'adiacenza superficiale sia per i collegamenti
// "attraverso lo spessore" (buildCrossLinks).
export function buildFlowGraph(geom) {
  const pos = geom.attributes.position;
  const nV = pos.count;
  const key2node = new Map();
  const vert2node = new Int32Array(nV);
  const nx = [], ny = [], nz = [];
  for (let i = 0; i < nV; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = Math.round(x * 100) + "," + Math.round(y * 100) + "," + Math.round(z * 100);
    let id = key2node.get(k);
    if (id === undefined) { id = nx.length; key2node.set(k, id); nx.push(x); ny.push(y); nz.push(z); }
    vert2node[i] = id;
  }
  const nNodes = nx.length;
  const adjSet = new Array(nNodes); for (let i = 0; i < nNodes; i++) adjSet[i] = new Set();
  const nnx = new Float32Array(nNodes), nny = new Float32Array(nNodes), nnz = new Float32Array(nNodes);
  for (let t = 0; t < nV; t += 3) {
    const a = vert2node[t], b = vert2node[t + 1], c = vert2node[t + 2];
    if (a !== b) { adjSet[a].add(b); adjSet[b].add(a); }
    if (b !== c) { adjSet[b].add(c); adjSet[c].add(b); }
    if (a !== c) { adjSet[a].add(c); adjSet[c].add(a); }
    const e1x = pos.getX(t + 1) - pos.getX(t), e1y = pos.getY(t + 1) - pos.getY(t), e1z = pos.getZ(t + 1) - pos.getZ(t);
    const e2x = pos.getX(t + 2) - pos.getX(t), e2y = pos.getY(t + 2) - pos.getY(t), e2z = pos.getZ(t + 2) - pos.getZ(t);
    const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
    nnx[a] += fx; nny[a] += fy; nnz[a] += fz; nnx[b] += fx; nny[b] += fy; nnz[b] += fz; nnx[c] += fx; nny[c] += fy; nnz[c] += fz;
  }
  for (let i = 0; i < nNodes; i++) {
    const l = Math.sqrt(nnx[i] * nnx[i] + nny[i] * nny[i] + nnz[i] * nnz[i]);
    if (l > 1e-12) { nnx[i] /= l; nny[i] /= l; nnz[i] /= l; }
  }
  const adj = new Array(nNodes);
  for (let i = 0; i < nNodes; i++) adj[i] = Int32Array.from(adjSet[i]);
  const graph = {
    nNodes, nodeX: Float32Array.from(nx), nodeY: Float32Array.from(ny), nodeZ: Float32Array.from(nz),
    vert2node, adj, normX: nnx, normY: nny, normZ: nnz, crossN: null, crossD: null,
  };
  buildCrossLinks(graph, geom);
  return graph;
}

// ── Collegamenti attraverso lo spessore ──
// Il materiale scorre dentro la parete, non lungo la superficie: quando il fronte è in un
// punto, la pelle interna e quella esterna della stessa parete si riempiono insieme. Per ogni
// nodo si spara un raggio verso l'interno (normale invertita) e si aggancia la superficie
// opposta con un arco a costo (quasi) zero: nel Dijkstra il fronte "attraversa" la parete,
// senza fare il giro dal bordo. Stessa griglia di accelerazione 3D-DDA del calcolo spessori.
function buildCrossLinks(graph, geom) {
  const n = graph.nNodes;
  const X = graph.nodeX, Y = graph.nodeY, Z = graph.nodeZ;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    if (X[i] < minX) minX = X[i]; if (X[i] > maxX) maxX = X[i];
    if (Y[i] < minY) minY = Y[i]; if (Y[i] > maxY) maxY = Y[i];
    if (Z[i] < minZ) minZ = Z[i]; if (Z[i] > maxZ) maxZ = Z[i];
  }
  const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
  const diag = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  const cs = Math.max(dx, dy, dz) / 48 || 1;
  const gx = Math.max(1, Math.ceil(dx / cs)), gy = Math.max(1, Math.ceil(dy / cs)), gz = Math.max(1, Math.ceil(dz / cs));
  const cIdx = (i, j, k) => (k * gy + j) * gx + i;
  const clampI = (v, m) => Math.max(0, Math.min(m - 1, v));
  const arr = geom.attributes.position.array;
  const nTri = arr.length / 9;
  const cells = new Array(gx * gy * gz);
  for (let t = 0; t < nTri; t++) {
    const o = t * 9;
    const x0 = Math.min(arr[o], arr[o + 3], arr[o + 6]), x1 = Math.max(arr[o], arr[o + 3], arr[o + 6]);
    const y0 = Math.min(arr[o + 1], arr[o + 4], arr[o + 7]), y1 = Math.max(arr[o + 1], arr[o + 4], arr[o + 7]);
    const z0 = Math.min(arr[o + 2], arr[o + 5], arr[o + 8]), z1 = Math.max(arr[o + 2], arr[o + 5], arr[o + 8]);
    const i0 = clampI(Math.floor((x0 - minX) / cs), gx), i1 = clampI(Math.floor((x1 - minX) / cs), gx);
    const j0 = clampI(Math.floor((y0 - minY) / cs), gy), j1 = clampI(Math.floor((y1 - minY) / cs), gy);
    const k0 = clampI(Math.floor((z0 - minZ) / cs), gz), k1 = clampI(Math.floor((z1 - minZ) / cs), gz);
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const c = cIdx(i, j, k); (cells[c] || (cells[c] = [])).push(t);
    }
  }
  function hitTri(t, ox, oy, oz, ddx, ddy, ddz) {
    const o9 = t * 9;
    const ax = arr[o9], ay = arr[o9 + 1], az = arr[o9 + 2];
    const e1x = arr[o9 + 3] - ax, e1y = arr[o9 + 4] - ay, e1z = arr[o9 + 5] - az;
    const e2x = arr[o9 + 6] - ax, e2y = arr[o9 + 7] - ay, e2z = arr[o9 + 8] - az;
    const px = ddy * e2z - ddz * e2y, py = ddz * e2x - ddx * e2z, pz = ddx * e2y - ddy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) return null;
    const inv = 1 / det, tx = ox - ax, ty = oy - ay, tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * inv; if (u < -1e-6 || u > 1 + 1e-6) return null;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (ddx * qx + ddy * qy + ddz * qz) * inv; if (v < -1e-6 || u + v > 1 + 1e-6) return null;
    const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return tt > 1e-3 ? tt : null;
  }
  const tCap = diag * 0.5;
  const crossN = new Int32Array(n * 3).fill(-1);
  const crossD = new Float32Array(n * 3);
  const v2n = graph.vert2node;
  for (let u = 0; u < n; u++) {
    const ddx = -graph.normX[u], ddy = -graph.normY[u], ddz = -graph.normZ[u];
    if (ddx === 0 && ddy === 0 && ddz === 0) continue;
    const ox = X[u], oy = Y[u], oz = Z[u];
    let i = clampI(Math.floor((ox - minX) / cs), gx), j = clampI(Math.floor((oy - minY) / cs), gy), k = clampI(Math.floor((oz - minZ) / cs), gz);
    const si = ddx > 0 ? 1 : -1, sj = ddy > 0 ? 1 : -1, sk = ddz > 0 ? 1 : -1;
    const nb = (p, mn, idx, s) => mn + (idx + (s > 0 ? 1 : 0)) * cs;
    let tMX = ddx !== 0 ? (nb(ox, minX, i, si) - ox) / ddx : Infinity;
    let tMY = ddy !== 0 ? (nb(oy, minY, j, sj) - oy) / ddy : Infinity;
    let tMZ = ddz !== 0 ? (nb(oz, minZ, k, sk) - oz) / ddz : Infinity;
    const tDX = ddx !== 0 ? Math.abs(cs / ddx) : Infinity, tDY = ddy !== 0 ? Math.abs(cs / ddy) : Infinity, tDZ = ddz !== 0 ? Math.abs(cs / ddz) : Infinity;
    let best = Infinity, bestT = -1, entry = 0;
    for (let step = 0; step < gx + gy + gz + 3; step++) {
      const list = cells[cIdx(i, j, k)];
      if (list) {
        for (let m = 0; m < list.length; m++) {
          const t = list[m];
          if (v2n[t * 3] === u || v2n[t * 3 + 1] === u || v2n[t * 3 + 2] === u) continue;
          const h = hitTri(t, ox, oy, oz, ddx, ddy, ddz);
          if (h !== null && h < best) { best = h; bestT = t; }
        }
      }
      if (best <= entry) break;
      if (tMX < tMY && tMX < tMZ) { entry = tMX; i += si; tMX += tDX; if (i < 0 || i >= gx) break; }
      else if (tMY < tMZ) { entry = tMY; j += sj; tMY += tDY; if (j < 0 || j >= gy) break; }
      else { entry = tMZ; k += sk; tMZ += tDZ; if (k < 0 || k >= gz) break; }
      if (entry > Math.min(best, tCap)) break;
    }
    if (bestT >= 0 && best <= tCap) {
      const hx = ox + ddx * best, hy = oy + ddy * best, hz = oz + ddz * best;
      for (let v = 0; v < 3; v++) {
        const cand = v2n[bestT * 3 + v];
        if (cand === u) continue;
        crossN[u * 3 + v] = cand;
        crossD[u * 3 + v] = Math.sqrt((X[cand] - hx) ** 2 + (Y[cand] - hy) ** 2 + (Z[cand] - hz) ** 2);
      }
    }
  }
  graph.crossN = crossN; graph.crossD = crossD;
}

// min-heap binario su indici, chiave = dist
function makeHeap(cap) {
  let heap = new Int32Array(cap); let size = 0;
  return {
    push(i, dist) {
      if (size >= heap.length) { const g = new Int32Array(heap.length * 2); g.set(heap); heap = g; }
      let c = size++; heap[c] = i;
      while (c > 0) { const p = (c - 1) >> 1; if (dist[heap[p]] <= dist[heap[c]]) break; const t = heap[p]; heap[p] = heap[c]; heap[c] = t; c = p; }
    },
    pop(dist) {
      const top = heap[0]; heap[0] = heap[--size]; let c = 0;
      for (;;) {
        const l = c * 2 + 1, r = l + 1; let m = c;
        if (l < size && dist[heap[l]] < dist[heap[m]]) m = l;
        if (r < size && dist[heap[r]] < dist[heap[m]]) m = r;
        if (m === c) break; const t = heap[m]; heap[m] = heap[c]; heap[c] = t; c = m;
      }
      return top;
    },
    get size() { return size; },
  };
}

// ── Simulazione (Dijkstra multi-sorgente dai gate) ──
// Propaga il fronte lungo l'adiacenza superficiale (peso = distanza euclidea tra nodi) e lungo
// i collegamenti attraverso lo spessore (peso = distanza dal punto d'impatto ai nodi della
// parete opposta). Rileva anche linee di giunzione stimate e zone di ultimo riempimento/aria.
export function runFlowSimulation(graph, geom, gates, velAf) {
  const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
  const velMmS = velAf * 10;
  const n = graph.nNodes;
  const dist = new Float64Array(n).fill(Infinity);
  const label = new Int32Array(n).fill(-1);
  const pred = new Int32Array(n).fill(-1);
  const heap = makeHeap(n * 4);
  gates.forEach((g, gi) => { dist[g.nodeId] = 0; label[g.nodeId] = gi; heap.push(g.nodeId, dist); });

  const X = graph.nodeX, Y = graph.nodeY, Z = graph.nodeZ;
  const done = new Uint8Array(n);
  const predCross = new Uint8Array(n);
  const CN = graph.crossN, CD = graph.crossD;
  while (heap.size > 0) {
    const u = heap.pop(dist);
    if (done[u]) continue;
    done[u] = 1;
    const du = dist[u];
    const nb = graph.adj[u];
    for (let k = 0; k < nb.length; k++) {
      const v = nb[k];
      const w = Math.sqrt((X[u] - X[v]) ** 2 + (Y[u] - Y[v]) ** 2 + (Z[u] - Z[v]) ** 2);
      const nd = du + w;
      if (nd < dist[v] - 1e-9) { dist[v] = nd; label[v] = label[u]; pred[v] = u; predCross[v] = 0; heap.push(v, dist); }
    }
    if (CN) {
      for (let c = 0; c < 3; c++) {
        const v = CN[u * 3 + c];
        if (v < 0) continue;
        const nd = du + CD[u * 3 + c];
        if (nd < dist[v] - 1e-9) { dist[v] = nd; label[v] = label[u]; pred[v] = u; predCross[v] = 1; heap.push(v, dist); }
      }
    }
  }

  let dMax = 0, unreached = 0, dMaxNode = -1;
  for (let i = 0; i < n; i++) {
    if (dist[i] === Infinity) { unreached++; continue; }
    if (dist[i] > dMax) { dMax = dist[i]; dMaxNode = i; }
  }
  const tMax = dMax / velMmS;
  const time = new Float64Array(n);
  for (let i = 0; i < n; i++) time[i] = dist[i] === Infinity ? Infinity : dist[i] / velMmS;

  // linee di giunzione stimate: (a) multi-gate con tempi di arrivo simili; (b) singolo gate,
  // fronti che si richiudono (tempi quasi uguali, direzioni di avanzamento quasi opposte)
  const weldPts = [];
  const tEps = Math.max(tMax * 0.04, 1e-6);
  const tMin = tMax * 0.05;
  for (let u = 0; u < n; u++) {
    if (dist[u] === Infinity) continue;
    const nb = graph.adj[u];
    for (let k = 0; k < nb.length; k++) {
      const v = nb[k];
      if (v <= u || dist[v] === Infinity) continue;
      const dt = Math.abs(time[u] - time[v]);
      let isWeld = false;
      if (label[u] !== label[v] && dt < tEps * 2.5) isWeld = true;
      else if (dt < tEps && time[u] > tMin && pred[u] >= 0 && pred[v] >= 0 && !predCross[u] && !predCross[v]) {
        const ax = X[u] - X[pred[u]], ay = Y[u] - Y[pred[u]], az = Z[u] - Z[pred[u]];
        const bx = X[v] - X[pred[v]], by = Y[v] - Y[pred[v]], bz = Z[v] - Z[pred[v]];
        const la = Math.sqrt(ax * ax + ay * ay + az * az), lb = Math.sqrt(bx * bx + by * by + bz * bz);
        if (la > 1e-9 && lb > 1e-9) {
          const cos = (ax * bx + ay * by + az * bz) / (la * lb);
          if (cos < -0.55) isWeld = true;
        }
      }
      if (isWeld) weldPts.push(X[u], Y[u], Z[u], X[v], Y[v], Z[v]);
    }
  }

  // zone di ultimo riempimento / possibili intrappolamenti d'aria: massimi locali del tempo
  // di arrivo nella parte finale del riempimento
  const airNodes = [];
  for (let u = 0; u < n; u++) {
    if (dist[u] === Infinity || time[u] < tMax * 0.55) continue;
    const nb = graph.adj[u]; let isMax = true;
    for (let k = 0; k < nb.length; k++) { if (time[nb[k]] > time[u] + 1e-9) { isMax = false; break; } }
    if (isMax) airNodes.push(u);
  }
  airNodes.sort((a, b) => time[b] - time[a]);
  const airSel = []; const rad2 = (meshDiagOf(graph) * 0.04) ** 2;
  for (const u of airNodes) {
    let close = false;
    for (const s of airSel) { if ((X[u] - X[s]) ** 2 + (Y[u] - Y[s]) ** 2 + (Z[u] - Z[s]) ** 2 < rad2) { close = true; break; } }
    if (!close) airSel.push(u);
    if (airSel.length >= 25) break;
  }

  // ordinamento dei vertici originali per tempo (per l'animazione incrementale)
  const nV = geom.attributes.position.count;
  const sorted = new Uint32Array(nV); for (let i = 0; i < nV; i++) sorted[i] = i;
  const vt = (i) => time[graph.vert2node[i]];
  const sortedArr = Array.from(sorted).sort((a, b) => vt(a) - vt(b));

  return {
    time, label, pred, tMax, dMax, dMaxNode, sorted: Uint32Array.from(sortedArr), unreached, weldPts, airSel, velAf,
    elapsedMs: (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0,
  };
}

function meshDiagOf(graph) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const { nodeX: X, nodeY: Y, nodeZ: Z, nNodes: n } = graph;
  for (let i = 0; i < n; i++) {
    if (X[i] < minX) minX = X[i]; if (X[i] > maxX) maxX = X[i];
    if (Y[i] < minY) minY = Y[i]; if (Y[i] > maxY) maxY = Y[i];
    if (Z[i] < minZ) minZ = Z[i]; if (Z[i] > maxZ) maxZ = Z[i];
  }
  const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
}

// ── Report rischi ──
// Stessa logica di CycleTime Pro (buildReport), ma restituisce dati strutturati invece di HTML:
// la pagina React li renderizza con lo stile dell'app invece di innerHTML. { kpis, notes } dove
// ogni nota è { level: 'ok'|'warn'|'err'|'info', text }.
export function buildFlowReport({ sim, sp, curva, visc, dsol, serie, gatesCount, meshVolCm3, matLabel, tipoAmorfo }) {
  const kpis = [];
  const notes = [];
  if (!sim) return { kpis, notes };

  const ls = sp ? sim.dMax / sp : null;
  const nWeld = sim.weldPts.length / 6;
  const nAir = sim.airSel.length;
  const fYudo = serie ? yudoFlowMax(serie, curva, sp) : null;

  kpis.push({ label: "Percorso max di flusso", value: sim.dMax.toFixed(1) + " mm", sub: "geodetico dal gate più favorevole" });
  kpis.push({ label: "T. riempimento teorico", value: sim.tMax.toFixed(2) + " s", sub: `a ${sim.velAf} cm/s (${matLabel || "—"})` });
  if (fYudo) {
    kpis.push({ label: "Percorso ammissibile Yudo", value: fYudo.val.toFixed(0) + " mm", sub: `serie ${serie} · curva ${CURVA_LABEL[curva]} · sp. ${sp.toFixed(1)} mm` });
  } else {
    kpis.push({ label: "Rapporto L/s", value: ls ? ls.toFixed(0) + ":1" : "—", sub: ls ? `con spessore ${sp.toFixed(1)} mm` : "inserisci lo spessore" });
  }
  kpis.push({ label: "Gate", value: String(gatesCount), sub: nWeld ? "giunzioni stimate: " + nWeld : "nessuna giunzione rilevata" });

  if (serie && !sp) {
    notes.push({ level: "info", text: `Hai selezionato la serie ugello ${serie}: inserisci lo spessore del pezzo per confrontare il percorso calcolato con le tabelle Yudo.` });
  }

  if (fYudo) {
    const margine = ((fYudo.val - sim.dMax) / sim.dMax) * 100;
    const clampNote = fYudo.clamped ? ` (spessore ${fYudo.clamped === "low" ? "sotto" : "oltre"} il campo coperto dal grafico: valore bloccato all'estremo, verifica con Yudo)` : "";
    if (sim.dMax <= fYudo.val * 0.9) {
      notes.push({ level: "ok", text: `Riempimento fattibile secondo tabelle Yudo — percorso richiesto ${sim.dMax.toFixed(0)} mm vs ammissibile ${fYudo.val.toFixed(0)} mm (serie ${serie}, curva ${CURVA_LABEL[curva]}, sp. ${sp.toFixed(1)} mm): margine +${margine.toFixed(0)}%.${clampNote}` });
    } else if (sim.dMax <= fYudo.val) {
      notes.push({ level: "warn", text: `Al limite delle tabelle Yudo — percorso richiesto ${sim.dMax.toFixed(0)} mm vs ammissibile ${fYudo.val.toFixed(0)} mm: margine solo +${margine.toFixed(0)}%. Il catalogo stesso chiede conferma in fase di progetto: valuta la serie superiore o un gate aggiuntivo.${clampNote}` });
    } else {
      notes.push({ level: "err", text: `Percorso oltre le tabelle Yudo — richiesto ${sim.dMax.toFixed(0)} mm vs ammissibile ${fYudo.val.toFixed(0)} mm con serie ${serie} (${margine.toFixed(0)}%).${clampNote}` });
      const sug = yudoSerieMinima(curva, sp, sim.dMax, 0.10);
      if (sug && sug.serie !== serie) notes.push({ level: "warn", text: `Con la serie ${sug.serie} il percorso ammissibile sale a ${sug.val.toFixed(0)} mm (margine ≥10%). In alternativa: gate aggiuntivo per accorciare il percorso, o spessore maggiore.` });
      else if (!sug) notes.push({ level: "warn", text: "Nessuna serie in tabella copre questo percorso con margine: servono più gate (accorcia il percorso massimo riposizionandoli e ri-simula) o una revisione degli spessori." });
    }
    if (meshVolCm3 && dsol) {
      const pesoTot = meshVolCm3 * dsol;
      const pesoUgello = pesoTot / gatesCount;
      const lim = YUDO_PESO_MAX[visc] ? YUDO_PESO_MAX[visc][serie] : undefined;
      if (lim === null) notes.push({ level: "warn", text: `Peso per ugello ${pesoUgello.toFixed(1)} g (${pesoTot.toFixed(1)} g su ${gatesCount} gate, viscosità ${visc}): per questa combinazione serie/viscosità il catalogo rimanda a Yudo ("contattateci per informazioni").` });
      else if (lim != null) {
        if (pesoUgello <= lim) notes.push({ level: "ok", text: `Peso per ugello ${pesoUgello.toFixed(1)} g ≤ limite ${lim} g della serie ${serie} per viscosità ${visc} (${pesoTot.toFixed(1)} g totali su ${gatesCount} gate).` });
        else notes.push({ level: "err", text: `Peso per ugello ${pesoUgello.toFixed(1)} g oltre il limite ${lim} g della serie ${serie} per viscosità ${visc}: serie sottodimensionata per lo shot, oltre che da verificare sul percorso.` });
      }
    }
    notes.push({ level: "info", text: `Fonte: tabelle di selezione Yudo — valori digitalizzati dai grafici del catalogo (curve PP / ABS / PA6+30%GF / PC), interpolazione lineare sullo spessore. La curva assegnata (${CURVA_LABEL[curva]}) è una stima per famiglia materiale: correggila con i selettori qui sopra se l'esperienza suggerisce diversamente. Come da catalogo, i valori vanno confermati in fase di progetto.` });
  } else if (ls) {
    const limA = tipoAmorfo ? { ok: 150, warn: 220 } : { ok: 180, warn: 280 };
    if (ls <= limA.ok) notes.push({ level: "ok", text: `Rapporto L/s = ${ls.toFixed(0)}:1 — entro i valori tipici per un ${tipoAmorfo ? "amorfo" : "semicristallino"}. Il riempimento con un solo fronte è plausibile senza pressioni eccessive. (Soglie generiche: seleziona una serie ugello Yudo per un confronto quantitativo.)` });
    else if (ls <= limA.warn) notes.push({ level: "warn", text: `Rapporto L/s = ${ls.toFixed(0)}:1 — al limite per un ${tipoAmorfo ? "amorfo" : "semicristallino"}: rischio di pressioni di iniezione elevate e riempimento incompleto sulle zone terminali. Valuta un gate aggiuntivo, un gate più centrale o un grado più fluido. (Soglie generiche: seleziona una serie ugello Yudo per un confronto quantitativo.)` });
    else notes.push({ level: "err", text: `Rapporto L/s = ${ls.toFixed(0)}:1 — molto oltre i valori tipici: forte rischio di stampata incompleta. Rivedi posizione/numero dei gate o lo spessore di parete.` });
  } else {
    notes.push({ level: "info", text: "Inserisci lo spessore del pezzo per valutare il rapporto lunghezza di flusso / spessore (L/s), oppure seleziona anche una serie ugello Yudo per il confronto con le tabelle di catalogo." });
  }

  if (nWeld > 0) {
    notes.push({ level: "warn", text: `Linee di giunzione stimate (in rosso sul modello): ${gatesCount > 1 ? "i fronti dei diversi gate si incontrano dove indicato — verifica che le giunzioni non cadano su zone estetiche o strutturalmente sollecitate." : "il fronte si richiude su sé stesso (fori/asole): le giunzioni indicate sono da verificare rispetto a estetica e resistenza."} La posizione esatta dipende anche da spessori locali e condizioni termiche.` });
  }
  if (nAir > 0) {
    notes.push({ level: "warn", text: `${nAir} zon${nAir === 1 ? "a" : "e"} di ultimo riempimento (marker arancioni): sono i punti dove il fronte arriva per ultimo — candidati per intrappolamenti d'aria e bruciature (effetto Diesel). Verifica che in quelle zone lo stampo abbia sfoghi d'aria adeguati, o valuta di spostare il gate.` });
  }
  if (sim.unreached > 0) {
    notes.push({ level: "err", text: `${sim.unreached.toLocaleString("it-IT")} nodi non raggiunti: la mesh contiene corpi separati non collegati al gate (o il file contiene più pezzi). Le zone grigie non sono state simulate.` });
  }
  notes.push({ level: "info", text: `Il percorso massimo calcolato (${sim.dMax.toFixed(1)} mm) è la distanza lungo la superficie dal gate reale: è più accurato della stima dal baricentro usata come default nella Scheda stampaggio — puoi riportarlo a mano nel campo "Percorso riempimento" dei Parametri stampo. Simulazione completata in ${(sim.elapsedMs / 1000).toFixed(1)} s.` });

  return { kpis, notes };
}

// colore del gradiente tempo (blu → ciano → verde → giallo → rosso), f in [0,1]
export function colorAt(f) {
  const stops = [[0.11, 0.30, 0.85], [0.02, 0.71, 0.83], [0.13, 0.77, 0.37], [0.92, 0.70, 0.03], [0.94, 0.27, 0.27]];
  const x = Math.max(0, Math.min(1, f)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x)); const u = x - i;
  return [stops[i][0] + (stops[i + 1][0] - stops[i][0]) * u, stops[i][1] + (stops[i + 1][1] - stops[i][1]) * u, stops[i][2] + (stops[i + 1][2] - stops[i][2]) * u];
}
