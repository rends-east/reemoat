import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import * as cp from "./cp";
import { store } from "./gateStore";
import { provideSignInAuth } from "./signInAuth";
import { GateApp } from "./ui/gate/GateApp";
import { RootErrorBoundary } from "./ui/ErrorBoundary";

// The gate bundle's entry: gateStore, never store.ts, which would bring the fleet start-up and the Noise stack onto the sign-up page.
// Registered from the entry point: both hooks are last-writer-wins, and only an entry's body is sure to run after every store it imports.
cp.onSignedOut((failure) => store.handleSignedOut(failure));
provideSignInAuth(store);

const root = document.getElementById("root");
if (root === null) throw new Error("no #root");

void store.refreshConfig();

createRoot(root).render(
  <StrictMode>
    <RootErrorBoundary>
      <GateApp />
    </RootErrorBoundary>
  </StrictMode>,
);
