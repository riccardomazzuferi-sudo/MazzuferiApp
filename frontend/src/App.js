import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider, useAuth } from "./auth";
import { I18nProvider } from "./i18n";
import Login from "./pages/Login";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Registries from "./pages/Registries";
import DefectSolver from "./pages/DefectSolver";
import MoldingSheet from "./pages/MoldingSheet";
import FlowSimulation from "./pages/FlowSimulation";
import History from "./pages/History";

const Protected = ({ children }) => {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-screen flex items-center justify-center text-slate-500">…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
};

function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        <div className="App">
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/" element={<Protected><Layout /></Protected>}>
                <Route index element={<Dashboard />} />
                <Route path="solver" element={<DefectSolver />} />
                <Route path="sheet" element={<MoldingSheet />} />
                <Route path="flow" element={<FlowSimulation />} />
                <Route path="history" element={<History />} />
                <Route path="registries/:kind" element={<Registries />} />
              </Route>
            </Routes>
          </BrowserRouter>
          <Toaster theme="dark" position="top-right" />
        </div>
      </AuthProvider>
    </I18nProvider>
  );
}

export default App;
