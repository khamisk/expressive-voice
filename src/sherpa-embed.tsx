import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/fredoka/wght.css";
import "@bible-strong/avatar-react/styles.css";
import { SherpaEmbedApp } from "./SherpaEmbedApp";
import "./embed.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SherpaEmbedApp />
  </StrictMode>,
);
