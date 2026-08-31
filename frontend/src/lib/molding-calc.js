// Formule stampaggio scientifico portate da CycleTime Pro (parametri.html · ricalcola)
// Tutti i calcoli sono client-side e reattivi.

// Tabella diametri vite commerciali → sezione (cm²)
export const SEZ_VITE = {
  15: 1.77, 18: 2.54, 20: 3.14, 22: 3.80, 25: 4.91, 28: 6.16, 30: 7.07,
  32: 8.04, 35: 9.62, 40: 12.57, 45: 15.90, 50: 19.63, 55: 23.76,
  60: 28.27, 65: 33.18, 70: 38.48, 75: 44.18, 80: 50.27, 90: 63.62, 100: 78.54,
};

export function getSezVite(d) {
  if (!d) return null;
  if (SEZ_VITE[d]) return SEZ_VITE[d];
  const keys = Object.keys(SEZ_VITE).map(Number);
  const closest = keys.reduce((a, b) => (Math.abs(b - d) < Math.abs(a - d) ? b : a));
  return SEZ_VITE[closest];
}

export function getDminDmax(dIdeale) {
  if (!dIdeale) return { dmin: null, dmax: null };
  const keys = Object.keys(SEZ_VITE).map(Number).sort((a, b) => a - b);
  let dmin = keys[0], dmax = keys[keys.length - 1];
  for (const k of keys) if (k <= dIdeale) dmin = k;
  for (const k of keys) if (k >= dIdeale) { dmax = k; break; }
  return { dmin, dmax };
}

export const DEFAULT_STATE = {
  // identificazione
  codice: "", descrizione: "", cliente: "", nProva: 1, dataProva: "", operatore: "", note: "",
  // materiale (id)
  materialeId: "",
  // pressa (id) + parametri autopopolati/modificabili
  pressaId: "",
  dvite: 40, nGiriMax: 200, qmaxPressa: 100, pp1maxPressa: 800, tonnellaggio: 100,
  vmaxP: 200, rapPsiPi: 10, forzaChiusuraMax: 0,
  // stampo
  nCav: 1, nFig: 1,
  spPezzo: null, spPezzoMax: null, spSezSottile: null,
  volPezzo: null, volSfrido: null, volMat: null,
  areaProiettata: null, lPerc: null,
  // multi-gruppo (stampi multi-impronta con figure diverse tra loro): array di gruppi, ognuno
  // con la propria geometria; con 0 o 1 gruppo il calcolo resta quello a gruppo singolo, con
  // ≥2 gruppi spessore/area/peso vengono aggregati dai gruppi (vedi isMultiGruppo/computeAll)
  gruppi: [], gruppoTabAttivo: 0,
  // iniezione — plastificazione
  cuscino: 5, nRpm: 80,
  contropressione: 0, decompressione: 0,
  taStampaggio: null, // se null, usa taCons materiale
  // velocità profilo
  vel1: 0, vel2: 0, vel3: 0, vel4: 0, qVel2: 0, qVel3: 0, qVel4: 0,
  tRiemp: 0.8,
  // mantenimento
  pressIniez: 0, pp1: 0, pp2: 0, tPP1: 0, tPP2: 0,
  // apertura/chiusura/interciclo
  tChiusura: 1.5, tAperturaT: 2, quotaApertura: 0, pressChiusura: 0,
  tEstr1Colpo: 0.5, tEstr2Colpo: 0, tEstr3Colpo: 0, tEstrRobot: 0, tTerzaPiastra: 0,
  tRadMecc: 0, tRadIdraul: 0, tRadPneum: 0, tSoffi: 0, tEstrSpazzole: 0,
  tAvvitamenti: 0, tSvitamenti: 0,
  // tempi ciclo
  tSlittaAvT: 1, tRitIniezT: 0.2, tRiempT: 0.8,
  tCarMat: 0, tRisucchio: 0, tCicloReale: 0,
};

// ── Multi-gruppo (stampi multi-impronta con figure diverse tra loro) — portato da CycleTime Pro ──
// Con 0 o 1 gruppo definito l'interfaccia e i calcoli restano quelli semplici di sempre, a
// campi diretti (S.spPezzo, S.areaProiettata, ...). Da 2 gruppi in su, ogni gruppo rappresenta
// una figura diversa dello stampo con la propria geometria, e i valori usati nei calcoli di
// processo vengono aggregati dai gruppi invece che letti direttamente dai campi top-level.
export function isMultiGruppo(S) {
  return Array.isArray(S.gruppi) && S.gruppi.length > 1;
}

export function nuovoGruppoVuoto(nCavDefault) {
  return {
    nCavGruppo: nCavDefault != null ? nCavDefault : 1,
    volPezzo: null, volSfrido: null, spPezzo: null, spPezzoMax: null,
    areaProiettata: null, lPerc: null,
  };
}

// Somma delle cavità assegnate a tutti i gruppi — deve coincidere con N° cavità totale (S.nCav).
export function totaleCavitaGruppi(S) {
  if (!Array.isArray(S.gruppi)) return 0;
  return S.gruppi.reduce((sum, g) => sum + (parseInt(g.nCavGruppo) || 0), 0);
}

function getNCavTotale(S) {
  if (isMultiGruppo(S)) return totaleCavitaGruppi(S) || S.nCav || 1;
  return S.nCav || 1;
}

// Spessore di riferimento per i calcoli di processo (TMP, tempo ciclo): il massimo tra i
// gruppi, perché lo spessore maggiore è il vincolo dominante per raffreddamento/mantenimento.
// A gruppo singolo resta semplicemente S.spPezzo.
export function getSpessoreRiferimento(S) {
  if (isMultiGruppo(S)) {
    const valori = S.gruppi.map((g) => g.spPezzo).filter((v) => v != null && v > 0);
    return valori.length ? Math.max(...valori) : null;
  }
  return S.spPezzo;
}

// Indice del gruppo che determina lo spessore di riferimento (per evidenziarlo in UI come
// "figura critica" per il raffreddamento/mantenimento). -1 se non applicabile.
export function getGruppoCritico(S) {
  if (!isMultiGruppo(S)) return -1;
  const spRif = getSpessoreRiferimento(S);
  if (spRif == null) return -1;
  return S.gruppi.findIndex((g) => g.spPezzo != null && g.spPezzo === spRif);
}

// Sp. Max pezzo di riferimento (per il tempo di raffreddamento): stessa logica dello spessore
// di riferimento — il massimo tra i gruppi. Se un gruppo non ha Sp.Max compilato usa il suo
// Sp.pezzo medio, come fa il resto dell'app quando manca lo spessore di estrazione dedicato.
export function getSpessoreMaxRiferimento(S) {
  if (isMultiGruppo(S)) {
    const valori = S.gruppi.map((g) => g.spPezzoMax ?? g.spPezzo).filter((v) => v != null && v > 0);
    return valori.length ? Math.max(...valori) : null;
  }
  return S.spPezzoMax;
}

// Area proiettata TOTALE su tutte le cavità dello stampo — usata direttamente nel calcolo
// della forza di chiusura (senza bisogno di moltiplicarla ancora per N° cavità).
// Multi-gruppo: Σ (area di 1 figura del gruppo × cavità di quel gruppo).
// Gruppo singolo: area per cavità (S.areaProiettata) × N° cavità totale.
export function getAreaProiettataTotale(S) {
  if (isMultiGruppo(S)) {
    const tot = S.gruppi.reduce((sum, g) => sum + ((g.areaProiettata || 0) * (parseInt(g.nCavGruppo) || 0)), 0);
    return tot > 0 ? tot : null;
  }
  return S.areaProiettata != null ? S.areaProiettata * (S.nCav || 1) : null;
}

// Volume totale stampata (pezzo+sfrido, su tutte le cavità) sommato sui gruppi — usato per il
// peso stampata in modalità multi-gruppo (in modalità singola resta la formula esistente).
function getVolStampataPesataGruppi(S) {
  return S.gruppi.reduce((sum, g) => {
    const volUnit = (g.volPezzo || 0) + (g.volSfrido || 0);
    return sum + volUnit * (parseInt(g.nCavGruppo) || 0);
  }, 0) || null;
}

// Calcola tutti i valori derivati dallo stato + materiale scelto
export function computeAll(S, materialsById) {
  const mat = materialsById[S.materialeId];
  const C = {};
  if (!mat) return C;

  const sez = getSezVite(S.dvite); // cm²
  const mm2cm3 = (mm) => (mm != null && sez ? (mm * sez) / 10 : null);

  // Peso stampata: (Volume pezzo + Volume sfrido) × nCavità × Dsol
  // In multi-gruppo il peso totale aggrega i volumi di ciascun gruppo (già pesati per le
  // cavità di quel gruppo); il dettaglio "per singolo pezzo" (volStampata/pesoPezzo/pesoSfrido)
  // non ha un unico valore quando le figure dei gruppi sono diverse tra loro, quindi resta
  // valorizzato solo a gruppo singolo.
  const multiG = isMultiGruppo(S);
  const nCav = getNCavTotale(S);
  if (multiG) {
    const volStampataPesata = getVolStampataPesataGruppi(S);
    C.volStampata = null;
    C.pesoPezzo = null;
    C.pesoSfrido = null;
    C.pStamp = volStampataPesata != null && mat.density_solid ? volStampataPesata * mat.density_solid : null;
  } else {
    const volUnit = (S.volPezzo || 0) + (S.volSfrido || 0);
    C.volStampata = volUnit > 0 ? volUnit : null;
    C.pesoPezzo = S.volPezzo != null && mat.density_solid ? S.volPezzo * mat.density_solid : null;
    C.pesoSfrido = S.volSfrido != null && mat.density_solid ? S.volSfrido * mat.density_solid : null;
    C.pStamp = C.volStampata != null && mat.density_solid ? C.volStampata * mat.density_solid * nCav : null;
  }

  // Ø vite ottimale (differenziata cristallini/amorfi) + range commerciale
  if (C.pStamp && mat.density_liquid) {
    const k = mat.material_type === "cristallino" ? 1.59 : 0.64;
    C.dOttimale = 10 * Math.pow((k * C.pStamp) / mat.density_liquid, 1 / 3);
  } else C.dOttimale = null;
  const brack = C.dOttimale != null ? getDminDmax(C.dOttimale) : { dmin: null, dmax: null };
  C.dMin = brack.dmin; C.dMax = brack.dmax;
  C.sezVite = sez;

  // Velocità periferica / rotazione vite
  C.vperMs = S.dvite && S.nRpm ? 0.523 * (S.nRpm / 100) * (S.dvite / 100) : null;
  C.vperMmin = C.vperMs != null ? C.vperMs * 60 : null;
  C.vRotPerc = S.nRpm && S.nGiriMax ? (S.nRpm / S.nGiriMax) * 100 : null;
  // giri ideali per raggiungere vper max del materiale
  C.nRpmIdeale = mat.max_peripheral_speed && S.dvite ? (mat.max_peripheral_speed * 100) / (0.523 * (S.dvite / 100)) : null;

  // Dosaggio: CM, cuscino, QSCM, Q commutazione
  if (C.pStamp && mat.density_liquid && sez) {
    C.cmMm = (C.pStamp * 10) / (sez * mat.density_liquid);
    C.cmCm3 = C.pStamp / mat.density_liquid;
    C.qscm = C.cmMm + (S.cuscino || 0);
    C.qscmCm3 = mm2cm3(C.qscm);
    C.cuscinoCm3 = mm2cm3(S.cuscino);
    C.qcomm = mat.density_solid ? C.qscm - (C.cmMm * mat.density_liquid) / mat.density_solid : null;
    C.qcommCm3 = mm2cm3(C.qcomm);
  }

  // Contropressione specifica / decompressione volume
  C.contropressioneSpec = S.contropressione && S.rapPsiPi ? S.contropressione * S.rapPsiPi : null;
  C.decompressioneCm3 = mm2cm3(S.decompressione);

  // Profilo temperatura U/A/B/C/D (formula vademecum)
  const TA = S.taStampaggio != null && S.taStampaggio > 0 ? S.taStampaggio : mat.melt_temp_recommended;
  if (TA != null && C.cmMm && S.dvite) {
    let nD = C.cmMm / S.dvite;
    nD = Math.max(1, Math.min(3, nD));
    const dTp = mat.dt_profile || 30;
    const DT = (nD - 2) * dTp;
    const dT = DT / 4;
    C.nD = nD;
    C.zonaU = TA; C.zonaA = TA + dT; C.zonaB = TA + dT * 2; C.zonaC = TA + dT * 3; C.zonaD = TA + dT * 4;
  }
  C.taStampaggioEff = TA;

  // Tempo riempimento teorico + Qmax + Vmax
  if (S.lPerc && mat.front_velocity) {
    C.tRiempTeorico = S.lPerc / 10 / mat.front_velocity; // cm / (cm/s)
  }
  C.volStampataCm3 = C.pStamp && mat.density_solid ? C.pStamp / mat.density_solid : null;
  if (C.volStampataCm3 && C.tRiempTeorico) {
    C.qmaxTeorico = C.volStampataCm3 / C.tRiempTeorico;
    C.vmaxMms = sez ? (C.qmaxTeorico / sez) * 10 : null;
    C.qmaxHalf = C.qmaxTeorico / 2;
    C.qmaxPerc = S.qmaxPressa ? (C.qmaxTeorico / S.qmaxPressa) * 100 : null;
  }

  // Velocità 1-4: equivalenti cm³/s e % su Vmax
  [1, 2, 3, 4].forEach((n) => {
    const v = S[`vel${n}`];
    C[`qv${n}Cm3s`] = v && sez ? (v * sez) / 10 : null;
    C[`vel${n}Perc`] = v && C.vmaxMms ? (v / C.vmaxMms) * 100 : null;
  });
  C.qVel2Cm3 = mm2cm3(S.qVel2);
  C.qVel3Cm3 = mm2cm3(S.qVel3);
  C.qVel4Cm3 = mm2cm3(S.qVel4);

  // Mantenimento pressioni specifiche
  C.pressIniezSpec = S.pressIniez && S.rapPsiPi ? S.pressIniez * S.rapPsiPi : null;
  C.pp1Spec = S.pp1 && S.rapPsiPi ? S.pp1 * S.rapPsiPi : null;
  C.pp2Spec = S.pp2 && S.rapPsiPi ? S.pp2 * S.rapPsiPi : null;

  // TMP: teorico (con T.riemp teorico Qmax/2 per amorfi) + economico (con S.tRiemp) + sezione sottile
  // In multi-gruppo lo spessore usato è il massimo tra i gruppi (vincolo dominante per
  // raffreddamento/mantenimento) — vedi getSpessoreRiferimento. Lo spessore di sezione sottile
  // resta sempre globale e manuale, anche in multi-gruppo (come in CycleTime Pro).
  const sp = getSpessoreRiferimento(S);
  const spThin = S.spSezSottile;
  C.spRiferimento = sp;
  C.gruppoCritico = getGruppoCritico(S);
  const isCryst = mat.material_type === "cristallino";
  const vcrist = mat.crystallization_velocity;
  const tmpFormula = (spVal, tRiemp) =>
    spVal != null ? (isCryst && vcrist ? spVal * vcrist : spVal * (tRiemp || 0)) : null;
  C.tmpTeorico = tmpFormula(sp, C.tRiempTeorico);
  C.tmpEconomico = tmpFormula(sp, S.tRiemp);
  C.tmpSezSottile = tmpFormula(spThin, S.tRiemp || C.tRiempTeorico);
  C.tmp = C.tmpEconomico != null ? C.tmpEconomico : C.tmpTeorico;

  // Tempo di raffreddamento — usa Sp.Max (in multi-gruppo, il massimo tra i gruppi)
  const spMaxRif = getSpessoreMaxRiferimento(S);
  C.spMaxRiferimento = spMaxRif;
  if (mat.thermal_factor_a && mat.melt_temp_recommended && mat.mold_temp_recommended && mat.ejection_temp && spMaxRif) {
    const tmassa = mat.melt_temp_recommended + 40;
    const arg = (tmassa - mat.mold_temp_recommended) / (mat.ejection_temp - mat.mold_temp_recommended);
    C.tRaffReale = arg > 1 ? Math.max(0, ((spMaxRif ** 2) / mat.thermal_factor_a) * Math.log(arg)) : null;
    C.tRaff = C.tRaffReale != null ? Math.max(0, C.tRaffReale - (C.tmp || 0)) : null;
  }

  // Forza di chiusura richiesta — area proiettata totale su tutte le cavità (in multi-gruppo,
  // somma pesata per cavità di ciascun gruppo; a gruppo singolo, area per cavità × N° cavità)
  const pSpecEff = S.pressIniez * S.rapPsiPi || 0;
  const areaProiettataTot = getAreaProiettataTotale(S);
  C.areaProiettataTotale = areaProiettataTot;
  if (areaProiettataTot && pSpecEff) {
    C.forzaCalc = (areaProiettataTot * pSpecEff * 0.1) / 9.81; // kN
    C.forzaCalcT = C.forzaCalc / 9.81; // t
    C.forzaPerc = S.tonnellaggio ? (C.forzaCalcT / S.tonnellaggio) * 100 : null;
  }

  // Tempo interciclo (movimenti apertura/estrazione/ausiliari)
  C.tInterciclo =
    (S.tEstr1Colpo || 0) + (S.tEstr2Colpo || 0) + (S.tEstr3Colpo || 0) + (S.tEstrRobot || 0) +
    (S.tTerzaPiastra || 0) + (S.tRadMecc || 0) + (S.tRadIdraul || 0) + (S.tRadPneum || 0) +
    (S.tSoffi || 0) + (S.tEstrSpazzole || 0) + (S.tAvvitamenti || 0) + (S.tSvitamenti || 0);

  // Tempo di ciclo totale
  C.tTotale =
    (S.tChiusura || 0) + (S.tSlittaAvT || 0) + (S.tRitIniezT || 0) + (S.tRiempT || 0) +
    (C.tmp || 0) + (C.tRaff || 0) + (S.tCarMat || 0) + (S.tRisucchio || 0) +
    (S.tAperturaT || 0) + (C.tInterciclo || 0);

  // Tempo permanenza in cilindro
  if (mat.max_barrel_use_pct && C.tTotale) {
    C.tPermanenzaTeorica = (C.tTotale / 60) * (100 / mat.max_barrel_use_pct);
  }
  C.tPermMax = mat.max_residence_time;
  if (mat.max_barrel_use_pct && S.tCicloReale) {
    C.tPermanenzaReale = (S.tCicloReale / 60) * (100 / mat.max_barrel_use_pct);
  }
  const permCheck = C.tPermanenzaReale ?? C.tPermanenzaTeorica;
  if (permCheck != null && C.tPermMax != null && permCheck > C.tPermMax) {
    C.permanenzaWarn = `Permanenza ${permCheck.toFixed(1)} min > massimo ${C.tPermMax} min per ${mat.name} — rischio degrado`;
  }

  return C;
}

// Parser STL binario/ASCII → BufferGeometry Three.js
export async function parseSTL(buf) {
  const THREE = await import("three");
  const view = new DataView(buf);
  const isBinary = buf.byteLength > 84 && (() => {
    const n = view.getUint32(80, true);
    return buf.byteLength === 84 + n * 50;
  })();
  let geom;
  if (isBinary) {
    const n = view.getUint32(80, true);
    const pos = new Float32Array(n * 9);
    for (let i = 0; i < n; i++) {
      const off = 84 + i * 50 + 12;
      for (let v = 0; v < 3; v++) {
        pos[i * 9 + v * 3] = view.getFloat32(off + v * 12, true);
        pos[i * 9 + v * 3 + 1] = view.getFloat32(off + v * 12 + 4, true);
        pos[i * 9 + v * 3 + 2] = view.getFloat32(off + v * 12 + 8, true);
      }
    }
    geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  } else {
    const txt = new TextDecoder().decode(buf);
    const verts = [];
    const re = /vertex\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)/gi;
    let m;
    while ((m = re.exec(txt)) !== null) verts.push(+m[1], +m[2], +m[3]);
    geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts), 3));
  }
  geom.computeVertexNormals();
  return geom;
}

// ── STEP parsing via occt-import-js (CDN, WASM) ──
let _occtPromise = null;
function loadOcctEngine() {
  if (_occtPromise) return _occtPromise;
  _occtPromise = new Promise((resolve, reject) => {
    if (window.occtimportjs) return initOcct();
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/dist/occt-import-js.js";
    s.onload = initOcct;
    s.onerror = () => reject(new Error("Impossibile scaricare il motore STEP dalla CDN. Verifica la connessione."));
    document.head.appendChild(s);

    function initOcct() {
      try {
        window.occtimportjs({
          locateFile: (p) => p.endsWith(".wasm")
            ? "https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/dist/occt-import-js.wasm"
            : p,
        }).then(resolve).catch(() => reject(new Error("Motore STEP non inizializzato (browser senza WebAssembly?).")));
      } catch (err) { reject(err); }
    }
  });
  return _occtPromise;
}

export async function parseSTEP(buf) {
  const THREE = await import("three");
  const occt = await loadOcctEngine();
  const bytes = new Uint8Array(buf);
  const result = occt.ReadStepFile(bytes, {
    linearUnit: "millimeter",
    linearDeflectionType: "bounding_box_ratio",
    linearDeflection: 0.003,
    angularDeflection: 0.3,
  });
  if (!result || !result.success || !result.meshes || !result.meshes.length) {
    throw new Error("Il file STEP non contiene una geometria leggibile (dev'essere un solido).");
  }
  // Merge di tutte le mesh in un'unica BufferGeometry (posizioni "flatten" per triangolo)
  const positions = [];
  const indices = [];
  let vOff = 0;
  for (const m of result.meshes) {
    const pa = m.attributes.position.array;
    for (let i = 0; i < pa.length; i++) positions.push(pa[i]);
    const ia = m.index.array;
    for (let i = 0; i < ia.length; i++) indices.push(ia[i] + vOff);
    vOff += pa.length / 3;
  }
  if (!positions.length) throw new Error("Tassellazione vuota: il modello STEP potrebbe non essere un solido chiuso.");
  const flat = new Float32Array(indices.length * 3);
  for (let t = 0; t < indices.length; t++) {
    const vi = indices[t] * 3;
    flat[t * 3] = positions[vi];
    flat[t * 3 + 1] = positions[vi + 1];
    flat[t * 3 + 2] = positions[vi + 2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(flat, 3));
  g.computeVertexNormals();
  return g;
}

// ── Stima spessore parete via ray casting con griglia di accelerazione (3D-DDA) ──
// Da un campione di triangoli (pesato per area, non a passo fisso: su mesh con triangolazione
// irregolare — tipico dell'export CAD — un passo fisso sovracampiona le zone più triangolate e
// sottocampiona le pareti piatte con pochi triangoli grandi) si spara un raggio dal baricentro
// verso l'interno (direzione opposta alla normale) e si misura la distanza alla parete opposta:
// è lo spessore locale in quel punto. Sui valori raccolti si prendono percentili robusti
// (5° / mediana / 95°) perché su spigoli, raccordi e nervature i raggi possono dare valori
// degeneri. Il campionamento usa un seed deterministico (LCG): stesso file → stesso risultato,
// riproducibile e confrontabile. Sotto i 30 campioni validi la stima è scartata (mesh aperta o
// degenerata) invece di restituire un valore inaffidabile mostrato con la stessa sicurezza di
// uno buono — portato da CycleTime Pro dopo che il campionamento a passo fisso dava valori
// sbilanciati su mesh reali.
function estimateThickness(pos, nTri, b) {
  const arr = pos.array;
  const dx = b.maxX - b.minX, dy = b.maxY - b.minY, dz = b.maxZ - b.minZ;
  const diag = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  const empty = { spMin: null, spMed: null, spMax: null, nValid: 0 };
  if (nTri < 4) return empty;

  // griglia uniforme sull'asse più lungo (~48 celle)
  const cs = Math.max(dx, dy, dz) / 48 || 1;
  const nx = Math.max(1, Math.ceil(dx / cs));
  const ny = Math.max(1, Math.ceil(dy / cs));
  const nz = Math.max(1, Math.ceil(dz / cs));
  const cIdx = (i, j, k) => (k * ny + j) * nx + i;
  const clampI = (v, m) => Math.max(0, Math.min(m - 1, v));
  const cells = new Array(nx * ny * nz);

  // popola le celle con gli indici dei triangoli che le intersecano
  for (let t = 0; t < nTri; t++) {
    const o = t * 9;
    const x0 = Math.min(arr[o], arr[o + 3], arr[o + 6]);
    const x1 = Math.max(arr[o], arr[o + 3], arr[o + 6]);
    const y0 = Math.min(arr[o + 1], arr[o + 4], arr[o + 7]);
    const y1 = Math.max(arr[o + 1], arr[o + 4], arr[o + 7]);
    const z0 = Math.min(arr[o + 2], arr[o + 5], arr[o + 8]);
    const z1 = Math.max(arr[o + 2], arr[o + 5], arr[o + 8]);
    const i0 = clampI(Math.floor((x0 - b.minX) / cs), nx);
    const i1 = clampI(Math.floor((x1 - b.minX) / cs), nx);
    const j0 = clampI(Math.floor((y0 - b.minY) / cs), ny);
    const j1 = clampI(Math.floor((y1 - b.minY) / cs), ny);
    const k0 = clampI(Math.floor((z0 - b.minZ) / cs), nz);
    const k1 = clampI(Math.floor((z1 - b.minZ) / cs), nz);
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const c = cIdx(i, j, k);
          (cells[c] || (cells[c] = [])).push(t);
        }
  }

  // Möller–Trumbore
  function hitTri(t, ox, oy, oz, ddx, ddy, ddz) {
    const o9 = t * 9;
    const ax = arr[o9], ay = arr[o9 + 1], az = arr[o9 + 2];
    const e1x = arr[o9 + 3] - ax, e1y = arr[o9 + 4] - ay, e1z = arr[o9 + 5] - az;
    const e2x = arr[o9 + 6] - ax, e2y = arr[o9 + 7] - ay, e2z = arr[o9 + 8] - az;
    const px = ddy * e2z - ddz * e2y, py = ddz * e2x - ddx * e2z, pz = ddx * e2y - ddy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) return null;
    const inv = 1 / det;
    const tx = ox - ax, ty = oy - ay, tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -1e-6 || u > 1 + 1e-6) return null;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (ddx * qx + ddy * qy + ddz * qz) * inv;
    if (v < -1e-6 || u + v > 1 + 1e-6) return null;
    const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return tt > 1e-3 ? tt : null;
  }

  const tCap = diag * 0.5;

  // normale e area di un triangolo (usata sia per il campionamento pesato sia per il raggio
  // verso l'interno); se outN è fornito ci scrive la normale unitaria
  function triNormalArea(t, outN) {
    const o = t * 9;
    const e1x = arr[o + 3] - arr[o], e1y = arr[o + 4] - arr[o + 1], e1z = arr[o + 5] - arr[o + 2];
    const e2x = arr[o + 6] - arr[o], e2y = arr[o + 7] - arr[o + 1], e2z = arr[o + 8] - arr[o + 2];
    const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
    const l = Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (outN && l > 1e-12) { outN[0] = cx / l; outN[1] = cy / l; outN[2] = cz / l; }
    return l / 2;
  }

  // ── Campionamento pesato per area (non a passo fisso) ──
  // Un passo fisso ogni N triangoli sovracampiona le zone della mesh con triangolazione fitta
  // (curve, raccordi) e sottocampiona le pareti piatte con pochi triangoli grandi, che sono
  // spesso le più rappresentative per lo spessore reale del pezzo. Pesando per area cumulata
  // ogni porzione di superficie ha probabilità di campionamento proporzionale alla sua
  // estensione, indipendentemente da quanto è triangolata. Seed deterministico (LCG): lo stesso
  // file dà sempre lo stesso risultato, riproducibile e confrontabile tra due letture.
  const cumArea = new Float64Array(nTri);
  let accArea = 0;
  for (let t = 0; t < nTri; t++) { accArea += triNormalArea(t, null); cumArea[t] = accArea; }
  if (accArea <= 0) return empty;

  let seed = 123456789;
  const rnd = () => { seed = (1103515245 * seed + 12345) >>> 0; return seed / 4294967296; };
  const nSamples = Math.min(1500, Math.max(300, nTri));
  const norm = new Float32Array(3);
  const thickness = [];

  for (let s = 0; s < nSamples; s++) {
    // triangolo scelto per area cumulata (ricerca binaria)
    const r = rnd() * accArea;
    let lo = 0, hi = nTri - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cumArea[mid] < r) lo = mid + 1; else hi = mid; }
    const t = lo;
    if (triNormalArea(t, norm) <= 1e-12) continue;
    const o = t * 9;
    // baricentro triangolo
    const ox = (arr[o] + arr[o + 3] + arr[o + 6]) / 3;
    const oy = (arr[o + 1] + arr[o + 4] + arr[o + 7]) / 3;
    const oz = (arr[o + 2] + arr[o + 5] + arr[o + 8]) / 3;
    // raggio verso l'interno (direzione opposta alla normale, uscente su mesh ben orientata)
    const ddx = -norm[0], ddy = -norm[1], ddz = -norm[2];
    // offset piccolo dal baricentro per evitare auto-hit del triangolo di partenza
    const eps = diag * 1e-5;
    const sox = ox + ddx * eps, soy = oy + ddy * eps, soz = oz + ddz * eps;

    // 3D-DDA sulle celle
    let i = clampI(Math.floor((sox - b.minX) / cs), nx);
    let j = clampI(Math.floor((soy - b.minY) / cs), ny);
    let k = clampI(Math.floor((soz - b.minZ) / cs), nz);
    const si = ddx > 0 ? 1 : -1, sj = ddy > 0 ? 1 : -1, sk = ddz > 0 ? 1 : -1;
    const nbx = (v, mn, idx, sgn) => mn + (idx + (sgn > 0 ? 1 : 0)) * cs;
    let tMX = ddx !== 0 ? (nbx(sox, b.minX, i, si) - sox) / ddx : Infinity;
    let tMY = ddy !== 0 ? (nbx(soy, b.minY, j, sj) - soy) / ddy : Infinity;
    let tMZ = ddz !== 0 ? (nbx(soz, b.minZ, k, sk) - soz) / ddz : Infinity;
    const tDX = ddx !== 0 ? Math.abs(cs / ddx) : Infinity;
    const tDY = ddy !== 0 ? Math.abs(cs / ddy) : Infinity;
    const tDZ = ddz !== 0 ? Math.abs(cs / ddz) : Infinity;
    let best = Infinity, entry = 0;

    for (let stp = 0; stp < nx + ny + nz + 3; stp++) {
      const list = cells[cIdx(i, j, k)];
      if (list) {
        for (let mi = 0; mi < list.length; mi++) {
          const tri = list[mi];
          if (tri === t) continue; // skip triangolo di partenza
          const h = hitTri(tri, sox, soy, soz, ddx, ddy, ddz);
          if (h !== null && h < best) best = h;
        }
      }
      if (best <= entry) break;
      if (tMX < tMY && tMX < tMZ) { entry = tMX; i += si; tMX += tDX; if (i < 0 || i >= nx) break; }
      else if (tMY < tMZ) { entry = tMY; j += sj; tMY += tDY; if (j < 0 || j >= ny) break; }
      else { entry = tMZ; k += sk; tMZ += tDZ; if (k < 0 || k >= nz) break; }
      if (entry > Math.min(best, tCap)) break;
    }
    if (best !== Infinity && best <= tCap && best > eps * 2) thickness.push(best);
  }

  // Sotto i 30 campioni validi la stima statistica non è affidabile (mesh aperta, degenerata,
  // o troppo piccola): meglio dichiararla non disponibile che mostrare un valore con la stessa
  // sicurezza grafica di una stima solida.
  if (thickness.length < 30) return empty;
  thickness.sort((a, b) => a - b);
  const p = (frac) => thickness[Math.max(0, Math.min(thickness.length - 1, Math.round(frac * (thickness.length - 1))))];
  return {
    spMin: p(0.05),   // 5° percentile → sezione sottile
    spMed: p(0.5),    // mediana → spessore medio
    spMax: p(0.95),   // 95° percentile → spessore massimo
    nValid: thickness.length,
  };
}

// Calcola volume (divergence theorem), bounding box, area proiettata XY, spessori (min/med/max)
export function computeMeshMetrics(geom) {
  const pos = geom.attributes.position;
  const nTri = pos.count / 3;
  let volume = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let projAreaUp = 0;

  for (let i = 0; i < nTri; i++) {
    const ax = pos.getX(i * 3), ay = pos.getY(i * 3), az = pos.getZ(i * 3);
    const bx = pos.getX(i * 3 + 1), by = pos.getY(i * 3 + 1), bz = pos.getZ(i * 3 + 1);
    const cx = pos.getX(i * 3 + 2), cy = pos.getY(i * 3 + 2), cz = pos.getZ(i * 3 + 2);
    if (ax < minX) minX = ax; if (bx < minX) minX = bx; if (cx < minX) minX = cx;
    if (ax > maxX) maxX = ax; if (bx > maxX) maxX = bx; if (cx > maxX) maxX = cx;
    if (ay < minY) minY = ay; if (by < minY) minY = by; if (cy < minY) minY = cy;
    if (ay > maxY) maxY = ay; if (by > maxY) maxY = by; if (cy > maxY) maxY = cy;
    if (az < minZ) minZ = az; if (bz < minZ) minZ = bz; if (cz < minZ) minZ = cz;
    if (az > maxZ) maxZ = az; if (bz > maxZ) maxZ = bz; if (cz > maxZ) maxZ = cz;
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const ux = bx - ax, uy = by - ay;
    const vx = cx - ax, vy = cy - ay;
    const nz = ux * vy - uy * vx;
    if (nz > 0) projAreaUp += nz / 2;
  }
  volume = Math.abs(volume); // mm³
  const bbX = maxX - minX, bbY = maxY - minY, bbZ = maxZ - minZ;

  // Stima spessori via ray casting (non più il bbox min: dava valori sballati)
  const th = estimateThickness(pos, nTri, { minX, maxX, minY, maxY, minZ, maxZ });

  // Percorso max: metà diagonale della base xy (approssimazione ragionevole)
  const percorso = Math.sqrt(bbX * bbX + bbY * bbY) / 2;

  return {
    volumeMm3: volume,
    volumeCm3: volume / 1000,
    areaProiettataMm2: projAreaUp,
    areaProiettataCm2: projAreaUp / 100,
    bbX, bbY, bbZ,
    spessoreMin: th.spMin,   // sezione sottile
    spessoreMedio: th.spMed, // spessore medio pezzo
    spessoreMax: th.spMax,   // spessore massimo (per Traff)
    spCampioni: th.nValid,
    percorsoMax: percorso,
    nTriangoli: nTri,
  };
}
