import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { installWakeDetection } from "./resume";
import { store } from "./store";
import { RootErrorBoundary } from "./ui/ErrorBoundary";

const root = document.getElementById("root");
if (root === null) throw new Error("no #root");

/*
 * Wake detection and bootstrap are installed once, outside React.
 *
 * Deliberately not in an effect: StrictMode mounts twice in development, and a
 * resume path that runs twice would mint two tokens per machine and open two
 * sockets per session — which is exactly the bug this design exists to avoid,
 * introduced by the tool meant to reveal it.
 */
installWakeDetection();
void store.bootstrap();

/*
 * The boundary is **inside** `StrictMode` and wraps everything React renders.
 *
 * Nothing above it can be caught — an error thrown while this module is
 * evaluating, or by `createRoot` itself, is still a blank page — so it is as high
 * as a boundary can usefully go. See `RootErrorBoundary` for why there is one
 * rather than one per screen.
 */
createRoot(root).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
