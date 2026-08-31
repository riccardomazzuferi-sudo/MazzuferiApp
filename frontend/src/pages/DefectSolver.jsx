import { useEffect, useState } from "react";
import { api, API } from "../api";
import { useI18n } from "../i18n";
import { useAuth } from "../auth";
import { Button } from "../components/ui/button";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectGroup, SelectLabel } from "../components/ui/select";
import { toast } from "sonner";
import { Sparkle, ListChecks, ClockCounterClockwise, FloppyDisk, Warning, CheckCircle } from "@phosphor-icons/react";
import DOMPurify from "dompurify";

const renderMarkdown = (md) => {
  // very small MD renderer for headings/lists/bold
  let html = md
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const lines = html.split("\n");
  const out = [];
  let inUL = false, inOL = false;
  lines.forEach((l) => {
    if (/^\d+\.\s/.test(l)) {
      if (!inOL) { out.push("<ol>"); inOL = true; }
      out.push(`<li>${l.replace(/^\d+\.\s/, "")}</li>`);
    } else if (/^-\s/.test(l)) {
      if (!inUL) { out.push("<ul>"); inUL = true; }
      out.push(`<li>${l.replace(/^-\s/, "")}</li>`);
    } else {
      if (inUL) { out.push("</ul>"); inUL = false; }
      if (inOL) { out.push("</ol>"); inOL = false; }
      if (l.trim()) out.push(`<p>${l}</p>`);
    }
  });
  if (inUL) out.push("</ul>");
  if (inOL) out.push("</ol>");
  return out.join("");
};

export default function DefectSolver() {
  const { t, lang } = useI18n();
  const { user } = useAuth();
  const [defects, setDefects] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [presses, setPresses] = useState([]);
  const [molds, setMolds] = useState([]);

  const [defectId, setDefectId] = useState("");
  const [materialId, setMaterialId] = useState("");
  const [pressId, setPressId] = useState("");
  const [moldId, setMoldId] = useState("");
  const [description, setDescription] = useState("");

  const [history, setHistory] = useState([]);
  const [aiText, setAiText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);

  const [solutionApplied, setSolutionApplied] = useState("");
  const [solved, setSolved] = useState(true);

  useEffect(() => {
    (async () => {
      const [d, m, p, mo] = await Promise.all([
        api.get("/defects"), api.get("/materials"), api.get("/presses"), api.get("/molds"),
      ]);
      setDefects(d.data); setMaterials(m.data); setPresses(p.data); setMolds(mo.data);
    })();
  }, []);

  useEffect(() => {
    if (!defectId) { setHistory([]); return; }
    api.get("/problems", { params: { defect_id: defectId } }).then((r) => setHistory(r.data.slice(0, 20)));
  }, [defectId]);

  const currentDefect = defects.find((d) => d.id === defectId);

  // Raggruppa i difetti per categoria (dal manuale) mantenendo l'ordine di arrivo dal backend;
  // i difetti senza categoria (dati storici) finiscono in un gruppo residuo.
  const defectGroups = defects.reduce((acc, d) => {
    const cat = d.category || (lang === "en" ? "Other" : "Altro");
    if (!acc.has(cat)) acc.set(cat, []);
    acc.get(cat).push(d);
    return acc;
  }, new Map());

  const runAI = async () => {
    if (!defectId || !description.trim()) {
      toast.error("Seleziona un difetto e descrivi il problema");
      return;
    }
    setAiText(""); setAiBusy(true);
    try {
      const token = localStorage.getItem("mold_token");
      const res = await fetch(`${API}/ai/resolve-defect`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          defect_id: defectId, description, material_id: materialId || null,
          press_id: pressId || null, mold_id: moldId || null, language: lang,
        }),
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        setAiText((prev) => prev + dec.decode(value));
      }
    } catch (e) {
      toast.error("Errore AI");
    } finally { setAiBusy(false); }
  };

  const saveIntervention = async () => {
    if (!defectId || !description || !solutionApplied) {
      toast.error("Compila difetto, descrizione e soluzione applicata");
      return;
    }
    await api.post("/problems", {
      defect_id: defectId, defect_name: currentDefect?.name_it || "",
      press_id: pressId || null, press_name: presses.find(p=>p.id===pressId)?.name || null,
      mold_id: moldId || null, mold_name: molds.find(m=>m.id===moldId)?.name || null,
      material_id: materialId || null, material_name: materials.find(m=>m.id===materialId)?.name || null,
      description, solution_applied: solutionApplied, solved, operator_name: user.full_name,
    });
    toast.success("Intervento registrato");
    setDescription(""); setSolutionApplied(""); setAiText("");
    // reload history
    api.get("/problems", { params: { defect_id: defectId } }).then((r) => setHistory(r.data.slice(0, 20)));
  };

  return (
    <div className="p-8 max-w-7xl mx-auto" data-testid="solver-page">
      <div className="mb-6">
        <div className="overline">// operatività</div>
        <h1 className="text-4xl font-black tracking-tight mt-1">{t("problemSolver")}</h1>
      </div>

      {/* Inputs */}
      <div className="border border-slate-800 bg-slate-900 rounded-sm p-6 mb-6">
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <Label className="text-xs uppercase tracking-wider text-slate-400">{t("selectDefect")} *</Label>
            <Select value={defectId} onValueChange={setDefectId}>
              <SelectTrigger className="bg-slate-950 border-slate-700 h-10 rounded-sm mt-1" data-testid="select-defect">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent className="bg-slate-900 border-slate-700">
                {[...defectGroups.entries()].map(([cat, items]) => (
                  <SelectGroup key={cat}>
                    <SelectLabel className="text-slate-500">{cat}</SelectLabel>
                    {items.map((d) => <SelectItem key={d.id} value={d.id}>{d.code} — {d.name_it}</SelectItem>)}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-slate-400">{t("selectMaterial")}</Label>
            <Select value={materialId} onValueChange={setMaterialId}>
              <SelectTrigger className="bg-slate-950 border-slate-700 h-10 rounded-sm mt-1" data-testid="select-material">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent className="bg-slate-900 border-slate-700">
                {materials.map((m) => <SelectItem key={m.id} value={m.id}>{m.code} — {m.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-slate-400">{t("selectPress")}</Label>
            <Select value={pressId} onValueChange={setPressId}>
              <SelectTrigger className="bg-slate-950 border-slate-700 h-10 rounded-sm mt-1" data-testid="select-press">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent className="bg-slate-900 border-slate-700">
                {presses.map((p) => <SelectItem key={p.id} value={p.id}>{p.code} — {p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-slate-400">{t("selectMold")}</Label>
            <Select value={moldId} onValueChange={setMoldId}>
              <SelectTrigger className="bg-slate-950 border-slate-700 h-10 rounded-sm mt-1" data-testid="select-mold">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent className="bg-slate-900 border-slate-700">
                {molds.map((m) => <SelectItem key={m.id} value={m.id}>{m.code} — {m.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="mt-4">
          <Label className="text-xs uppercase tracking-wider text-slate-400">{t("describeProblem")} *</Label>
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)}
            data-testid="description-input"
            placeholder="Es. bave persistenti sul lato mobile in cavità 3 e 5, iniziato a metà turno..."
            className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-sm p-3 text-sm font-mono focus:border-blue-500 outline-none" />
        </div>
      </div>

      {/* Three columns of solutions */}
      <div className="grid lg:grid-cols-3 gap-4 mb-6">
        {/* Standard */}
        <div className="border border-slate-800 bg-slate-900 rounded-sm p-5 min-h-[300px]">
          <div className="flex items-center gap-2 mb-4">
            <ListChecks size={18} className="text-blue-400" />
            <h3 className="font-bold text-sm uppercase tracking-wider">{t("standardSolutions")}</h3>
          </div>
          {!currentDefect && <div className="text-sm text-slate-500">{t("selectDefect")}…</div>}
          {currentDefect && (
            <ul className="space-y-2 text-sm">
              {currentDefect.standard_solutions.map((s, i) => (
                <li key={`${currentDefect.code}-sol-${i}`} className="flex gap-2 text-slate-300">
                  <span className="font-mono text-blue-400 text-xs mt-0.5">{String(i+1).padStart(2,"0")}</span>
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Historical */}
        <div className="border border-slate-800 bg-slate-900 rounded-sm p-5 min-h-[300px]">
          <div className="flex items-center gap-2 mb-4">
            <ClockCounterClockwise size={18} className="text-amber-400" />
            <h3 className="font-bold text-sm uppercase tracking-wider">{t("historicalSolutions")}</h3>
            <span className="ml-auto text-xs text-slate-500 font-mono">{history.length}</span>
          </div>
          {!currentDefect && <div className="text-sm text-slate-500">{t("selectDefect")}…</div>}
          {currentDefect && history.length === 0 && <div className="text-sm text-slate-500">{t("noResults")}</div>}
          <div className="space-y-3 max-h-[400px] overflow-y-auto">
            {history.map((h) => (
              <div key={h.id} className="border border-slate-800 rounded-sm p-3 text-xs">
                <div className="flex items-center gap-2 text-slate-500 mb-1">
                  <span className="font-mono">{new Date(h.created_at).toLocaleDateString()}</span>
                  {h.solved ? <CheckCircle size={12} className="text-emerald-400" /> : <Warning size={12} className="text-amber-400" />}
                  <span className="text-slate-400">{h.material_name || "—"}</span>
                </div>
                <div className="text-slate-300 mb-1"><strong className="text-slate-400">Prob:</strong> {h.description}</div>
                <div className="text-slate-300"><strong className="text-blue-400">Sol:</strong> {h.solution_applied}</div>
              </div>
            ))}
          </div>
        </div>

        {/* AI */}
        <div className="border border-violet-900 bg-violet-950/20 rounded-sm p-5 min-h-[300px]">
          <div className="flex items-center gap-2 mb-4">
            <Sparkle size={18} weight="fill" className="text-violet-400" />
            <h3 className="font-bold text-sm uppercase tracking-wider text-violet-300">{t("aiSolutions")}</h3>
            <Button size="sm" onClick={runAI} disabled={aiBusy || !defectId} data-testid="ai-btn"
              className="ml-auto h-7 rounded-sm bg-violet-600 hover:bg-violet-700 text-xs">
              {aiBusy ? "…" : t("generateAi")}
            </Button>
          </div>
          {!aiText && !aiBusy && <div className="text-sm text-slate-500">Compila i campi e premi &quot;{t("generateAi")}&quot;</div>}
          {aiBusy && !aiText && <div className="text-sm text-violet-400 animate-pulse">Claude sta analizzando…</div>}
          {aiText && <div className="ai-content text-sm" data-testid="ai-content"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(renderMarkdown(aiText), { ALLOWED_TAGS: ["h2","p","ul","ol","li","strong","em","br"], ALLOWED_ATTR: [] }) }} />}
        </div>
      </div>

      {/* Record intervention */}
      <div className="border border-slate-800 bg-slate-900 rounded-sm p-6">
        <h3 className="font-bold text-sm uppercase tracking-wider mb-4">{t("record")}</h3>
        <div className="grid md:grid-cols-3 gap-4">
          <div className="md:col-span-2">
            <Label className="text-xs uppercase tracking-wider text-slate-400">{t("solutionApplied")} *</Label>
            <textarea rows={3} value={solutionApplied} onChange={(e) => setSolutionApplied(e.target.value)}
              data-testid="solution-input"
              className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-sm p-3 text-sm font-mono focus:border-blue-500 outline-none" />
          </div>
          <div className="flex flex-col">
            <Label className="text-xs uppercase tracking-wider text-slate-400">Esito</Label>
            <div className="flex gap-2 mt-1">
              <button onClick={() => setSolved(true)} data-testid="solved-yes"
                className={`flex-1 h-10 rounded-sm border text-sm ${solved?"bg-emerald-600 border-emerald-600":"border-slate-700 text-slate-400 hover:bg-slate-800"}`}>
                {t("solved")}
              </button>
              <button onClick={() => setSolved(false)} data-testid="solved-no"
                className={`flex-1 h-10 rounded-sm border text-sm ${!solved?"bg-amber-600 border-amber-600":"border-slate-700 text-slate-400 hover:bg-slate-800"}`}>
                {t("notSolved")}
              </button>
            </div>
            <Button onClick={saveIntervention} data-testid="save-intervention-btn"
              className="mt-auto h-10 rounded-sm bg-blue-600 hover:bg-blue-700">
              <FloppyDisk size={16} className="mr-2" /> {t("save")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
