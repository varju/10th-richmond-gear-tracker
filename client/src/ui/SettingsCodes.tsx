import type { Shell } from "../shell";
import type { Api } from "../lib/api";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { Page } from "./Page";
import { PrintCodes } from "./PrintCodes";

interface Props {
  store: Store;
  api: Api;
  shell: Shell;
}

/** A sheet of unassigned codes for Avery 6576 stock. Admin only (S-BOOT-02). */
export function SettingsCodes({ store, api, shell }: Props) {
  useStore(store);

  if (!store.admin) {
    return (
      <Page title="Not found" back="/settings">
        <p>Admins only.</p>
      </Page>
    );
  }

  return (
    <Page title="Print QR codes" back="/settings">
      <PrintCodes api={api} onDone={shell.sync} />
    </Page>
  );
}
