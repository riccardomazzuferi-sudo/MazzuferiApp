import { useEffect, useMemo, useState, useRef } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
import { useAuth } from "../auth";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel,
} from "../components/ui/alert-dialog";
import { toast } from "sonner";
import { FilePdf, FloppyDisk, UploadSimple, Warning, ArrowRight, ArrowLeft, CheckCircle } from "@phosphor-icons/react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  DEFAULT_STATE, computeAll, parseSTL, parseSTEP, computeMeshMetrics, getSezVite,
  isMultiGruppo, nuovoGruppoVuoto, totaleCavitaGruppi,
} from "../lib/molding-calc";

// Legenda colori campi
const inputStyle = (kind) => {
  // yellow = manuale, blue = autofill/DB, orange = calcolato
  const base = "h-9 rounded-sm font-mono text-sm border px-2 outline-none w-full transition-colors";
  if (kind === "auto") return `${base} bg-sky-950/40 border-sky-700 text-sky-200 focus:border-sky-500`;
  if (kind === "calc") return `${base} bg-orange-950/40 border-orange-700 text-orange-200 font-bold`;
  return `${base} bg-amber-950/20 border-amber-700 text-slate-100 focus:border-amber-500`;
};

const Field = ({ label, unit, children, hint }) => (
  <div className="flex flex-col gap-1">
    <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</label>
    {children}
    {(unit || hint) && <span className="text-[9px] text-slate-500">{hint || unit}</span>}
  </div>
);

const NumInput = ({ value, onChange, kind = "manual", step = "any", readOnly, testid, placeholder }) => (
  <input
    type="number"
    step={step}
    value={value == null || Number.isNaN(value) ? "" : value}
    onChange={(e) => onChange?.(e.target.value === "" ? null : parseFloat(e.target.value))}
    readOnly={readOnly || kind === "calc"}
    placeholder={placeholder}
    data-testid={testid}
    className={inputStyle(kind)}
  />
);

const TxtInput = ({ value, onChange, testid, placeholder }) => (
  <input type="text" value={value || ""} onChange={(e) => onChange?.(e.target.value)}
    data-testid={testid} placeholder={placeholder} className={inputStyle("manual")} />
);

const fmt = (v, dec = 2) => (v != null && isFinite(v) ? Number(v).toFixed(dec) : "—");

// Etichette leggibili dei campi popolabili da import STL/STEP, usate nel dialogo di conferma
// prima di sovrascrivere valori già inseriti a mano (portato da CycleTime Pro)
const STL_FIELD_LABEL = {
  volPezzo: "Vol. pezzo", areaProiettata: "Area proiettata", lPerc: "Percorso riempimento",
  spPezzo: "Sp. pezzo medio", spPezzoMax: "Sp. Max pezzo", spSezSottile: "Sp. sezione sottile",
};

const Legend = () => (
  <div className="flex items-center gap-4 text-[10px] text-slate-500 py-2 border-b border-slate-800 mb-4">
    <span className="font-semibold uppercase tracking-wider">Legenda:</span>
    <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 bg-amber-950/40 border border-amber-700 rounded-sm" /> Da compilare</span>
    <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 bg-sky-950/40 border border-sky-700 rounded-sm" /> Autocompilato (DB / STL / tab precedenti)</span>
    <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 bg-orange-950/40 border border-orange-700 rounded-sm" /> Calcolato (formula)</span>
  </div>
);

export default function MoldingSheet() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [presses, setPresses] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [molds, setMolds] = useState([]);
  const [tab, setTab] = useState("stampo");
  const [S, setS] = useState(DEFAULT_STATE);
  const [stlInfo, setStlInfo] = useState("");
  // Origine dei campi popolabili da STL/STEP: 'stl' se scritti dall'ultimo import, assente/altro
  // se inseriti (o modificati) a mano dall'utente — usato per decidere se chiedere conferma
  // prima di un nuovo import che li sovrascriverebbe.
  const [fieldSrc, setFieldSrc] = useState({});
  // Import STL/STEP in attesa di conferma perché sovrascriverebbe campi inseriti a mano
  const [pendingStl, setPendingStl] = useState(null); // { fname, targets, conflicts }
  const fileRef = useRef();

  // Load DB
  useEffect(() => {
    (async () => {
      const [p, m, mo] = await Promise.all([api.get("/presses"), api.get("/materials"), api.get("/molds")]);
      setPresses(p.data); setMaterials(m.data); setMolds(mo.data);
      if (!S.operatore) setS((s) => ({ ...s, operatore: user?.full_name || "", dataProva: new Date().toISOString().slice(0, 10) }));
    })();
    // eslint-disable-next-line
  }, []);

  const materialsById = useMemo(() => Object.fromEntries(materials.map((m) => [m.id, m])), [materials]);
  const pressesById = useMemo(() => Object.fromEntries(presses.map((p) => [p.id, p])), [presses]);
  const amorfi = useMemo(() => materials.filter((m) => m.material_type === "amorfo"), [materials]);
  const cristallini = useMemo(() => materials.filter((m) => m.material_type === "cristallino"), [materials]);
  const mat = materialsById[S.materialeId];
  const press = pressesById[S.pressaId];

  // Autopopolamento parametri pressa quando selezionata
  useEffect(() => {
    if (!press) return;
    setS((s) => ({
      ...s,
      dvite: press.screw_diameter || s.dvite,
      nGiriMax: press.max_rpm || s.nGiriMax,
      qmaxPressa: press.qmax || s.qmaxPressa,
      pp1maxPressa: press.max_injection_pressure || s.pp1maxPressa,
      tonnellaggio: press.tonnage || s.tonnellaggio,
    }));
  }, [press]);

  // Autopopolamento stampo (se selezionato)
  const applyMold = (moldId) => {
    const m = molds.find((x) => x.id === moldId);
    if (!m) return;
    setS((s) => ({
      ...s,
      codice: m.code, descrizione: m.name,
      nCav: m.cavities || s.nCav, nFig: m.flows_per_cavity || 1,
      spPezzo: m.part_thickness ?? s.spPezzo, spPezzoMax: m.ejection_thickness ?? m.part_thickness ?? s.spPezzoMax,
      areaProiettata: m.projected_area ?? s.areaProiettata,
      volPezzo: (m.part_weight && mat?.density_solid) ? m.part_weight / mat.density_solid : s.volPezzo,
    }));
  };

  const C = useMemo(() => computeAll(S, materialsById), [S, materialsById]);

  const set = (k) => (v) => setS((s) => ({ ...s, [k]: v }));
  // Variante di `set` per i campi popolabili da STL/STEP: quando l'utente li modifica a mano
  // li marca come 'manual', così un successivo import chiede conferma prima di sovrascriverli.
  const setManual = (k) => (v) => {
    setFieldSrc((fs) => ({ ...fs, [k]: "manual" }));
    setS((s) => ({ ...s, [k]: v }));
  };

  const multiG = isMultiGruppo(S);

  // Multi-gruppo (stampi multi-impronta con figure diverse tra loro): portato da CycleTime Pro.
  // Con 0/1 gruppo l'app resta quella semplice di sempre; da 2 gruppi in su ogni "Figura N" ha
  // la propria geometria (cavità, spessore, volumi, area, percorso) e i calcoli di processo
  // aggregano i gruppi (vedi computeAll/getSpessoreRiferimento in molding-calc.js).
  const addGruppoFigura = () => {
    setS((s) => {
      // Il primo gruppo creato eredita le cavità correnti come punto di partenza; il secondo
      // parte vuoto (0 cavità) così la somma resta sempre visibile e corretta da subito.
      const gruppi = s.gruppi.length === 0
        ? [nuovoGruppoVuoto(parseInt(s.nCav) || 1), nuovoGruppoVuoto(0)]
        : [...s.gruppi, nuovoGruppoVuoto(0)];
      return { ...s, gruppi, gruppoTabAttivo: gruppi.length - 1 };
    });
  };

  const removeGruppoFigura = (idx) => {
    if (!window.confirm(`Rimuovere il gruppo Figura ${idx + 1}? I dati inseriti per questo gruppo andranno persi.`)) return;
    setS((s) => {
      let gruppi = s.gruppi.filter((_, i) => i !== idx);
      if (gruppi.length <= 1) gruppi = []; // torna al caso semplice se resta ≤1 gruppo
      const gruppoTabAttivo = s.gruppoTabAttivo >= gruppi.length ? Math.max(0, gruppi.length - 1) : s.gruppoTabAttivo;
      return { ...s, gruppi, gruppoTabAttivo };
    });
  };

  const setGruppoTab = (idx) => setS((s) => ({ ...s, gruppoTabAttivo: idx }));

  // Variante di `setManual` per i campi di un gruppo (Figura N)
  const setGruppoField = (idx, k) => (v) => {
    setFieldSrc((fs) => ({ ...fs, [`grp${idx}_${k}`]: "manual" }));
    setS((s) => ({ ...s, gruppi: s.gruppi.map((g, i) => (i === idx ? { ...g, [k]: v } : g)) }));
  };

  // Scrive i valori letti da STL/STEP (solo le chiavi non-null): nei campi top-level a gruppo
  // singolo, o nel gruppo attivo (Figura N) in multi-gruppo — e li marca come origine 'stl'.
  const writeStlTargets = (targets, gruppoIdx = null) => {
    if (gruppoIdx != null) {
      setS((s) => ({ ...s, gruppi: s.gruppi.map((g, i) => (i === gruppoIdx ? { ...g, ...targets } : g)) }));
      setFieldSrc((fs) => {
        const next = { ...fs };
        Object.keys(targets).forEach((k) => { next[`grp${gruppoIdx}_${k}`] = "stl"; });
        return next;
      });
    } else {
      setS((s) => ({ ...s, ...targets }));
      setFieldSrc((fs) => {
        const next = { ...fs };
        Object.keys(targets).forEach((k) => { next[k] = "stl"; });
        return next;
      });
    }
  };

  // STL / STEP import
  const onFile = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const ext = f.name.split(".").pop().toLowerCase();
    if (!["stl", "step", "stp"].includes(ext)) {
      toast.error("Formato non supportato: usa STL, STEP o STP");
      return;
    }
    const isStep = ext === "step" || ext === "stp";
    setStlInfo(isStep
      ? "⏳ Caricamento motore STEP (prima volta: qualche secondo)…"
      : "Lettura file STL in corso…");
    try {
      const buf = await f.arrayBuffer();
      const geom = isStep ? await parseSTEP(buf) : await parseSTL(buf);
      if (isStep) setStlInfo("⏳ Tassellazione STEP completata, calcolo metriche…");
      const m = computeMeshMetrics(geom);
      const gruppoIdx = multiG ? S.gruppoTabAttivo : null;

      // Campi che l'import potrebbe scrivere (solo quelli effettivamente stimati dalla mesh).
      // In multi-gruppo lo spessore di sezione sottile resta sempre globale/manuale (non è un
      // campo del gruppo), come in CycleTime Pro.
      const targets = {
        volPezzo: +m.volumeCm3.toFixed(2),
        areaProiettata: +m.areaProiettataCm2.toFixed(1),
        lPerc: +m.percorsoMax.toFixed(1),
        ...(m.spessoreMedio != null ? { spPezzo: +m.spessoreMedio.toFixed(2) } : {}),
        ...(m.spessoreMax != null ? { spPezzoMax: +m.spessoreMax.toFixed(2) } : {}),
        ...(!multiG && m.spessoreMin != null ? { spSezSottile: +m.spessoreMin.toFixed(2) } : {}),
      };

      // Conferma prima di sovrascrivere: un campo è "a rischio" se ha già un valore E non è
      // stato scritto dall'ultimo import STL/STEP (quindi è stato inserito o toccato a mano).
      const dest = gruppoIdx != null ? (S.gruppi[gruppoIdx] || {}) : S;
      const srcKey = (k) => (gruppoIdx != null ? `grp${gruppoIdx}_${k}` : k);
      const conflicts = Object.keys(targets).filter((k) => dest[k] != null && fieldSrc[srcKey(k)] !== "stl");
      if (conflicts.length) {
        setPendingStl({ fname: f.name, targets, conflicts, gruppoIdx });
      } else {
        writeStlTargets(targets, gruppoIdx);
      }

      const spInfo = m.spessoreMedio != null
        ? `sp medio ${m.spessoreMedio.toFixed(2)} mm (min ${m.spessoreMin.toFixed(2)} — max ${m.spessoreMax.toFixed(2)}, ${m.spCampioni} campioni)`
        : "spessore non stimabile (mesh non chiusa, o troppo pochi triangoli validi: verifica manualmente)";
      const destInfo = gruppoIdx != null ? ` — assegnato a Figura ${gruppoIdx + 1}` : "";
      setStlInfo(`✓ ${f.name} — ${m.nTriangoli.toLocaleString()} triangoli, Vol ${m.volumeCm3.toFixed(2)} cm³, area proiettata ${m.areaProiettataCm2.toFixed(1)} cm², ${spInfo}, percorso stimato ${m.percorsoMax.toFixed(1)} mm${destInfo}`);
      toast.success(`Geometria importata da ${ext.toUpperCase()}${conflicts.length ? " — conferma i campi da sostituire" : ""}`);
    } catch (err) {
      setStlInfo("⚠ Errore: " + err.message);
      toast.error("Errore lettura " + ext.toUpperCase());
    } finally {
      // consente di ri-caricare lo stesso file
      if (e.target) e.target.value = "";
    }
  };

  // Risoluzione del dialogo di conferma sovrascrittura import STL/STEP
  const resolvePendingStl = (confirmOverride) => {
    if (!pendingStl) return;
    const { targets, gruppoIdx } = pendingStl;
    if (confirmOverride) {
      writeStlTargets(targets, gruppoIdx);
    } else {
      // Mantiene i valori manuali esistenti, scrive solo i campi ancora vuoti
      const dest = gruppoIdx != null ? (S.gruppi[gruppoIdx] || {}) : S;
      const onlyEmpty = Object.fromEntries(Object.entries(targets).filter(([k]) => dest[k] == null));
      writeStlTargets(onlyEmpty, gruppoIdx);
    }
    setPendingStl(null);
  };

  const savedSheet = async () => {
    try {
      await api.post("/molding/save", {
        name: `${S.codice || "Scheda"} · ${mat?.code || ""} · ${new Date().toLocaleDateString()}`,
        payload: { S, C, materialName: mat?.name, pressName: press?.name },
      });
      toast.success("Scheda salvata");
    } catch (e) {
      toast.error("Errore salvataggio");
    }
  };

  const exportPdf = () => {
    if (!mat) { toast.error("Seleziona il materiale"); return; }
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    doc.setFont("helvetica", "bold"); doc.setFontSize(16);
    doc.text("SCHEDA STAMPAGGIO SCIENTIFICO", 14, 16);
    doc.setFontSize(9); doc.setFont("helvetica", "normal");
    doc.text(`${S.codice || "—"} · ${S.descrizione || ""} · Cliente: ${S.cliente || "—"} · N° prova: ${S.nProva}`, 14, 22);
    doc.text(`Data: ${S.dataProva || new Date().toLocaleDateString()} · Operatore: ${S.operatore}`, 14, 27);

    autoTable(doc, {
      startY: 32, theme: "grid", styles: { fontSize: 8 },
      head: [["Materiale", "Pressa", "Stampo"]],
      body: [[
        `${mat.code} — ${mat.name} (${mat.material_type})`,
        press ? `${press.code} — ${press.name} (${press.tonnage}T, vite Ø${press.screw_diameter}mm)` : "—",
        multiG
          ? `${S.nCav} cavità su ${S.gruppi.length} figure diverse · sp. di riferimento ${fmt(C.spRiferimento, 1)} mm (Figura ${C.gruppoCritico >= 0 ? C.gruppoCritico + 1 : "—"}) · peso stampata ${fmt(C.pStamp, 1)} g`
          : `${S.nCav} cavità · sp.medio ${fmt(S.spPezzo, 1)} mm · vol.pezzo ${fmt(S.volPezzo, 2)} cm³`,
      ]],
    });

    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 3, theme: "striped", styles: { fontSize: 7.5 },
      head: [["Parametro", "Valore", "U.M."]],
      body: [
        ["Peso stampata totale", fmt(C.pStamp, 1), "g"],
        ["Ø vite ottimale (teorico)", fmt(C.dOttimale, 2), "mm"],
        ["Range Ø vite commerciale", `${C.dMin ?? "-"} — ${C.dMax ?? "-"}`, "mm"],
        ["Sezione vite (Ø " + S.dvite + " mm)", fmt(C.sezVite, 3), "cm²"],
        ["Carica materiale CM", `${fmt(C.cmMm, 2)} / ${fmt(C.cmCm3, 2)}`, "mm / cm³"],
        ["Cuscino", `${fmt(S.cuscino, 1)} / ${fmt(C.cuscinoCm3, 2)}`, "mm / cm³"],
        ["QSCM (stop dosaggio)", `${fmt(C.qscm, 2)} / ${fmt(C.qscmCm3, 2)}`, "mm / cm³"],
        ["Q commutazione V/P", `${fmt(C.qcomm, 2)} / ${fmt(C.qcommCm3, 2)}`, "mm / cm³"],
        ["nD (CM/Ø vite)", fmt(C.nD, 2), "-"],
        ["Giri vite impostati", `${S.nRpm} (ideale ${fmt(C.nRpmIdeale, 0)})`, "rpm"],
        ["Vel. periferica", `${fmt(C.vperMs, 3)} m/s · ${fmt(C.vperMmin, 1)} m/min`, ""],
        ["Contropressione", `${S.contropressione} (spec. ${fmt(C.contropressioneSpec, 0)})`, "bar"],
        ["Decompressione", `${S.decompressione} mm / ${fmt(C.decompressioneCm3, 2)} cm³`, ""],
        ["T. massa stampaggio", fmt(C.taStampaggioEff, 0), "°C"],
        ["Volume stampata", fmt(C.volStampataCm3, 2), "cm³"],
        ["T. riempimento teorico", fmt(C.tRiempTeorico, 3), "s"],
        ["T. riempimento reale", fmt(S.tRiemp, 3), "s"],
        ["Qmax teorico", fmt(C.qmaxTeorico, 2), "cm³/s"],
        ["Vmax iniezione", fmt(C.vmaxMms, 2), "mm/s"],
        ["% Qmax su pressa", fmt(C.qmaxPerc, 1), "%"],
        ["Press. iniezione (idr / spec)", `${S.pressIniez} / ${fmt(C.pressIniezSpec, 0)}`, "bar"],
        ["PP1 (idr / spec)", `${S.pp1} / ${fmt(C.pp1Spec, 0)} · ${S.tPP1} s`, "bar / s"],
        ["PP2 (idr / spec)", `${S.pp2} / ${fmt(C.pp2Spec, 0)} · ${S.tPP2} s`, "bar / s"],
        ["Forza chiusura richiesta", `${fmt(C.forzaCalcT, 1)} t (${fmt(C.forzaPerc, 1)}% pressa)`, "t"],
        ["TMP teorico", fmt(C.tmpTeorico, 2), "s"],
        ["TMP economico", fmt(C.tmpEconomico, 2), "s"],
        ["TMP sezione sottile", fmt(C.tmpSezSottile, 2), "s"],
        ["TRr raffreddamento reale", fmt(C.tRaffReale, 2), "s"],
        ["T raffreddamento impostato", fmt(C.tRaff, 2), "s"],
        ["T. ciclo totale", fmt(C.tTotale, 2), "s"],
        ["T. permanenza teorica", fmt(C.tPermanenzaTeorica, 2), "min"],
        ["T. permanenza max materiale", fmt(C.tPermMax, 1), "min"],
      ],
    });

    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 3, theme: "grid", styles: { fontSize: 8 },
      head: [["Zona U (ugello)", "A", "B", "C", "D (tramoggia)"]],
      body: [[fmt(C.zonaU, 0), fmt(C.zonaA, 0), fmt(C.zonaB, 0), fmt(C.zonaC, 0), fmt(C.zonaD, 0)]],
    });

    if (C.permanenzaWarn) {
      autoTable(doc, {
        startY: doc.lastAutoTable.finalY + 3, theme: "plain", styles: { fontSize: 9, textColor: [180, 40, 20] },
        body: [["⚠ " + C.permanenzaWarn]],
      });
    }
    doc.save(`scheda_${S.codice || "senza-codice"}_${mat.code}.pdf`);
  };

  // ==== TAB navigation ====
  const tabs = [
    { id: "stampo", label: "1. Stampo & Materiale" },
    { id: "pressa", label: "2. Scelta Pressa" },
    { id: "iniezione", label: "3. Iniezione" },
    { id: "chiusura", label: "4. Apertura/Chiusura" },
    { id: "tempi", label: "5. Tempi Ciclo" },
  ];
  const nextTab = () => { const i = tabs.findIndex((x) => x.id === tab); if (i < tabs.length - 1) setTab(tabs[i + 1].id); };
  const prevTab = () => { const i = tabs.findIndex((x) => x.id === tab); if (i > 0) setTab(tabs[i - 1].id); };

  return (
    <div className="p-6 lg:p-8 max-w-[1400px] mx-auto" data-testid="sheet-page">
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="overline">// operatività</div>
          <h1 className="text-4xl font-black tracking-tight mt-1">{t("moldingSheet")}</h1>
          {S.codice && <div className="mt-2 text-sm text-slate-400">
            Scheda: <span className="text-slate-200 font-semibold">{S.codice}</span> · {S.descrizione} · N°prova {S.nProva}
          </div>}
        </div>
        <div className="flex gap-2">
          <Button onClick={savedSheet} data-testid="save-sheet-btn" variant="outline"
            className="h-10 rounded-sm border-slate-700 bg-slate-900 hover:bg-slate-800">
            <FloppyDisk size={16} className="mr-2" /> Salva
          </Button>
          <Button onClick={exportPdf} data-testid="pdf-btn" className="h-10 rounded-sm bg-blue-600 hover:bg-blue-700">
            <FilePdf size={16} className="mr-2" /> {t("exportPdf")}
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="bg-slate-900 border border-slate-800 rounded-sm h-auto p-1 mb-4 w-full justify-start overflow-x-auto">
          {tabs.map((x) => (
            <TabsTrigger key={x.id} value={x.id} data-testid={`tab-${x.id}`}
              className="rounded-sm data-[state=active]:bg-blue-600 data-[state=active]:text-white text-slate-400 px-4 py-2 text-xs font-semibold uppercase tracking-wider">
              {x.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* ============ TAB 1: STAMPO + MATERIALE ============ */}
        <TabsContent value="stampo">
          <Legend />

          <div className="border border-slate-800 bg-slate-900 rounded-sm mb-4">
            <div className="border-b border-slate-800 px-4 py-2 overline">Identificazione</div>
            <div className="p-4 grid md:grid-cols-4 gap-3">
              <Field label="Codice stampo"><TxtInput value={S.codice} onChange={set("codice")} testid="f-codice" /></Field>
              <Field label="Descrizione"><TxtInput value={S.descrizione} onChange={set("descrizione")} testid="f-descr" /></Field>
              <Field label="Cliente"><TxtInput value={S.cliente} onChange={set("cliente")} testid="f-cliente" /></Field>
              <Field label="N° prova"><NumInput value={S.nProva} onChange={set("nProva")} testid="f-nprova" /></Field>
              <Field label="Data prova"><input type="date" value={S.dataProva} onChange={(e) => set("dataProva")(e.target.value)} className={inputStyle("manual")} /></Field>
              <Field label="Operatore"><TxtInput value={S.operatore} onChange={set("operatore")} testid="f-oper" /></Field>
              <Field label="Note" hint=""><TxtInput value={S.note} onChange={set("note")} testid="f-note" /></Field>
              <Field label="Copia da stampo (anagrafica)">
                <select value="" onChange={(e) => applyMold(e.target.value)} className={inputStyle("auto")}>
                  <option value="">— seleziona per autocompilare —</option>
                  {molds.map((m) => <option key={m.id} value={m.id}>{`${m.code} — ${m.name}`}</option>)}
                </select>
              </Field>
            </div>
          </div>

          <div className="border border-slate-800 bg-slate-900 rounded-sm mb-4">
            <div className="border-b border-slate-800 px-4 py-2 overline">Materiale</div>
            <div className="p-4 grid md:grid-cols-4 gap-3">
              <Field label="Materiale">
                <select value={S.materialeId} onChange={(e) => set("materialeId")(e.target.value)} data-testid="f-materiale" className={inputStyle("manual")}>
                  <option value="">— seleziona —</option>
                  <optgroup label="Amorfi">
                    {amorfi.map((m) => (
                      <option key={m.id} value={m.id}>{`${m.code} — ${m.name}`}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Cristallini">
                    {cristallini.map((m) => (
                      <option key={m.id} value={m.id}>{`${m.code} — ${m.name}`}</option>
                    ))}
                  </optgroup>
                </select>
              </Field>
              <Field label="Tipologia" unit=""><NumInput value="" kind="auto" readOnly /><span className="-mt-8 pl-2 pointer-events-none font-mono text-sm text-sky-300">{mat ? (mat.material_type === "cristallino" ? "Cristallino" : "Amorfo") : "—"}</span></Field>
              <Field label="Densità solida Dsol" unit="[g/cm³]"><NumInput value={mat?.density_solid} kind="auto" readOnly /></Field>
              <Field label="Densità liquida Dliq" unit="[g/cm³]"><NumInput value={mat?.density_liquid} kind="auto" readOnly /></Field>
              <Field label="T. massa consigliata" unit="[°C]"><NumInput value={mat?.melt_temp_recommended} kind="auto" readOnly /></Field>
              <Field label="T. stampo tspo" unit="[°C]"><NumInput value={mat?.mold_temp_recommended} kind="auto" readOnly /></Field>
              <Field label="T. estrazione testr" unit="[°C]"><NumInput value={mat?.ejection_temp} kind="auto" readOnly /></Field>
              <Field label="Vel. avanz. fronte velAf" unit="[cm/s]"><NumInput value={mat?.front_velocity} kind="auto" readOnly /></Field>
              <Field label="Vel. crist. Vcrist" unit="[s/mm] (solo cristallini)"><NumInput value={mat?.crystallization_velocity} kind="auto" readOnly /></Field>
              <Field label="% max cilindro macMax" unit="[%]"><NumInput value={mat?.max_barrel_use_pct} kind="auto" readOnly /></Field>
              <Field label="Tpmv (permanenza max)" unit="[min]"><NumInput value={mat?.max_residence_time} kind="auto" readOnly /></Field>
              <Field label="PP1 min-max" unit="[bar spec]"><input value={mat ? `${mat.pp1_min || "—"} / ${mat.pp1_max || "—"}` : ""} readOnly className={inputStyle("auto")} /></Field>
            </div>
          </div>

          <div className="border border-slate-800 bg-slate-900 rounded-sm mb-4">
            <div className="border-b border-slate-800 px-4 py-2 overline flex items-center gap-2">
              Import geometria STL / STEP <span className="text-slate-500 font-normal normal-case text-[10px]">— legge volume, area proiettata, spessore (medio/min/max), percorso</span>
            </div>
            <div className="p-4">
              <div onClick={() => fileRef.current?.click()}
                className="border-2 border-dashed border-slate-700 hover:border-blue-500 hover:bg-slate-900/50 rounded-sm p-6 text-center cursor-pointer transition-colors"
                data-testid="stl-dropzone">
                <UploadSimple size={32} className="mx-auto text-slate-500 mb-2" />
                <div className="text-sm font-semibold text-slate-300">Clicca o trascina un file .STL / .STEP / .STP del pezzo</div>
                <div className="text-xs text-slate-500 mt-1">Mesh triangolata o STEP dal CAD; volume, area proiettata, spessore (medio + min sezione sottile + max) e percorso vengono compilati automaticamente</div>
              </div>
              <input ref={fileRef} type="file" accept=".stl,.STL,.step,.STEP,.stp,.STP" onChange={onFile} className="hidden" data-testid="stl-input" />
              {stlInfo && <div className="text-xs text-sky-300 mt-3 font-mono" data-testid="stl-info">{stlInfo}</div>}
            </div>
          </div>

          <div className="border border-slate-800 bg-slate-900 rounded-sm mb-4">
            <div className="border-b border-slate-800 px-4 py-2 overline flex items-center justify-between">
              <span>Dati geometrici stampo</span>
              {!multiG && (
                <button type="button" onClick={addGruppoFigura}
                  className="text-[10px] uppercase tracking-wider text-sky-400 hover:text-sky-300">
                  + Aggiungi figura diversa
                </button>
              )}
            </div>
            <div className="p-4 grid md:grid-cols-4 gap-3">
              <Field label="N° cavità"><NumInput value={S.nCav} onChange={set("nCav")} testid="f-ncav" /></Field>
              <Field label="N° figure"><NumInput value={S.nFig} onChange={set("nFig")} /></Field>
              <Field label="Sp. sezione sottile" unit="[mm] (per TMP min — resta globale anche con più figure)">
                <NumInput value={S.spSezSottile} onChange={setManual("spSezSottile")} kind={fieldSrc.spSezSottile === "stl" ? "auto" : "manual"} />
              </Field>
              {!multiG && <>
                <Field label="Sp. pezzo medio" unit="[mm]"><NumInput value={S.spPezzo} onChange={setManual("spPezzo")} kind={fieldSrc.spPezzo === "stl" ? "auto" : "manual"} testid="f-sp" /></Field>
                <Field label="Sp. Max pezzo (per raffredd.)" unit="[mm]"><NumInput value={S.spPezzoMax} onChange={setManual("spPezzoMax")} kind={fieldSrc.spPezzoMax === "stl" ? "auto" : "manual"} testid="f-spmax" /></Field>
                <Field label="Vol. pezzo" unit="[cm³]"><NumInput value={S.volPezzo} onChange={setManual("volPezzo")} kind={fieldSrc.volPezzo === "stl" ? "auto" : "manual"} testid="f-volp" /></Field>
                <Field label="Vol. sfrido" unit="[cm³]"><NumInput value={S.volSfrido} onChange={set("volSfrido")} /></Field>
                <Field label="Vol. stampata (calc)" unit="[cm³]"><NumInput value={C.volStampata} kind="calc" /></Field>
                <Field label="Peso pezzo (calc)" unit="[g]"><NumInput value={C.pesoPezzo} kind="calc" /></Field>
                <Field label="Peso sfrido (calc)" unit="[g]"><NumInput value={C.pesoSfrido} kind="calc" /></Field>
                <Field label="Area proiettata tot." unit="[cm²]"><NumInput value={S.areaProiettata} onChange={setManual("areaProiettata")} kind={fieldSrc.areaProiettata === "stl" ? "auto" : "manual"} testid="f-ap" /></Field>
                <Field label="Percorso riempimento" unit="[mm]"><NumInput value={S.lPerc} onChange={setManual("lPerc")} kind={fieldSrc.lPerc === "stl" ? "auto" : "manual"} testid="f-lperc" /></Field>
              </>}
              <Field label="Peso stampata totale (calc)" unit="[g] — su tutte le cavità"><NumInput value={C.pStamp} kind="calc" /></Field>
            </div>

            {multiG && (
              <div className="border-t border-slate-800 p-4">
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  {S.gruppi.map((g, i) => (
                    <button key={i} type="button" onClick={() => setGruppoTab(i)}
                      className={`px-3 py-1.5 rounded-sm text-xs font-semibold border transition-colors ${
                        S.gruppoTabAttivo === i
                          ? "bg-sky-600 border-sky-500 text-white"
                          : "bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-500"
                      }`}>
                      Figura {i + 1}{C.gruppoCritico === i ? " ⚠" : ""}
                    </button>
                  ))}
                  <button type="button" onClick={addGruppoFigura}
                    className="px-3 py-1.5 rounded-sm text-xs border border-dashed border-slate-700 text-slate-400 hover:border-sky-500 hover:text-sky-400">
                    + Aggiungi figura
                  </button>
                  <button type="button" onClick={() => removeGruppoFigura(S.gruppoTabAttivo)}
                    className="px-3 py-1.5 rounded-sm text-xs border border-slate-700 text-red-400 hover:border-red-500 ml-auto">
                    Rimuovi Figura {S.gruppoTabAttivo + 1}
                  </button>
                </div>

                {(() => {
                  const idx = S.gruppoTabAttivo;
                  const g = S.gruppi[idx] || nuovoGruppoVuoto(0);
                  const gk = (k) => fieldSrc[`grp${idx}_${k}`] === "stl" ? "auto" : "manual";
                  return (
                    <div className="grid md:grid-cols-4 gap-3">
                      <Field label={`N° cavità Figura ${idx + 1}`}>
                        <NumInput value={g.nCavGruppo} onChange={setGruppoField(idx, "nCavGruppo")} />
                      </Field>
                      <Field label="Sp. pezzo medio" unit="[mm]">
                        <NumInput value={g.spPezzo} onChange={setGruppoField(idx, "spPezzo")} kind={gk("spPezzo")} />
                      </Field>
                      <Field label="Sp. Max pezzo" unit="[mm]">
                        <NumInput value={g.spPezzoMax} onChange={setGruppoField(idx, "spPezzoMax")} kind={gk("spPezzoMax")} />
                      </Field>
                      <Field label="Vol. pezzo" unit="[cm³]">
                        <NumInput value={g.volPezzo} onChange={setGruppoField(idx, "volPezzo")} kind={gk("volPezzo")} />
                      </Field>
                      <Field label="Vol. sfrido" unit="[cm³]">
                        <NumInput value={g.volSfrido} onChange={setGruppoField(idx, "volSfrido")} />
                      </Field>
                      <Field label="Area proiettata (1 figura)" unit="[cm²]">
                        <NumInput value={g.areaProiettata} onChange={setGruppoField(idx, "areaProiettata")} kind={gk("areaProiettata")} />
                      </Field>
                      <Field label="Percorso riempimento" unit="[mm]">
                        <NumInput value={g.lPerc} onChange={setGruppoField(idx, "lPerc")} kind={gk("lPerc")} />
                      </Field>
                    </div>
                  );
                })()}

                <div className="note text-[11px] text-slate-400 mt-3 pt-3 border-t border-slate-800">
                  Cavità assegnate ai gruppi: <strong className={totaleCavitaGruppi(S) === (S.nCav || 0) ? "text-emerald-400" : "text-amber-400"}>
                    {totaleCavitaGruppi(S)}
                  </strong> — devono coincidere con N° cavità totale ({S.nCav || 0}).
                  {C.spRiferimento != null && (
                    <> Spessore di riferimento per i calcoli (raffreddamento/mantenimento): <strong className="text-sky-300">{C.spRiferimento.toFixed(1)} mm</strong>
                      {C.gruppoCritico >= 0 ? <> — il maggiore, dalla <strong>Figura {C.gruppoCritico + 1}</strong> (vincolo dominante)</> : ""}.</>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <Button onClick={nextTab} data-testid="next-1" className="h-10 rounded-sm bg-blue-600 hover:bg-blue-700">
              Prosegui: Pressa <ArrowRight size={16} className="ml-2" />
            </Button>
          </div>
        </TabsContent>

        {/* ============ TAB 2: PRESSA ============ */}
        <TabsContent value="pressa">
          <Legend />
          <div className="border border-slate-800 bg-slate-900 rounded-sm mb-4">
            <div className="border-b border-slate-800 px-4 py-2 overline">Selezione pressa dall'anagrafica</div>
            <div className="p-4 grid md:grid-cols-4 gap-3">
              <div className="md:col-span-2">
                <Field label="Pressa">
                  <select value={S.pressaId} onChange={(e) => set("pressaId")(e.target.value)} data-testid="f-pressa" className={inputStyle("manual")}>
                    <option value="">— seleziona per autocompilare —</option>
                    {presses.map((p) => <option key={p.id} value={p.id}>{`${p.code} — ${p.name} (${p.tonnage}T)`}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="Tonnellaggio" unit="[t]"><NumInput value={S.tonnellaggio} onChange={set("tonnellaggio")} kind={press ? "auto" : "manual"} /></Field>
              <Field label="Ø vite" unit="[mm]"><NumInput value={S.dvite} onChange={set("dvite")} kind={press ? "auto" : "manual"} testid="f-dvite" /></Field>
              <Field label="Sezione vite" unit="[cm²]"><NumInput value={C.sezVite} kind="calc" /></Field>
              <Field label="N° giri max" unit="[rpm]"><NumInput value={S.nGiriMax} onChange={set("nGiriMax")} kind={press ? "auto" : "manual"} /></Field>
              <Field label="Qmax pressa" unit="[cm³/s]"><NumInput value={S.qmaxPressa} onChange={set("qmaxPressa")} kind={press ? "auto" : "manual"} /></Field>
              <Field label="Pressione max" unit="[bar]"><NumInput value={S.pp1maxPressa} onChange={set("pp1maxPressa")} kind={press ? "auto" : "manual"} /></Field>
              <Field label="Rapporto Psi/Pi"><NumInput value={S.rapPsiPi} onChange={set("rapPsiPi")} /></Field>
              <Field label="Ø vite ottimale (calc)" unit="[mm] teorico"><NumInput value={C.dOttimale} kind="calc" /></Field>
              <Field label="Range Ø commerciale" unit="[mm]"><input value={C.dMin && C.dMax ? `${C.dMin} — ${C.dMax}` : "—"} readOnly className={inputStyle("calc")} /></Field>
              <Field label="Forza chiusura richiesta" unit="[t]"><NumInput value={C.forzaCalcT} kind="calc" /></Field>
              <Field label="% forza su pressa" unit="[%]"><NumInput value={C.forzaPerc} kind="calc" /></Field>
            </div>
          </div>

          <div className="flex justify-between">
            <Button onClick={prevTab} variant="outline" className="h-10 rounded-sm border-slate-700 bg-slate-900"><ArrowLeft size={16} className="mr-2" /> Indietro</Button>
            <Button onClick={nextTab} data-testid="next-2" className="h-10 rounded-sm bg-blue-600 hover:bg-blue-700">Prosegui: Iniezione <ArrowRight size={16} className="ml-2" /></Button>
          </div>
        </TabsContent>

        {/* ============ TAB 3: INIEZIONE ============ */}
        <TabsContent value="iniezione">
          <Legend />

          <div className="border border-slate-800 bg-slate-900 rounded-sm mb-4">
            <div className="border-b border-slate-800 px-4 py-2 overline">Plastificazione (dosaggio)</div>
            <div className="p-4 grid md:grid-cols-4 gap-3">
              <Field label="Cuscino" unit="[mm]"><NumInput value={S.cuscino} onChange={set("cuscino")} testid="f-cuscino" /></Field>
              <Field label="Cuscino" unit="[cm³] calc"><NumInput value={C.cuscinoCm3} kind="calc" /></Field>
              <Field label="Carica materiale CM" unit="[mm] calc"><NumInput value={C.cmMm} kind="calc" testid="c-cm" /></Field>
              <Field label="Carica materiale CM" unit="[cm³] calc"><NumInput value={C.cmCm3} kind="calc" /></Field>
              <Field label="QSCM (stop dosaggio)" unit="[mm] calc"><NumInput value={C.qscm} kind="calc" testid="c-qscm" /></Field>
              <Field label="QSCM" unit="[cm³] calc"><NumInput value={C.qscmCm3} kind="calc" /></Field>
              <Field label="Q commutazione V/P" unit="[mm] calc"><NumInput value={C.qcomm} kind="calc" testid="c-qcomm" /></Field>
              <Field label="Q commutazione" unit="[cm³] calc"><NumInput value={C.qcommCm3} kind="calc" /></Field>
              <Field label="nD (Carica/Ø vite)"><NumInput value={C.nD} kind="calc" /></Field>
              <Field label="Giri vite impostati" unit="[rpm]"><NumInput value={S.nRpm} onChange={set("nRpm")} /></Field>
              <Field label="Giri vite ideali (calc)" unit={`[rpm] per Vper=${mat?.max_peripheral_speed || "—"} m/s`}><NumInput value={C.nRpmIdeale} kind="calc" /></Field>
              <Field label="% giri su max"><NumInput value={C.vRotPerc} kind="calc" /></Field>
              <Field label="Vel. periferica" unit="[m/s] calc"><NumInput value={C.vperMs} kind="calc" step="0.001" /></Field>
              <Field label="Vel. periferica" unit="[m/min] calc"><NumInput value={C.vperMmin} kind="calc" /></Field>
              <Field label="Contropressione" unit="[bar idraulica]"><NumInput value={S.contropressione} onChange={set("contropressione")} /></Field>
              <Field label="Contropressione specifica" unit="[bar] calc"><NumInput value={C.contropressioneSpec} kind="calc" /></Field>
              <Field label="Decompressione" unit="[mm]"><NumInput value={S.decompressione} onChange={set("decompressione")} /></Field>
              <Field label="Decompressione" unit="[cm³] calc"><NumInput value={C.decompressioneCm3} kind="calc" /></Field>
              <Field label="TA stampaggio" unit="[°C] (vuoto=usa consigliata)"><NumInput value={S.taStampaggio} onChange={set("taStampaggio")} /></Field>
            </div>
          </div>

          <div className="border border-slate-800 bg-slate-900 rounded-sm mb-4">
            <div className="border-b border-slate-800 px-4 py-2 overline">Profilo temperatura barile (U/A/B/C/D)</div>
            <div className="p-4 grid grid-cols-5 gap-3">
              {[["U", "Ugello", C.zonaU], ["A", "Zona A", C.zonaA], ["B", "Zona B", C.zonaB], ["C", "Zona C", C.zonaC], ["D", "Tramoggia", C.zonaD]].map(([z, l, v]) => (
                <div key={z} className="border border-slate-800 bg-slate-950 rounded-sm p-3 text-center">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{z} · {l}</div>
                  <div className="font-mono text-2xl font-bold mt-1 text-amber-400">{fmt(v, 0)}<span className="text-xs text-slate-500 ml-1">°C</span></div>
                </div>
              ))}
            </div>
            <div className="px-4 pb-3 text-xs text-slate-500">Formula: DT = (nD − 2) · dTp (con dTp = {mat?.dt_profile ?? "—"} °C, nD clampato in [1, 3])</div>
          </div>

          <div className="border border-slate-800 bg-slate-900 rounded-sm mb-4">
            <div className="border-b border-slate-800 px-4 py-2 overline">Velocità di iniezione — profilo multi-step</div>
            <div className="p-4 grid md:grid-cols-4 gap-3">
              <Field label="T. riempimento (reale/prova)" unit="[s]"><NumInput value={S.tRiemp} onChange={set("tRiemp")} testid="f-triemp" /></Field>
              <Field label="T. riemp. teorico" unit="[s] calc"><NumInput value={C.tRiempTeorico} kind="calc" /></Field>
              <Field label="Qmax teorico" unit="[cm³/s] calc"><NumInput value={C.qmaxTeorico} kind="calc" testid="c-qmax" /></Field>
              <Field label="Vmax iniezione" unit="[mm/s] calc"><NumInput value={C.vmaxMms} kind="calc" testid="c-vmax" /></Field>
              {[1, 2, 3, 4].map((n) => (
                <div key={n} className="md:col-span-4 grid grid-cols-4 gap-3 border-t border-slate-800 pt-3">
                  <Field label={`V${n}`} unit="[mm/s]"><NumInput value={S[`vel${n}`]} onChange={set(`vel${n}`)} /></Field>
                  <Field label={`Q V${n}`} unit="[cm³/s] calc"><NumInput value={C[`qv${n}Cm3s`]} kind="calc" /></Field>
                  <Field label={`% V${n}`} unit="calc"><NumInput value={C[`vel${n}Perc`]} kind="calc" /></Field>
                  {n > 1 && <Field label={`Quota V${n}`} unit="[mm]"><NumInput value={S[`qVel${n}`]} onChange={set(`qVel${n}`)} /></Field>}
                </div>
              ))}
            </div>
          </div>

          <div className="border border-slate-800 bg-slate-900 rounded-sm mb-4">
            <div className="border-b border-slate-800 px-4 py-2 overline">Mantenimento</div>
            <div className="p-4 grid md:grid-cols-4 gap-3">
              <Field label="Press. iniezione (idr.)" unit="[bar]"><NumInput value={S.pressIniez} onChange={set("pressIniez")} /></Field>
              <Field label="Press. iniezione specifica" unit="[bar] calc"><NumInput value={C.pressIniezSpec} kind="calc" /></Field>
              <div />
              <div />
              <Field label="PP1 (idr.)" unit="[bar]"><NumInput value={S.pp1} onChange={set("pp1")} /></Field>
              <Field label="PP1 specifica" unit="[bar] calc"><NumInput value={C.pp1Spec} kind="calc" /></Field>
              <Field label="T. PP1" unit="[s]"><NumInput value={S.tPP1} onChange={set("tPP1")} /></Field>
              <div />
              <Field label="PP2 (idr.)" unit="[bar]"><NumInput value={S.pp2} onChange={set("pp2")} /></Field>
              <Field label="PP2 specifica" unit="[bar] calc"><NumInput value={C.pp2Spec} kind="calc" /></Field>
              <Field label="T. PP2" unit="[s]"><NumInput value={S.tPP2} onChange={set("tPP2")} /></Field>
              <Field label="Range PP1 vademecum" unit="[bar spec.]"><input value={mat ? `${mat.pp1_min ?? "—"} — ${mat.pp1_max ?? "—"}` : "—"} readOnly className={inputStyle("auto")} /></Field>
              <Field label="TMP teorico" unit="[s] calc"><NumInput value={C.tmpTeorico} kind="calc" /></Field>
              <Field label="TMP economico" unit="[s] calc"><NumInput value={C.tmpEconomico} kind="calc" /></Field>
              <Field label="TMP sezione sottile" unit="[s] calc"><NumInput value={C.tmpSezSottile} kind="calc" /></Field>
              <div />
            </div>
          </div>

          <div className="flex justify-between">
            <Button onClick={prevTab} variant="outline" className="h-10 rounded-sm border-slate-700 bg-slate-900"><ArrowLeft size={16} className="mr-2" /> Indietro</Button>
            <Button onClick={nextTab} className="h-10 rounded-sm bg-blue-600 hover:bg-blue-700">Prosegui: Apertura/Chiusura <ArrowRight size={16} className="ml-2" /></Button>
          </div>
        </TabsContent>

        {/* ============ TAB 4: APERTURA/CHIUSURA ============ */}
        <TabsContent value="chiusura">
          <Legend />
          <div className="border border-slate-800 bg-slate-900 rounded-sm mb-4">
            <div className="border-b border-slate-800 px-4 py-2 overline">Chiusura stampo</div>
            <div className="p-4 grid md:grid-cols-4 gap-3">
              <Field label="T. chiusura" unit="[s]"><NumInput value={S.tChiusura} onChange={set("tChiusura")} /></Field>
              <Field label="T. slitta avanti" unit="[s]"><NumInput value={S.tSlittaAvT} onChange={set("tSlittaAvT")} /></Field>
              <Field label="T. ritardo iniezione" unit="[s]"><NumInput value={S.tRitIniezT} onChange={set("tRitIniezT")} /></Field>
              <Field label="Press. chiusura" unit="[bar]"><NumInput value={S.pressChiusura} onChange={set("pressChiusura")} /></Field>
            </div>
          </div>

          <div className="border border-slate-800 bg-slate-900 rounded-sm mb-4">
            <div className="border-b border-slate-800 px-4 py-2 overline">Apertura e estrazione</div>
            <div className="p-4 grid md:grid-cols-4 gap-3">
              <Field label="T. apertura" unit="[s]"><NumInput value={S.tAperturaT} onChange={set("tAperturaT")} /></Field>
              <Field label="Quota apertura" unit="[mm]"><NumInput value={S.quotaApertura} onChange={set("quotaApertura")} /></Field>
              <Field label="Estrazione 1° colpo" unit="[s]"><NumInput value={S.tEstr1Colpo} onChange={set("tEstr1Colpo")} /></Field>
              <Field label="Estrazione 2° colpo" unit="[s]"><NumInput value={S.tEstr2Colpo} onChange={set("tEstr2Colpo")} /></Field>
              <Field label="Estrazione 3° colpo" unit="[s]"><NumInput value={S.tEstr3Colpo} onChange={set("tEstr3Colpo")} /></Field>
              <Field label="T. estrazione robot" unit="[s]"><NumInput value={S.tEstrRobot} onChange={set("tEstrRobot")} /></Field>
              <Field label="T. terza piastra" unit="[s]"><NumInput value={S.tTerzaPiastra} onChange={set("tTerzaPiastra")} /></Field>
              <Field label="T. spazzole" unit="[s]"><NumInput value={S.tEstrSpazzole} onChange={set("tEstrSpazzole")} /></Field>
            </div>
          </div>

          <div className="border border-slate-800 bg-slate-900 rounded-sm mb-4">
            <div className="border-b border-slate-800 px-4 py-2 overline">Movimenti ausiliari</div>
            <div className="p-4 grid md:grid-cols-4 gap-3">
              <Field label="T. radiale meccanico" unit="[s]"><NumInput value={S.tRadMecc} onChange={set("tRadMecc")} /></Field>
              <Field label="T. radiale idraulico" unit="[s]"><NumInput value={S.tRadIdraul} onChange={set("tRadIdraul")} /></Field>
              <Field label="T. radiale pneum." unit="[s]"><NumInput value={S.tRadPneum} onChange={set("tRadPneum")} /></Field>
              <Field label="T. soffi" unit="[s]"><NumInput value={S.tSoffi} onChange={set("tSoffi")} /></Field>
              <Field label="T. avvitamenti" unit="[s]"><NumInput value={S.tAvvitamenti} onChange={set("tAvvitamenti")} /></Field>
              <Field label="T. svitamenti" unit="[s]"><NumInput value={S.tSvitamenti} onChange={set("tSvitamenti")} /></Field>
              <Field label="T. carica materiale" unit="[s]"><NumInput value={S.tCarMat} onChange={set("tCarMat")} /></Field>
              <Field label="T. risucchio" unit="[s]"><NumInput value={S.tRisucchio} onChange={set("tRisucchio")} /></Field>
            </div>
            <div className="p-4 pt-0">
              <div className="border border-orange-800 bg-orange-950/30 rounded-sm p-3">
                <div className="overline text-orange-400">T. interciclo (somma calcolata)</div>
                <div className="font-mono text-2xl font-bold text-orange-300 mt-1">{fmt(C.tInterciclo, 2)} <span className="text-sm text-slate-500">s</span></div>
              </div>
            </div>
          </div>

          <div className="flex justify-between">
            <Button onClick={prevTab} variant="outline" className="h-10 rounded-sm border-slate-700 bg-slate-900"><ArrowLeft size={16} className="mr-2" /> Indietro</Button>
            <Button onClick={nextTab} className="h-10 rounded-sm bg-blue-600 hover:bg-blue-700">Prosegui: Tempi Ciclo <ArrowRight size={16} className="ml-2" /></Button>
          </div>
        </TabsContent>

        {/* ============ TAB 5: TEMPI CICLO — RIEPILOGO ============ */}
        <TabsContent value="tempi">
          {C.permanenzaWarn && (
            <div className="mb-4 border border-amber-700 bg-amber-950/40 rounded-sm p-4 flex items-start gap-3">
              <Warning size={20} className="text-amber-400 shrink-0 mt-0.5" />
              <div className="text-sm text-amber-200">{C.permanenzaWarn}</div>
            </div>
          )}

          <div className="border border-slate-800 bg-slate-900 rounded-sm mb-4">
            <div className="border-b border-slate-800 px-4 py-2 overline">Scomposizione tempo ciclo</div>
            <div className="p-4">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-800">
                  <tr>
                    <th className="text-left overline py-2 px-2">Fase</th>
                    <th className="text-right overline py-2 px-2">Tempo (s)</th>
                    <th className="text-right overline py-2 px-2">%</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["T. chiusura", S.tChiusura],
                    ["T. slitta avanti", S.tSlittaAvT],
                    ["T. ritardo iniezione", S.tRitIniezT],
                    ["T. riempimento (T.riemp)", S.tRiempT],
                    ["TMP (mantenimento)", C.tmp],
                    ["T. raffreddamento (Traff)", C.tRaff],
                    ["T. carica materiale", S.tCarMat],
                    ["T. risucchio", S.tRisucchio],
                    ["T. apertura", S.tAperturaT],
                    ["T. interciclo (estrazione + ausiliari)", C.tInterciclo],
                  ].map(([lbl, val]) => (
                    <tr key={lbl} className="border-b border-slate-900 hover:bg-slate-800/50">
                      <td className="py-2 px-2 text-slate-300">{lbl}</td>
                      <td className="py-2 px-2 text-right font-mono text-slate-200">{fmt(val, 2)}</td>
                      <td className="py-2 px-2 text-right font-mono text-slate-500">{C.tTotale ? fmt(((val || 0) / C.tTotale) * 100, 1) : "—"}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-blue-700 bg-blue-950/30">
                    <td className="py-3 px-2 font-bold text-blue-300">T. CICLO TOTALE</td>
                    <td className="py-3 px-2 text-right font-mono font-bold text-2xl text-blue-300" data-testid="t-ciclo">{fmt(C.tTotale, 2)}</td>
                    <td className="py-3 px-2 text-right font-mono text-blue-400">100%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-4 mb-4">
            <div className="border border-slate-800 bg-slate-900 rounded-sm p-4">
              <div className="overline">T. permanenza teorica</div>
              <div className="font-mono text-3xl font-bold text-slate-100 mt-2">{fmt(C.tPermanenzaTeorica, 2)} <span className="text-sm text-slate-500">min</span></div>
              <div className="text-xs text-slate-500 mt-2">= T.ciclo/60 × 100/macMax (macMax = {mat?.max_barrel_use_pct ?? "—"}%)</div>
            </div>
            <div className="border border-slate-800 bg-slate-900 rounded-sm p-4">
              <div className="overline">T. permanenza reale</div>
              <div className="font-mono text-3xl font-bold text-slate-100 mt-2">{fmt(C.tPermanenzaReale, 2)} <span className="text-sm text-slate-500">min</span></div>
              <div className="mt-2">
                <Field label="T. ciclo reale misurato" unit="[s]">
                  <NumInput value={S.tCicloReale} onChange={set("tCicloReale")} />
                </Field>
              </div>
            </div>
            <div className={`border rounded-sm p-4 ${C.permanenzaWarn ? "border-amber-700 bg-amber-950/30" : "border-emerald-700 bg-emerald-950/30"}`}>
              <div className="overline">T. massimo permanenza (Tpmv)</div>
              <div className="font-mono text-3xl font-bold mt-2 text-slate-100">{fmt(C.tPermMax, 1)} <span className="text-sm text-slate-500">min</span></div>
              <div className="text-xs mt-2 flex items-center gap-1">
                {C.permanenzaWarn ? (
                  <><Warning size={14} className="text-amber-400" /> <span className="text-amber-300">Rischio degrado</span></>
                ) : (
                  <><CheckCircle size={14} className="text-emerald-400" /> <span className="text-emerald-300">Permanenza entro limite</span></>
                )}
              </div>
            </div>
          </div>

          <div className="border border-slate-800 bg-slate-900 rounded-sm mb-4">
            <div className="border-b border-slate-800 px-4 py-2 overline">Riepilogo parametri chiave</div>
            <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                ["Peso stampata", C.pStamp, "g"], ["Ø vite ottimale", C.dOttimale, "mm"],
                ["Range Ø commerciale", C.dMin && C.dMax ? `${C.dMin}—${C.dMax}` : "—", "mm"],
                ["CM", C.cmMm, "mm"], ["QSCM", C.qscm, "mm"], ["Q comm.", C.qcomm, "mm"],
                ["Qmax teorico", C.qmaxTeorico, "cm³/s"], ["Vmax iniezione", C.vmaxMms, "mm/s"],
                ["Forza chiusura", C.forzaCalcT, "t"], ["TMP", C.tmp, "s"],
                ["TRr", C.tRaffReale, "s"], ["TA stampaggio", C.taStampaggioEff, "°C"],
              ].map(([lbl, val, unit]) => (
                <div key={lbl} className="border border-slate-800 bg-slate-950 rounded-sm p-3">
                  <div className="overline text-[10px]">{lbl}</div>
                  <div className="font-mono text-lg font-bold mt-1">{typeof val === "string" ? val : fmt(val, 2)} <span className="text-xs text-slate-500">{unit}</span></div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-between">
            <Button onClick={prevTab} variant="outline" className="h-10 rounded-sm border-slate-700 bg-slate-900"><ArrowLeft size={16} className="mr-2" /> Indietro</Button>
            <div className="flex gap-2">
              <Button onClick={savedSheet} variant="outline" className="h-10 rounded-sm border-slate-700 bg-slate-900"><FloppyDisk size={16} className="mr-2" /> Salva scheda</Button>
              <Button onClick={exportPdf} className="h-10 rounded-sm bg-blue-600 hover:bg-blue-700"><FilePdf size={16} className="mr-2" /> Esporta PDF</Button>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <AlertDialog open={!!pendingStl} onOpenChange={(open) => { if (!open) setPendingStl(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sostituire i valori inseriti a mano?</AlertDialogTitle>
            <AlertDialogDescription>
              Hai già inserito a mano: {pendingStl?.conflicts.map((k) => STL_FIELD_LABEL[k] || k).join(", ")}
              {pendingStl?.gruppoIdx != null ? ` (Figura ${pendingStl.gruppoIdx + 1})` : ""}.
              Vuoi sostituirli con i valori letti dal file {pendingStl?.fname}?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => resolvePendingStl(false)}>No, mantieni i miei valori</AlertDialogCancel>
            <AlertDialogAction onClick={() => resolvePendingStl(true)}>Sì, sostituisci</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
