import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { useI18n } from "../i18n";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { toast } from "sonner";
import { Factory, ShieldCheck } from "@phosphor-icons/react";

const BG = "https://images.unsplash.com/photo-1717386255767-52643970d483?crop=entropy&cs=srgb&fm=jpg&ixid=M3w3NDQ2NDF8MHwxfHNlYXJjaHwzfHxtYW51ZmFjdHVyaW5nJTIwZmFjdG9yeSUyMGZsb29yfGVufDB8fHx8MTc4NzgzMzA2M3ww&ixlib=rb-4.1.0&q=85";

export default function Login() {
  const { login } = useAuth();
  const { t, lang, setLang } = useI18n();
  const nav = useNavigate();
  const [username, setU] = useState("");
  const [password, setP] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await login(username, password);
      nav("/");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-2" data-testid="login-page">
      {/* Left: image */}
      <div className="hidden lg:block relative">
        <img src={BG} alt="factory" className="absolute inset-0 w-full h-full object-cover" />
        <div className="absolute inset-0 bg-slate-950/70" />
        <div className="relative z-10 flex flex-col justify-between h-full p-10">
          <div className="flex items-center gap-3">
            <Factory size={32} weight="fill" className="text-blue-500" />
            <div>
              <div className="font-black text-2xl tracking-tight">MOLD ASSIST</div>
              <div className="overline">Injection molding · v1.0</div>
            </div>
          </div>
          <div>
            <h1 className="text-5xl font-black tracking-tight leading-tight max-w-md">
              Stampaggio<br /><span className="text-blue-500">scientifico</span><br />in un tocco.
            </h1>
            <p className="mt-6 text-slate-400 max-w-md">
              Diagnosi difetti, schede parametri e storico interventi per attrezzisti e capiturno.
            </p>
          </div>
          <div className="text-xs text-slate-500 font-mono">© 2026 · Reparto Stampaggio</div>
        </div>
      </div>

      {/* Right: form */}
      <div className="flex items-center justify-center p-6 lg:p-16 bg-slate-950">
        <div className="w-full max-w-md">
          <div className="flex items-center justify-between mb-10">
            <div className="flex items-center gap-2 lg:hidden">
              <Factory size={24} weight="fill" className="text-blue-500" />
              <span className="font-black">MOLD ASSIST</span>
            </div>
            <div className="flex gap-1 border border-slate-700 rounded-sm ml-auto">
              <button data-testid="lang-it" onClick={() => setLang("it")}
                className={`px-3 py-1 text-xs font-semibold ${lang==="it"?"bg-blue-600 text-white":"text-slate-400 hover:bg-slate-800"}`}>IT</button>
              <button data-testid="lang-en" onClick={() => setLang("en")}
                className={`px-3 py-1 text-xs font-semibold ${lang==="en"?"bg-blue-600 text-white":"text-slate-400 hover:bg-slate-800"}`}>EN</button>
            </div>
          </div>

          <div className="overline mb-2">// {t("loginSubtitle")}</div>
          <h2 className="text-4xl font-black mb-8 tracking-tight">{t("loginTitle")}</h2>

          <form onSubmit={submit} className="space-y-5" data-testid="login-form">
            <div>
              <Label htmlFor="u" className="text-slate-300 text-xs uppercase tracking-wider">{t("username")}</Label>
              <Input id="u" data-testid="login-username-input" value={username}
                onChange={(e) => setU(e.target.value)}
                className="mt-1 bg-slate-900 border-slate-700 h-11 rounded-sm font-mono" required />
            </div>
            <div>
              <Label htmlFor="p" className="text-slate-300 text-xs uppercase tracking-wider">{t("password")}</Label>
              <Input id="p" data-testid="login-password-input" type="password" value={password}
                onChange={(e) => setP(e.target.value)}
                className="mt-1 bg-slate-900 border-slate-700 h-11 rounded-sm font-mono" required />
            </div>
            <Button type="submit" disabled={busy} data-testid="login-submit-button"
              className="w-full h-11 rounded-sm bg-blue-600 hover:bg-blue-700 text-white font-semibold uppercase tracking-wider">
              {busy ? "…" : t("login")}
            </Button>
          </form>

          <div className="mt-8 p-4 border border-slate-800 bg-slate-900/50 rounded-sm">
            <div className="flex items-center gap-2 mb-2 text-slate-400">
              <ShieldCheck size={14} />
              <span className="overline">{t("demoCreds")}</span>
            </div>
            <div className="font-mono text-xs text-slate-300 space-y-1">
              <div>admin / admin123</div>
              <div>attrezzista / test123</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
