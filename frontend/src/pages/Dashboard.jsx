import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { useI18n } from "../i18n";
import { Wrench, ChartLine, ClockCounterClockwise, Books, Warning, CheckCircle } from "@phosphor-icons/react";

const Stat = ({ label, value, icon: Icon, accent }) => (
  <div className="border border-slate-800 bg-slate-900 rounded-sm p-5" data-testid={`stat-${label}`}>
    <div className="flex items-start justify-between">
      <div>
        <div className="overline">{label}</div>
        <div className="font-mono text-3xl font-bold mt-2 text-slate-100">{value}</div>
      </div>
      <div className={`w-10 h-10 rounded-sm flex items-center justify-center ${accent}`}>
        <Icon size={20} weight="regular" />
      </div>
    </div>
  </div>
);

const QuickAction = ({ to, icon: Icon, title, desc, testId }) => (
  <Link to={to} data-testid={testId}
    className="block border border-slate-800 bg-slate-900 hover:bg-slate-800 hover:border-blue-600 rounded-sm p-5 transition-colors duration-150">
    <div className="flex items-center gap-3 mb-3">
      <Icon size={22} weight="regular" className="text-blue-400" />
      <div className="font-semibold">{title}</div>
    </div>
    <p className="text-sm text-slate-400 leading-relaxed">{desc}</p>
  </Link>
);

export default function Dashboard() {
  const { user } = useAuth();
  const { t } = useI18n();
  const [stats, setStats] = useState({ presses: 0, molds: 0, materials: 0, problems: 0, solved: 0 });
  const [recent, setRecent] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const [p, m, mat, pr] = await Promise.all([
          api.get("/presses"), api.get("/molds"), api.get("/materials"), api.get("/problems"),
        ]);
        setStats({
          presses: p.data.length, molds: m.data.length, materials: mat.data.length,
          problems: pr.data.length, solved: pr.data.filter((x) => x.solved).length,
        });
        setRecent(pr.data.slice(0, 5));
      } catch (e) { /* ignore */ }
    })();
  }, []);

  return (
    <div className="p-8 max-w-7xl mx-auto" data-testid="dashboard-page">
      <div className="mb-8">
        <div className="overline">// {t("dashboard")}</div>
        <h1 className="text-4xl font-black tracking-tight mt-1">{t("hello")}, {user?.full_name?.split(" ")[0]}</h1>
        <p className="text-slate-400 mt-2">{t("tagline")}</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <Stat label={t("presses")} value={stats.presses} icon={Books} accent="bg-blue-950 text-blue-400" />
        <Stat label={t("molds")} value={stats.molds} icon={Books} accent="bg-blue-950 text-blue-400" />
        <Stat label={t("materials")} value={stats.materials} icon={Books} accent="bg-blue-950 text-blue-400" />
        <Stat label={t("problems")} value={`${stats.solved}/${stats.problems}`} icon={CheckCircle} accent="bg-emerald-950 text-emerald-400" />
      </div>

      <div className="mb-8">
        <div className="overline mb-3">{t("quickActions")}</div>
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
          <QuickAction to="/solver" icon={Wrench} title={t("problemSolver")} desc={t("startProblemSolver")} testId="quick-solver" />
          <QuickAction to="/sheet" icon={ChartLine} title={t("moldingSheet")} desc={t("startMoldingSheet")} testId="quick-sheet" />
          <QuickAction to="/history" icon={ClockCounterClockwise} title={t("history")} desc={t("goHistory")} testId="quick-history" />
          <QuickAction to="/registries/presses" icon={Books} title={t("registries")} desc={t("manageRegistries")} testId="quick-registries" />
        </div>
      </div>

      {recent.length > 0 && (
        <div>
          <div className="overline mb-3">{t("interventions")}</div>
          <div className="border border-slate-800 rounded-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-900 border-b border-slate-800">
                <tr>
                  <th className="text-left px-4 py-3 overline">{t("date")}</th>
                  <th className="text-left px-4 py-3 overline">{t("defect")}</th>
                  <th className="text-left px-4 py-3 overline">{t("material")}</th>
                  <th className="text-left px-4 py-3 overline">{t("operator")}</th>
                  <th className="text-left px-4 py-3 overline">Stato</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id} className="border-b border-slate-900 hover:bg-slate-900 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-slate-400">{new Date(r.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3">{r.defect_name}</td>
                    <td className="px-4 py-3 text-slate-400">{r.material_name || "—"}</td>
                    <td className="px-4 py-3 text-slate-400">{r.operator_name}</td>
                    <td className="px-4 py-3">
                      {r.solved
                        ? <span className="inline-flex items-center gap-1 text-emerald-400 text-xs"><CheckCircle size={12} /> OK</span>
                        : <span className="inline-flex items-center gap-1 text-amber-400 text-xs"><Warning size={12} /> KO</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
