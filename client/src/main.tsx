import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { createApi } from "./lib/api";
import { openDb } from "./lib/db";
import { followLinks } from "./lib/links";
import { API_BASE } from "./lib/server";
import { Store } from "./lib/store";
import { watchForUpdates } from "./lib/update";
import "./styles.css";

watchForUpdates(registerSW);

const store = await Store.open(await openDb());
const api = createApi({ base: API_BASE, token: () => store.meta.token });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App store={store} api={api} />
  </StrictMode>,
);
followLinks();
