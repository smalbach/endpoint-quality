import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import "./styles/index.css";
import { App, createQueryClient } from "@/app";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App client={createQueryClient()} />
    </BrowserRouter>
  </StrictMode>,
);
