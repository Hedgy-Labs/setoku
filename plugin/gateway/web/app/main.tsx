// SPDX-License-Identifier: Apache-2.0
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./auth";
import { Toaster } from "./components/Toast";
import { App } from "./App";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter basename="/">
        <AuthProvider>
          <App />
        </AuthProvider>
        <Toaster />
      </BrowserRouter>
    </StrictMode>,
  );
}
