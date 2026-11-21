import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { PrivacyPage } from "@/components/privacy";
import "@/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Élément #root absent de confidentialite/index.html");

createRoot(root).render(
  <StrictMode>
    <PrivacyPage />
  </StrictMode>,
);
