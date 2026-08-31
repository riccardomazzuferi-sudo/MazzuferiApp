import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "../api";
import { useI18n } from "../i18n";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "sonner";
import { Plus, Trash, PencilSimple } from "@phosphor-icons/react";

const SCHEMAS = {
  presses: {
    endpoint: "/presses",
    fields: [
      { k: "code", label: "Codice", type: "text" },
      { k: "name", label: "Nome", type: "text" },
      { k: "tonnage", label: "Tonnellaggio (T)", type: "number" },
      { k: "screw_diameter", label: "Diametro vite (mm)", type: "number" },
      { k: "max_stroke", label: "Corsa max vite (mm)", type: "number" },
      { k: "max_rpm", label: "RPM max vite", type: "number" },
      { k: "qmax", label: "Qmax (cm³/s)", type: "number" },
      { k: "max_injection_pressure", label: "Pressione iniezione max (bar)", type: "number" },
      { k: "notes", label: "Note", type: "textarea" },
    ],
    columns: ["code", "name", "tonnage", "screw_diameter", "max_rpm", "qmax"],
  },
  molds: {
    endpoint: "/molds",
    fields: [
      { k: "code", label: "Codice", type: "text" },
      { k: "name", label: "Nome", type: "text" },
      { k: "cavities", label: "N° cavità", type: "number" },
      { k: "flows_per_cavity", label: "Flussi per cavità", type: "number" },
      { k: "part_weight", label: "Peso pezzo (g)", type: "number" },
      { k: "part_thickness", label: "Spessore medio (mm)", type: "number" },
      { k: "ejection_thickness", label: "Spessore estrazione (mm)", type: "number" },
      { k: "runner_section", label: "Sezione runner (cm²)", type: "number" },
      { k: "projected_area", label: "Area proiettata (cm²)", type: "number" },
      { k: "notes", label: "Note", type: "textarea" },
    ],
    columns: ["code", "name", "cavities", "part_weight", "part_thickness"],
  },
  materials: {
    endpoint: "/materials",
    fields: [
      { k: "code", label: "Codice", type: "text" },
      { k: "name", label: "Nome", type: "text" },
      { k: "family", label: "Famiglia (PP/ABS/...)", type: "text" },
      { k: "material_type", label: "Tipo", type: "select", options: ["cristallino", "amorfo"] },
      { k: "density_liquid", label: "Densità liquida Dliq (g/cm³)", type: "number" },
      { k: "density_solid", label: "Densità solida Dsol (g/cm³)", type: "number" },
      { k: "density_apparent", label: "Densità apparente denA (g/cm³)", type: "number" },
      { k: "thermal_factor_a", label: "Coeff. termico A/ddiff", type: "number" },
      { k: "crystallization_velocity", label: "Vel. cristallizzazione (s/mm)", type: "number" },
      { k: "melt_temp_min", label: "T. massa min (°C)", type: "number" },
      { k: "melt_temp_recommended", label: "T. massa consigliata (°C)", type: "number" },
      { k: "melt_temp_max", label: "T. massa max (°C)", type: "number" },
      { k: "mold_temp_min", label: "T. stampo min (°C)", type: "number" },
      { k: "mold_temp_recommended", label: "T. stampo consigliata tspo (°C)", type: "number" },
      { k: "mold_temp_max", label: "T. stampo max (°C)", type: "number" },
      { k: "ejection_temp", label: "T. estrazione testr (°C)", type: "number" },
      { k: "shrink_long", label: "Ritiro long. (%)", type: "number" },
      { k: "shrink_transverse", label: "Ritiro trasv. (%)", type: "number" },
      { k: "max_peripheral_speed", label: "Vel. periferica max (m/s)", type: "number" },
      { k: "real_peripheral_speed", label: "Vel. periferica reale (m/s)", type: "number" },
      { k: "front_velocity", label: "Vel. avanzamento fronte velAf (cm/s)", type: "number" },
      { k: "pp1_min", label: "PP1 min (bar spec.)", type: "number" },
      { k: "pp1_max", label: "PP1 max (bar spec.)", type: "number" },
      { k: "dt_profile", label: "Delta T profilo dTp (°C)", type: "number" },
      { k: "heat_plastification", label: "Calore plastif. (kJ/kg)", type: "number" },
      { k: "screw_ingress_temp", label: "T. ingresso vite (°C)", type: "number" },
      { k: "dry_temp", label: "T. essiccazione (°C)", type: "number" },
      { k: "dry_time", label: "Tempo essiccazione (ore)", type: "number" },
      { k: "max_barrel_use_pct", label: "% max sfrutt. cilindro macMax", type: "number" },
      { k: "max_residence_time", label: "Tempo max permanenza tpmv (min)", type: "number" },
      { k: "notes", label: "Note", type: "textarea" },
    ],
    columns: ["code", "name", "family", "material_type", "density_solid", "melt_temp_recommended", "mold_temp_recommended"],
  },
};

const emptyFor = (schema) => Object.fromEntries(schema.fields.map((f) => [f.k, f.type === "number" ? 0 : ""]));

export default function Registries() {
  const { kind } = useParams();
  const { t } = useI18n();
  const schema = SCHEMAS[kind];
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyFor(schema));

  const load = async () => {
    const r = await api.get(schema.endpoint);
    setItems(r.data);
  };

  useEffect(() => { setForm(emptyFor(schema)); load(); /* eslint-disable-next-line */ }, [kind]);

  const openNew = () => { setEditing(null); setForm(emptyFor(schema)); setOpen(true); };
  const openEdit = (row) => { setEditing(row); setForm({ ...emptyFor(schema), ...row }); setOpen(true); };

  const save = async () => {
    const payload = { ...form };
    schema.fields.forEach((f) => { if (f.type === "number") payload[f.k] = Number(payload[f.k] || 0); });
    try {
      if (editing) await api.put(`${schema.endpoint}/${editing.id}`, payload);
      else await api.post(schema.endpoint, payload);
      toast.success("Salvato");
      setOpen(false);
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Errore");
    }
  };

  const remove = async (row) => {
    if (!window.confirm(`Eliminare ${row.name}?`)) return;
    await api.delete(`${schema.endpoint}/${row.id}`);
    toast.success("Eliminato");
    load();
  };

  const title = t(kind);

  return (
    <div className="p-8 max-w-7xl mx-auto" data-testid={`registry-${kind}`}>
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="overline">// {t("registries")}</div>
          <h1 className="text-4xl font-black tracking-tight mt-1">{title}</h1>
        </div>
        <Button onClick={openNew} data-testid="add-btn" className="bg-blue-600 hover:bg-blue-700 h-10 rounded-sm">
          <Plus size={16} className="mr-2" /> {t("addNew")}
        </Button>
      </div>

      <div className="flex gap-2 mb-6 mt-4">
        <Link to="/registries/presses" className={`px-3 py-1.5 rounded-sm text-xs border ${kind==="presses"?"bg-blue-600 border-blue-600 text-white":"border-slate-700 text-slate-400 hover:bg-slate-900"}`}>{t("presses")}</Link>
        <Link to="/registries/molds" className={`px-3 py-1.5 rounded-sm text-xs border ${kind==="molds"?"bg-blue-600 border-blue-600 text-white":"border-slate-700 text-slate-400 hover:bg-slate-900"}`}>{t("molds")}</Link>
        <Link to="/registries/materials" className={`px-3 py-1.5 rounded-sm text-xs border ${kind==="materials"?"bg-blue-600 border-blue-600 text-white":"border-slate-700 text-slate-400 hover:bg-slate-900"}`}>{t("materials")}</Link>
      </div>

      <div className="border border-slate-800 rounded-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-900 border-b border-slate-800">
            <tr>
              {schema.columns.map((c) => <th key={c} className="text-left px-4 py-3 overline">{c}</th>)}
              <th className="w-24"></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={schema.columns.length + 1} className="p-6 text-center text-slate-500">{t("noResults")}</td></tr>
            )}
            {items.map((r) => (
              <tr key={r.id} className="border-b border-slate-900 hover:bg-slate-900 transition-colors" data-testid={`row-${r.id}`}>
                {schema.columns.map((c) => (
                  <td key={c} className="px-4 py-3 font-mono text-xs">{String(r[c] ?? "")}</td>
                ))}
                <td className="px-4 py-3 text-right">
                  <button onClick={() => openEdit(r)} className="text-slate-400 hover:text-blue-400 mr-2" data-testid={`edit-${r.id}`}><PencilSimple size={16} /></button>
                  <button onClick={() => remove(r)} className="text-slate-400 hover:text-red-400" data-testid={`del-${r.id}`}><Trash size={16} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-slate-900 border-slate-800 max-w-2xl rounded-sm" data-testid="registry-dialog">
          <DialogHeader>
            <DialogTitle className="font-black">{editing ? t("edit") : t("addNew")} · {title}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4 max-h-[60vh] overflow-y-auto pr-2">
            {schema.fields.map((f) => (
              <div key={f.k} className={f.type === "textarea" ? "col-span-2" : ""}>
                <Label className="text-xs uppercase tracking-wider text-slate-400">{f.label}</Label>
                {f.type === "select" ? (
                  <Select value={form[f.k] || ""} onValueChange={(v) => setForm({ ...form, [f.k]: v })}>
                    <SelectTrigger className="bg-slate-950 border-slate-700 h-10 rounded-sm mt-1" data-testid={`field-${f.k}`}>
                      <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent className="bg-slate-900 border-slate-700">
                      {f.options.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : f.type === "textarea" ? (
                  <textarea rows={3} value={form[f.k] || ""} onChange={(e) => setForm({ ...form, [f.k]: e.target.value })}
                    data-testid={`field-${f.k}`}
                    className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-sm p-2 text-sm font-mono" />
                ) : (
                  <Input type={f.type} value={form[f.k] ?? ""} onChange={(e) => setForm({ ...form, [f.k]: e.target.value })}
                    data-testid={`field-${f.k}`}
                    className="bg-slate-950 border-slate-700 h-10 rounded-sm mt-1 font-mono" />
                )}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t("cancel")}</Button>
            <Button onClick={save} data-testid="save-btn" className="bg-blue-600 hover:bg-blue-700 rounded-sm">{t("save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
