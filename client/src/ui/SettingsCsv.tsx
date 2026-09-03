import type { Shell } from "../shell";
import type { Api } from "../lib/api";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { CsvTools } from "./CsvTools";
import { Page } from "./Page";

interface Props {
  store: Store;
  api: Api;
  shell: Shell;
}

/** Export the inventory to a spreadsheet and import it back. Admin only (FR-RPT-03, FR-SET-11). */
export function SettingsCsv({ store, api, shell }: Props) {
  useStore(store);
  const admin = store.meta.user?.role === "admin";

  if (!admin) {
    return (
      <Page title="Not found" back="/settings">
        <p>Admins only.</p>
      </Page>
    );
  }

  return (
    <Page title="Export and import" back="/settings">
      <CsvTools api={api} onDone={shell.sync} />
    </Page>
  );
}
