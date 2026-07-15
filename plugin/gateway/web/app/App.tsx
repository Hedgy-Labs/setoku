// SPDX-License-Identifier: Apache-2.0
import { Routes, Route, useLocation } from "react-router-dom";
import { useAuth } from "./auth";
import { IS_DEMO } from "./env";
import { Layout } from "./Layout";
import { Brand } from "./components/Brand";
import { DemoBanner } from "./components/DemoBanner";
import { Login } from "./pages/Login";
import { ForcePasswordChange } from "./pages/ChangePassword";
import { Review } from "./pages/Review";
import { Knowledge } from "./pages/Knowledge";
import { Sources } from "./pages/Sources";
import { Trends } from "./pages/Trends";
import { Team } from "./pages/Team";
import { Audit } from "./pages/Audit";
import { Apps } from "./pages/Apps";
import { AppView } from "./pages/AppView";

export function App() {
  const { me, loading } = useAuth();
  // On a demo box an admin still needs a way in past the read-only viewer: the
  // "Sign in" chrome links to /?signin=1, which shows the login form even though
  // the viewer "me" is present.
  const wantsSignIn = new URLSearchParams(useLocation().search).get("signin") === "1";

  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Brand className="text-3xl opacity-40" />
      </div>
    );

  if (!me || (me.role === "viewer" && wantsSignIn))
    return (
      <>
        {IS_DEMO ? <DemoBanner /> : null}
        <Login />
      </>
    );

  // Temp (admin-minted) password: force a change before anything else (#73).
  if (me.mustChangePassword) return <ForcePasswordChange />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Apps />} />
        <Route path="knowledge" element={<Knowledge />} />
        <Route path="knowledge/review" element={<Review />} />
        <Route path="sources" element={<Sources />} />
        <Route path="sources/trends" element={<Trends />} />
        <Route path="team" element={<Team />} />
        <Route path="audit" element={<Audit />} />
        <Route path="apps/:id" element={<AppView />} />
        <Route path="*" element={<Apps />} />
      </Route>
    </Routes>
  );
}
