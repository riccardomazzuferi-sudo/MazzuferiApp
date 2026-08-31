import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { useI18n } from "../i18n";
import { Factory, House, Wrench, ChartLine, Drop, Books, ClockCounterClockwise, SignOut } from "@phosphor-icons/react";

const Item = ({ to, icon: Icon, label, testId }) => (
  <NavLink to={to} data-testid={testId} end
    className={({ isActive }) =>
      `flex items-center gap-3 px-3 h-11 border-l-2 text-sm transition-colors duration-150 ${
        isActive ? "border-blue-500 bg-slate-900 text-white" : "border-transparent text-slate-400 hover:bg-slate-900 hover:text-slate-100"
      }`
    }>
    <Icon size={18} weight="regular" />
    <span className="font-medium">{label}</span>
  </NavLink>
);

export default function Layout() {
  const { user, logout } = useAuth();
  const { t, lang, setLang } = useI18n();
  const nav = useNavigate();

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex">
      <aside className="w-60 shrink-0 border-r border-slate-800 flex flex-col bg-slate-950 sticky top-0 h-screen">
        <div className="p-5 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Factory size={22} weight="fill" className="text-blue-500" />
            <div>
              <div className="font-black text-sm tracking-tight">MOLD ASSIST</div>
              <div className="text-[10px] text-slate-500 uppercase tracking-widest">v1.0</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 py-4 space-y-0.5">
          <div className="px-5 pb-2 overline">Operatività</div>
          <Item to="/" icon={House} label={t("dashboard")} testId="nav-dashboard" />
          <Item to="/solver" icon={Wrench} label={t("problemSolver")} testId="nav-solver" />
          <Item to="/sheet" icon={ChartLine} label={t("moldingSheet")} testId="nav-sheet" />
          <Item to="/flow" icon={Drop} label={t("flowSimulation")} testId="nav-flow" />
          <Item to="/history" icon={ClockCounterClockwise} label={t("history")} testId="nav-history" />
          <div className="px-5 pt-4 pb-2 overline">{t("registries")}</div>
          <Item to="/registries/presses" icon={Books} label={t("presses")} testId="nav-presses" />
          <Item to="/registries/molds" icon={Books} label={t("molds")} testId="nav-molds" />
          <Item to="/registries/materials" icon={Books} label={t("materials")} testId="nav-materials" />
        </nav>

        <div className="border-t border-slate-800 p-3">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-sm bg-blue-600 flex items-center justify-center text-xs font-bold">
              {user?.full_name?.[0]?.toUpperCase() || "U"}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold truncate" data-testid="user-fullname">{user?.full_name}</div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">{user?.role}</div>
            </div>
          </div>
          <div className="flex gap-1 mb-2">
            <button data-testid="sidebar-lang-it" onClick={() => setLang("it")}
              className={`flex-1 py-1 text-[10px] rounded-sm border ${lang==="it"?"bg-blue-600 border-blue-600":"border-slate-700 text-slate-400 hover:bg-slate-800"}`}>IT</button>
            <button data-testid="sidebar-lang-en" onClick={() => setLang("en")}
              className={`flex-1 py-1 text-[10px] rounded-sm border ${lang==="en"?"bg-blue-600 border-blue-600":"border-slate-700 text-slate-400 hover:bg-slate-800"}`}>EN</button>
          </div>
          <button data-testid="logout-btn" onClick={() => { logout(); nav("/login"); }}
            className="w-full flex items-center gap-2 px-2 h-9 text-xs text-slate-400 hover:bg-slate-900 hover:text-red-400 rounded-sm transition-colors">
            <SignOut size={14} />
            <span>{t("logout")}</span>
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0">
        <Outlet />
      </main>
    </div>
  );
}
