// SPDX-License-Identifier: Apache-2.0
/**
 * Entry for the public /p/<id> page of a shared TABULAR file (built to
 * web/dist/file-viewer.js). The page is server-rendered chrome (title, Download)
 * plus a mount point; its config names the file's public download URL, which
 * this fetches and parses in the browser. See grid/FileViewer.tsx.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FileViewer } from "./grid/FileViewer";

interface FileViewerConfig {
  src: string;
  name: string;
  mime: string;
  creds: RequestCredentials;
}

const cfg = (window as unknown as { __SETOKU_FILE__?: FileViewerConfig }).__SETOKU_FILE__;
const root = document.getElementById("fg");
if (cfg && root) {
  createRoot(root).render(
    <StrictMode>
      {/* A 401 means a password grant lapsed: reload, and the server answers with the prompt. */}
      <FileViewer src={cfg.src} name={cfg.name} mime={cfg.mime} credentials={cfg.creds} onUnauthorized={() => location.reload()} />
    </StrictMode>,
  );
}
