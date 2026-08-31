import { useEffect, useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { CheckCircle, Warning, Trash } from "@phosphor-icons/react";
import { toast } from "sonner";

export default function History() {
  const { t } = useI18n();
  const [items, setItems] = useState([]);
  const [defects, setDefects] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [fDefect, setFDefect] = useState("all");
  const [fMaterial, setFMaterial] = useState("all");

  const load = async () => {
    const params = {};
    if (fDefect !== "all") params.defect_id = fDefect;
    if (fMaterial !== "all") params.material_id = fMaterial;
    const r = await api.get("/problems", { params });
    setItems(r.data);
  };

  useEffect(() => {
    (async () => {
      const [d, m] = await Promise.all([api.get("/defects"), api.get("/materials")]);
      setDefects(d.data); setMaterials(m.data);
    })();
  }, []);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [fDefect, fMaterial]);

  const remove = async (id) => {
    if (!window.confirm("Eliminare intervento?")) return;
    await api.delete(`/problems/${id}`);
    toast.success("Eliminato");
    load();
  };

  return (
    <div className="p-8 max-w-7xl mx-auto" data-testid="history-page">
      <div className="mb-6">
        <div className="overline">// operatività</div>
        <h1 className="text-4xl font-black tracking-tight mt-1">{t("history")}</h1>
      </div>

      <div className="flex gap-3 mb-4">
        <div className="w-64">
          <Select value={fDefect} onValueChange={setFDefect}>
            <SelectTrigger className="bg-slate-950 border-slate-700 h-10 rounded-sm"><SelectValue /></SelectTrigger>
            <SelectContent className="bg-slate-900 border-slate-700">
              <SelectItem value="all">Tutti i difetti</SelectItem>
              {defects.map((d) => <SelectItem key={d.id} value={d.id}>{d.code} — {d.name_it}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="w-64">
          <Select value={fMaterial} onValueChange={setFMaterial}>
            <SelectTrigger className="bg-slate-950 border-slate-700 h-10 rounded-sm"><SelectValue /></SelectTrigger>
            <SelectContent className="bg-slate-900 border-slate-700">
              <SelectItem value="all">Tutti i materiali</SelectItem>
              {materials.map((m) => <SelectItem key={m.id} value={m.id}>{m.code} — {m.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="border border-slate-800 rounded-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-900 border-b border-slate-800">
            <tr>
              <th className="text-left px-4 py-3 overline">{t("date")}</th>
              <th className="text-left px-4 py-3 overline">{t("defect")}</th>
              <th className="text-left px-4 py-3 overline">{t("material")}</th>
              <th className="text-left px-4 py-3 overline">{t("mold")}</th>
              <th className="text-left px-4 py-3 overline">{t("press")}</th>
              <th className="text-left px-4 py-3 overline">Descrizione</th>
              <th className="text-left px-4 py-3 overline">{t("solution")}</th>
              <th className="text-left px-4 py-3 overline">{t("operator")}</th>
              <th className="text-left px-4 py-3 overline">Esito</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={10} className="p-6 text-center text-slate-500">{t("noResults")}</td></tr>
            )}
            {items.map((r) => (
              <tr key={r.id} className="border-b border-slate-900 hover:bg-slate-900 transition-colors align-top">
                <td className="px-4 py-3 font-mono text-xs text-slate-400 whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</td>
                <td className="px-4 py-3">{r.defect_name}</td>
                <td className="px-4 py-3 text-slate-400">{r.material_name || "—"}</td>
                <td className="px-4 py-3 text-slate-400">{r.mold_name || "—"}</td>
                <td className="px-4 py-3 text-slate-400">{r.press_name || "—"}</td>
                <td className="px-4 py-3 text-slate-300 max-w-xs">{r.description}</td>
                <td className="px-4 py-3 text-slate-300 max-w-xs">{r.solution_applied}</td>
                <td className="px-4 py-3 text-slate-400 whitespace-nowrap">{r.operator_name}</td>
                <td className="px-4 py-3">
                  {r.solved
                    ? <span className="inline-flex items-center gap-1 text-emerald-400 text-xs"><CheckCircle size={12} /> OK</span>
                    : <span className="inline-flex items-center gap-1 text-amber-400 text-xs"><Warning size={12} /> KO</span>}
                </td>
                <td className="px-4 py-3">
                  <button onClick={() => remove(r.id)} className="text-slate-500 hover:text-red-400"><Trash size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
