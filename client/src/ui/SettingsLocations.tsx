import { createLocation, deleteLocation, renameLocation } from "../lib/actions";
import { locations } from "../lib/inventory";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { NameList } from "./NameList";
import { Page } from "./Page";

interface Props {
  store: Store;
}

/** Where gear lives when it is not out. Admin only (FR-SET-02, FR-SET-05). */
export function SettingsLocations({ store }: Props) {
  useStore(store);

  if (!store.admin) {
    return (
      <Page title="Not found" back="/settings">
        <p>Admins only.</p>
      </Page>
    );
  }

  return (
    <Page title="Locations" back="/settings">
      <p className="muted small">
        Where gear lives when it is not out. Every item has one home, picked from this list.
      </p>
      <NameList
        noun="location"
        items={locations(store.state)}
        onAdd={(name) => createLocation(store, name)}
        onRename={(id, name) => renameLocation(store, id, name)}
        onDelete={(id) => deleteLocation(store, id)}
      />
    </Page>
  );
}
