import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Theme, type ThemeProps } from "@radix-ui/themes";
import { App } from "./App.tsx";
import { installBusyGuard, installFocusRescue, LiveRegion } from "./a11y.tsx";
import { ConfirmProvider } from "./ui.tsx";
import "./styles.css";

installBusyGuard();
installFocusRescue();

// "brand" is not one of Radix's own colors: the organization's accent is generated
// (shared/accentScale.ts) and set as --accent-1 … 12 on <html> by theme.ts, which every
// Radix component reads. Light or dark comes from the class theme.ts puts on <html>,
// hence appearance "inherit".
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Theme
      accentColor={"brand" as ThemeProps["accentColor"]}
      grayColor="slate"
      radius="medium"
      scaling="100%"
      panelBackground="solid"
      appearance="inherit"
    >
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
      <LiveRegion />
    </Theme>
  </StrictMode>,
);
