import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { createApi } from "./lib/api";
import { openDb } from "./lib/db";
import { BASE } from "./lib/router";
import { Store } from "./lib/store";
import "./styles.css";

registerSW({ immediate: true });

const store = await Store.open(await openDb());
const api = createApi({ base: BASE, token: () => store.meta.token });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App store={store} api={api} />
  </StrictMode>,
);
