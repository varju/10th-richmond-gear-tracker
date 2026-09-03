import { useCallback, useEffect, useState } from "react";
import { type Api, ApiError, type Device, isAssistant, Offline } from "../lib/api";
import { isoDate } from "../lib/time";

interface Props {
  userId: string;
  me: boolean;
  myDevice: string;
  api: Api;
  onError: (message: string | null) => void;
  label: string;
}

/**
 * One person's signed-in devices and assistants (FR-USR-14): the Users list for
 * an Admin looking at someone else, and Settings for looking at your own.
 */
export function DeviceList({ userId, me, myDevice, api, onError, label }: Props) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    onError(null);
    setOffline(false);
    try {
      setDevices((await api.devices(userId)).data.devices);
    } catch (e) {
      // Settings is opened in lockers with no signal; this is routine, not an error to alert on.
      if (e instanceof Offline) setOffline(true);
      else if (e instanceof ApiError) onError(e.message);
      else throw e;
    }
  }, [api, userId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(deviceId: string) {
    setBusy(true);
    onError(null);
    try {
      setDevices((await api.revokeDevice(userId, deviceId)).data.devices);
    } catch (e) {
      // Here offline is worth a word: the person just tapped Revoke.
      if (e instanceof Offline) onError("Needs a connection.");
      else if (e instanceof ApiError) onError(e.message);
      else throw e;
    } finally {
      setBusy(false);
    }
  }

  if (offline) return <p className="muted small">Needs a connection to list devices.</p>;
  if (devices === null) return <p className="muted small">Loading…</p>;
  if (devices.length === 0) return <p className="muted small">Not signed in anywhere.</p>;

  return (
    <>
      <ul className="names" aria-label={label}>
        {devices.map((d) => {
          const mine = me && d.device_id === myDevice;
          const kind = isAssistant(d.device_id) ? "Assistant" : mine ? "This device" : "Device";
          return (
            <li key={d.device_id} className="row">
              <span className="small">
                {kind} · signed in {isoDate(d.created_at)}
              </span>
              <button
                type="button"
                className="minor"
                disabled={busy || mine}
                title={mine ? "Sign out instead" : ""}
                onClick={() => revoke(d.device_id)}
              >
                Revoke
              </button>
            </li>
          );
        })}
      </ul>
      <p className="muted small">
        Revoking a device ends its access the next time it syncs. Revoking an assistant cuts its token off at once.
      </p>
    </>
  );
}
