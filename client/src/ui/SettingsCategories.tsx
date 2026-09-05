import { createCategory, deleteCategory, renameCategory } from "../lib/actions";
import { categories } from "../lib/inventory";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { NameList } from "./NameList";
import { Page } from "./Page";

interface Props {
  store: Store;
}

/** How gear is grouped in the list. Admin only (FR-SET-07). */
export function SettingsCategories({ store }: Props) {
  useStore(store);

  if (!store.admin) {
    return (
      <Page title="Not found" back="/settings">
        <p>Admins only.</p>
      </Page>
    );
  }

  return (
    <Page title="Categories" back="/settings">
      <p className="muted small">
        How gear is grouped in the list: tents, stoves, tarps. Optional. Gear with none is listed last.
      </p>
      <NameList
        noun="category"
        items={categories(store.state)}
        onAdd={(name) => createCategory(store, name)}
        onRename={(id, name) => renameCategory(store, id, name)}
        onDelete={(id) => deleteCategory(store, id)}
      />
    </Page>
  );
}
