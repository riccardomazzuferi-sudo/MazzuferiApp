import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Button } from "../components/ui/button";
import { toast } from "sonner";
import { UploadSimple, Play, Pause, Target, MapPin, Trash, Warning, CheckCircle, XCircle, Info } from "@phosphor-icons/react";
import { parseSTL, parseSTEP, computeMeshMetrics } from "../lib/molding-calc";
import { FlowEngine } from "../lib/flow-engine";
import { YUDO_SERIES, CURVA_LABEL, guessYudoHint, yudoFlowMax, buildFlowReport } from "../lib/flow-sim";

// Stessi componenti di stile minimale usati nella Scheda stampaggio (Field/NumInput), tenuti
// locali per non introdurre una dipendenza incrociata tra pagine.
const Field = ({ label, unit, children }) => (
  <div className="flex flex-col gap-1">
    <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</label>
    {children}
    {unit && <span className="text-[9px] text-slate-500">{unit}</span>}
  </div>
);
const inputCls = "h-9 rounded-sm font-mono text-sm border px-2 outline-none w-full transition-colors bg-amber-950/20 border-amber-700 text-slate-100 focus:border-amber-500";
const calcCls = "h-9 rounded-sm font-mono text-sm border px-2 outline-none w-full bg-orange-950/40 border-orange-700 text-orange-200 font-bold";

const NOTE_STYLE = {
  ok: { cls: "border-emerald-700 bg-emerald-950/30 text-emerald-200", Icon: CheckCircle },
  warn: { cls: "border-amber-700 bg-amber-950/30 text-amber-200", Icon: Warning },
  err: { cls: "border-red-700 bg-red-950/30 text-red-200", Icon: XCircle },
  info: { cls: "border-slate-700 bg-slate-800/40 text-slate-400", Icon: Info },
};

export default function FlowSimulation() {
  const [materials, setMaterials] = useState([]);
  const [materialId, setMaterialId] = useState("");
  const [velAf, setVelAf] = useState(20);
  const [curva, setCurva] = useState("ABS");
  const [visc, setVisc] = useState("MEDIUM");
  const [sp, setSp] = useState("");
  const [serie, setSerie] = useState("");

  const [stlInfo, setStlInfo] = useState("");
  const [meshVolCm3, setMeshVolCm3] = useState(null);
  const [gatesCount, setGatesCount] = useState(0);
  const [gateMode, setGateMode] = useState(false);
  const [hasMesh, setHasMesh] = useState(false);
  const [sim, setSim] = useState(null); // { tMax, dMax, ... } solo per abilitare/disabilitare UI
  const [curT, setCurT] = useState(0);
  const [tMax, setTMax] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [animSpeed, setAnimSpeed] = useState(1);
  const [invalidMsg, setInvalidMsg] = useState("");

  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const fileRef = useRef(null);

  const materialsById = useMemo(() => Object.fromEntries(materials.map((m) => [m.id, m])), [materials]);
  const mat = materialsById[materialId];

  useEffect(() => {
    (async () => {
      try { const r = await api.get("/materials"); setMaterials(r.data); } catch { /* opzionale */ }
    })();
  }, []);

  // Motore three.js: un'unica istanza per il ciclo di vita del componente
  useEffect(() => {
    const engine = new FlowEngine({
      onGatesChange: (n) => setGatesCount(n),
      onMeshInfo: ({ fname, nTri, nNodes, nCross, heavy, meshVolCm3: vol }) => {
        setMeshVolCm3(vol);
        setHasMesh(true);
        const warn = heavy ? " ⚠ Mesh molto pesante: la simulazione potrebbe richiedere qualche secondo." : "";
        setStlInfo(`✓ ${fname} — ${nTri.toLocaleString("it-IT")} triangoli, ${nNodes.toLocaleString("it-IT")} nodi di flusso, ${nCross.toLocaleString("it-IT")} collegamenti attraverso lo spessore (pelle interna ed esterna accoppiate). Posiziona almeno un gate e avvia la simulazione.${warn}`);
      },
      onSimResult: (s) => { setSim(s); setTMax(s.tMax); setCurT(s.tMax); setInvalidMsg(""); },
      onSimInvalidated: (msg) => { setSim(null); setPlaying(false); if (msg) setInvalidMsg(msg); },
      onTimeChange: (t, tm) => { setCurT(t); setTMax(tm); },
      onPlayingChange: (p) => setPlaying(p),
    });
    engineRef.current = engine;
    if (canvasRef.current) engine.mount(canvasRef.current);
    return () => engine.destroy();
    // eslint-disable-next-line
  }, []);

  useEffect(() => { if (engineRef.current) engineRef.current.animSpeedMult = animSpeed; }, [animSpeed]);

  const onMaterialChange = (id) => {
    setMaterialId(id);
    const m = materialsById[id];
    if (m) {
      const hint = guessYudoHint(m);
      setVelAf(m.front_velocity || hint.velAf);
      setCurva(hint.curva);
      setVisc(hint.visc);
    }
    engineRef.current?._invalidateSim?.("Materiale modificato: riesegui la simulazione.");
  };

  const onFile = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const ext = f.name.split(".").pop().toLowerCase();
    if (!["stl", "step", "stp"].includes(ext)) { toast.error("Formato non supportato: usa STL, STEP o STP"); return; }
    const isStep = ext === "step" || ext === "stp";
    setStlInfo(isStep ? "⏳ Caricamento motore STEP (prima volta: qualche secondo)…" : "Lettura file STL in corso…");
    try {
      const buf = await f.arrayBuffer();
      const geom = isStep ? await parseSTEP(buf) : await parseSTL(buf);
      if (isStep) setStlInfo("⏳ Tassellazione STEP completata, costruzione grafo di flusso…");
      // riuso computeMeshMetrics anche qui solo per suggerire lo spessore di parete se vuoto
      if (!sp) {
        const m = computeMeshMetrics(geom);
        if (m.spessoreMedio != null) setSp(String(+m.spessoreMedio.toFixed(2)));
      }
      engineRef.current.loadGeometry(geom, f.name);
      toast.success(`Geometria importata da ${ext.toUpperCase()}`);
    } catch (err) {
      setStlInfo("⚠ Errore: " + err.message);
      toast.error("Errore lettura " + ext.toUpperCase());
    } finally {
      if (e.target) e.target.value = "";
    }
  };

  const toggleGateMode = () => setGateMode(engineRef.current.toggleGateMode());
  const clearGates = () => engineRef.current.clearGates();
  const runSimulation = () => {
    if (!velAf || velAf <= 0) { toast.error("Imposta una velocità di avanzamento fronte valida."); return; }
    engineRef.current.runSimulation(parseFloat(velAf));
  };
  const togglePlay = () => engineRef.current.togglePlay();
  const onSlider = (v) => { if (sim) engineRef.current.setTimeThreshold((tMax * v) / 1000); };
  const resetView = () => engineRef.current.resetView();

  const spNum = sp ? parseFloat(sp) : null;
  const yudoOut = serie ? yudoFlowMax(serie, curva, spNum) : null;

  const report = useMemo(() => {
    if (!sim) return { kpis: [], notes: [] };
    return buildFlowReport({
      sim, sp: spNum, curva, visc, dsol: mat?.density_solid, serie,
      gatesCount, meshVolCm3, matLabel: mat?.name || "—", tipoAmorfo: mat?.material_type !== "cristallino",
    });
    // eslint-disable-next-line
  }, [sim, spNum, curva, visc, serie, gatesCount, meshVolCm3, mat]);

  return (
    <div className="p-6 lg:p-8 max-w-[1400px] mx-auto">
      <div className="mb-6">
        <div className="overline">// operatività</div>
        <h1 className="text-4xl font-black tracking-tight mt-1">Analisi riempimento</h1>
        <p className="text-sm text-slate-400 mt-2 max-w-3xl">
          Simula la propagazione del fronte di flusso dai gate sul modello 3D del pezzo e confronta il percorso con le tabelle di selezione ugelli Yudo.
          Modello geometrico/cinematico (non reologico): utile per un primo controllo di fattibilità, non sostituisce un solutore FEM dedicato (Moldflow, Cadmould).
        </p>
      </div>

      {/* IMPORT */}
      <div className="border border-slate-800 bg-slate-900 rounded-sm mb-4">
        <div className="border-b border-slate-800 px-4 py-2 overline">Modello 3D del pezzo</div>
        <div className="p-4">
          <div onClick={() => fileRef.current?.click()}
            className="border border-dashed border-slate-700 rounded-sm p-6 text-center cursor-pointer hover:border-sky-600 hover:bg-slate-800/40 transition-colors">
            <UploadSimple size={28} className="mx-auto mb-2 text-slate-500" />
            <div className="text-sm font-semibold text-slate-300">Clicca o trascina un file .STL / .STEP / .STP del pezzo</div>
            <div className="text-xs text-slate-500 mt-1">Una sola figura, senza sfrido — usato per costruire il grafo di flusso</div>
            <input ref={fileRef} type="file" accept=".stl,.STL,.step,.STEP,.stp,.STP" onChange={onFile} className="hidden" />
          </div>
          {stlInfo && <div className="text-xs text-sky-300 mt-3 font-mono">{stlInfo}</div>}
        </div>
      </div>

      {/* PARAMETRI */}
      <div className="border border-slate-800 bg-slate-900 rounded-sm mb-4">
        <div className="border-b border-slate-800 px-4 py-2 overline">Parametri simulazione</div>
        <div className="p-4 grid md:grid-cols-4 gap-3">
          <Field label="Materiale">
            <select value={materialId} onChange={(e) => onMaterialChange(e.target.value)} className={inputCls}>
              <option value="">— seleziona —</option>
              {materials.map((m) => <option key={m.id} value={m.id}>{m.code} — {m.name}</option>)}
            </select>
          </Field>
          <Field label="Vel. avanzamento fronte" unit="[cm/s] — dal vademecum, modificabile">
            <input type="number" step="0.5" value={velAf} onChange={(e) => setVelAf(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Curva Yudo" unit="famiglia viscosità per il confronto percorso">
            <select value={curva} onChange={(e) => setCurva(e.target.value)} className={inputCls}>
              {Object.keys(CURVA_LABEL).map((c) => <option key={c} value={c}>{CURVA_LABEL[c]}</option>)}
            </select>
          </Field>
          <Field label="Classe viscosità" unit="per il limite di peso per ugello">
            <select value={visc} onChange={(e) => setVisc(e.target.value)} className={inputCls}>
              <option value="LOW">Bassa (LOW)</option>
              <option value="MEDIUM">Media (MEDIUM)</option>
              <option value="HIGH">Alta (HIGH)</option>
            </select>
          </Field>
          <Field label="Sp. pezzo (parete di flusso)" unit="[mm] — per il rapporto L/s e le tabelle Yudo">
            <input type="number" step="0.1" placeholder="dal disegno" value={sp} onChange={(e) => setSp(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Percorso max calcolato" unit="[mm] — geodetico lungo la superficie, dalla simulazione">
            <input readOnly value={sim ? sim.dMax.toFixed(1) : "—"} className={calcCls} />
          </Field>
          <Field label="Serie ugello Yudo" unit="tabelle percorso di flusso Yudo">
            <select value={serie} onChange={(e) => setSerie(e.target.value)} className={inputCls}>
              <option value="">— (soglie generiche L/s) —</option>
              {YUDO_SERIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Percorso ammissibile (Yudo)" unit="[mm] — da serie + curva + spessore">
            <input readOnly value={yudoOut ? yudoOut.val.toFixed(0) + " mm" + (yudoOut.clamped ? " ⚠" : "") : "—"} className={calcCls} />
          </Field>
        </div>
        <div className="px-4 pb-4">
          <div className="text-[11px] text-slate-400 bg-slate-800/40 border-l-2 border-slate-600 rounded-sm px-3 py-2 leading-relaxed">
            La simulazione propaga il fronte di flusso dai gate alla velocità di avanzamento fronte del materiale. Le due pelli della stessa parete sono accoppiate <strong className="text-slate-300">attraverso lo spessore</strong> (il materiale scorre dentro la parete, il fronte non gira dal bordo). Resta un modello geometrico/cinematico: per viscosità, pressioni locali e variazioni di spessore serve un FEM dedicato. La curva Yudo è una stima per famiglia materiale — correggila sopra se necessario.
          </div>
        </div>
      </div>

      {/* VIEWER */}
      <div className="border border-slate-800 bg-slate-900 rounded-sm mb-4">
        <div className="border-b border-slate-800 px-4 py-2 overline">Simulazione fronte di flusso</div>
        <div className="p-4">
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <Button onClick={toggleGateMode} variant="outline" disabled={!hasMesh}
              className={`h-9 rounded-sm border-slate-700 bg-slate-800 text-xs ${gateMode ? "bg-amber-600 border-amber-500 text-white hover:bg-amber-600" : ""}`}>
              <MapPin size={14} className="mr-1.5" /> Posiziona gate (click sul pezzo)
            </Button>
            <Button onClick={clearGates} variant="outline" disabled={!hasMesh} className="h-9 rounded-sm border-slate-700 bg-slate-800 text-xs">
              <Trash size={14} className="mr-1.5" /> Rimuovi gate
            </Button>
            <div className="w-px h-6 bg-slate-800 mx-1" />
            <Button onClick={runSimulation} disabled={!hasMesh || gatesCount === 0} className="h-9 rounded-sm bg-amber-600 hover:bg-amber-700 text-xs">
              <Play size={14} className="mr-1.5" /> Simula riempimento
            </Button>
            <Button onClick={togglePlay} variant="outline" disabled={!sim} className="h-9 rounded-sm border-slate-700 bg-slate-800 text-xs">
              {playing ? <Pause size={14} className="mr-1.5" /> : <Play size={14} className="mr-1.5" />} {playing ? "Pausa" : "Anima"}
            </Button>
            <div className="w-px h-6 bg-slate-800 mx-1" />
            <Button onClick={resetView} variant="outline" disabled={!hasMesh} className="h-9 rounded-sm border-slate-700 bg-slate-800 text-xs">
              <Target size={14} className="mr-1.5" /> Centra vista
            </Button>
          </div>

          <div className="relative rounded-sm overflow-hidden bg-[#0b1220]" style={{ height: 520 }}>
            <canvas ref={canvasRef} className={`w-full h-full block ${gateMode ? "cursor-crosshair" : "cursor-grab"}`} />
            {!hasMesh && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-600 pointer-events-none">
                <div className="text-4xl opacity-50">🧊</div>
                <div className="text-sm">Importa un modello 3D per iniziare</div>
              </div>
            )}
            <div className="absolute top-2.5 left-2.5 flex flex-col gap-1.5 pointer-events-none">
              <div className="bg-black/55 text-slate-200 text-[10.5px] px-2.5 py-1 rounded-full">Gate: <strong className="text-amber-400">{gatesCount}</strong></div>
              {gateMode && <div className="bg-black/55 text-slate-200 text-[10.5px] px-2.5 py-1 rounded-full">Modalità posizionamento gate: <strong className="text-amber-400">clicca sul pezzo</strong></div>}
            </div>
            {sim && (
              <div className="absolute bottom-3 left-3 bg-black/55 rounded-sm px-3 py-2 text-[10px] text-slate-300">
                <div>Tempo di riempimento</div>
                <div className="w-[150px] h-2.5 rounded-full my-1" style={{ background: "linear-gradient(90deg,#1d4ed8,#06b6d4,#22c55e,#eab308,#ef4444)" }} />
                <div className="flex justify-between"><span>inizio</span><span>{sim.tMax.toFixed(2)} s</span></div>
                <div className="flex items-center gap-1.5 mt-1"><span className="w-2 h-2 rounded-full bg-amber-500 inline-block" /> Gate</div>
                <div className="flex items-center gap-1.5 mt-0.5"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> Linea di giunzione stimata</div>
                <div className="flex items-center gap-1.5 mt-0.5"><span className="w-2 h-2 rounded-full bg-orange-400 inline-block" /> Ultimo riempimento / aria</div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 mt-3">
            <span className="text-xs text-slate-400 font-mono min-w-[130px]">t = {curT.toFixed(2)} s / {tMax.toFixed(2)} s</span>
            <input type="range" min="0" max="1000" value={tMax > 0 ? Math.round((curT / tMax) * 1000) : 0}
              onChange={(e) => onSlider(e.target.value)} disabled={!sim} className="flex-1 accent-amber-500" />
            <select value={animSpeed} onChange={(e) => setAnimSpeed(parseFloat(e.target.value))} className="h-8 rounded-sm bg-amber-950/20 border border-amber-700 text-xs px-2">
              <option value="0.25">0.25×</option>
              <option value="0.5">0.5×</option>
              <option value="1">1×</option>
              <option value="2">2×</option>
              <option value="4">4×</option>
            </select>
          </div>
          <div className="text-[11px] text-slate-400 bg-slate-800/40 border-l-2 border-slate-600 rounded-sm px-3 py-2 mt-3 leading-relaxed">
            Rotazione: trascina col tasto sinistro · Zoom: rotella · Pan: tasto destro. Attiva "Posiziona gate" e clicca sul pezzo (più gate per stampi multi-iniezione). Ogni modifica ai gate richiede una nuova simulazione.
          </div>
          {invalidMsg && !sim && <div className="text-[11px] text-amber-300 mt-2">{invalidMsg}</div>}
        </div>
      </div>

      {/* REPORT */}
      <div className="border border-slate-800 bg-slate-900 rounded-sm mb-4">
        <div className="border-b border-slate-800 px-4 py-2 overline">Report rischi</div>
        <div className="p-4">
          {!sim ? (
            <div className="text-[11px] text-slate-400 bg-slate-800/40 border-l-2 border-slate-600 rounded-sm px-3 py-2">Esegui una simulazione per generare il report.</div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                {report.kpis.map((k, i) => (
                  <div key={i} className="border border-slate-800 bg-slate-950 rounded-sm p-3">
                    <div className="text-[9.5px] font-semibold uppercase tracking-wider text-slate-500">{k.label}</div>
                    <div className="font-mono text-lg font-bold mt-1 text-slate-100">{k.value}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5">{k.sub}</div>
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-2">
                {report.notes.map((n, i) => {
                  const st = NOTE_STYLE[n.level] || NOTE_STYLE.info;
                  const Icon = st.Icon;
                  return (
                    <div key={i} className={`text-[11.5px] leading-relaxed border-l-2 rounded-sm px-3 py-2 flex items-start gap-2 ${st.cls}`}>
                      <Icon size={14} className="mt-0.5 shrink-0" />
                      <span>{n.text}</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
