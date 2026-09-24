import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { inNativeShell, setNativeTheme } from "./native";
import { installWakeDetection } from "./resume";
import { store } from "./store";
import { installTheme } from "./theme";
import { RootErrorBoundary } from "./ui/ErrorBoundary";

const root = document.getElementById("root");
if (root === null) throw new Error("no #root");

installTheme(inNativeShell() ? setNativeTheme : undefined);
// Outside React on purpose: StrictMode's double mount would mint two tokens and open two sockets.
installWakeDetection();
void store.bootstrap();

createRoot(root).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
