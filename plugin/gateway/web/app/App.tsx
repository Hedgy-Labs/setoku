// SPDX-License-Identifier: Apache-2.0
import { Routes, Route } from "react-router-dom";
import { useAuth } from "./auth";
import { Layout } from "./Layout";
import { Brand } from "./components/Brand";
import { Login } from "./pages/Login";
import { Pending } from "./pages/Pending";
import { Knowledge } from "./pages/Knowledge";
import { Sources } from "./pages/Sources";
import { Team } from "./pages/Team";
import { Audit } from "./pages/Audit";
import { Dashboards } from "./pages/Dashboards";
import { DashboardView } from "./pages/DashboardView";

export function App() {
  const { me, loading } = useAuth();

  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Brand className="text-3xl opacity-40" />
      </div>
    );

  if (!me) return <Login />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Pending />} />
        <Route path="knowledge" element={<Knowledge />} />
        <Route path="sources" element={<Sources />} />
        <Route path="team" element={<Team />} />
        <Route path="audit" element={<Audit />} />
        <Route path="dashboards" element={<Dashboards />} />
        <Route path="p/:id" element={<DashboardView />} />
        <Route path="*" element={<Pending />} />
      </Route>
    </Routes>
  );
}
