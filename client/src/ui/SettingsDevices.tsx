import { useState } from "react";
import type { Api } from "../lib/api";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { DeviceList } from "./Devices";
import { Page } from "./Page";

interface Props {
  store: Store;
  api: Api;
}

/** Devices and assistants signed in as you (FR-USR-17). Revoke one you have lost. */
export function SettingsDevices({ store, api }: Props) {
  useStore(store);
  const [error, setError] = useState<string | null>(null);

  return (
    <Page title="Your devices" back="/settings">
      <p className="muted small">Devices and assistants signed in as you. Revoke one you have lost.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {store.meta.user && (
        <DeviceList
          userId={store.meta.user.id}
          me
          myDevice={store.meta.device_id}
          api={api}
          onError={setError}
          label="Your devices"
        />
      )}
    </Page>
  );
}
