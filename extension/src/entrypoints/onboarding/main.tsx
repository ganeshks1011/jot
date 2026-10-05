import React from "react";
import ReactDOM from "react-dom/client";
import { watchTheme } from "@/lib/theme";
import Onboarding from "./Onboarding";
import "./style.css";

watchTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Onboarding />
  </React.StrictMode>,
);
