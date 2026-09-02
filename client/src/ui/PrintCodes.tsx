import { useState } from "react";
import type { Store } from "../lib/store";

interface Props {
  store: Store;
  /** Called after a sheet is made, so the new codes reach this phone. */
  onDone: () => Promise<unknown>;
}

/**
 * A PDF of unassigned codes for Avery 6576 stock (S-BOOT-02). The one thing
 * in these screens that needs the server: the PDF is built there.
 */
export function PrintCodes({ store, onDone }: Props) {
  const [sheets, setSheets] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  async function print() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/codes/sheets", {
        method: "POST",
        headers: { Authorization: `Bearer ${store.meta.token}`, "Content-Type": "application/json" },
        // Clamped here, not while typing, so the field never fights the thumb.
        body: JSON.stringify({ sheets: Math.min(10, Math.max(1, Number(sheets) || 1)) }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        setError(body.message ?? `The server said ${response.status}.`);
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      setBlobUrl(url);
      window.open(url, "_blank");
      await onDone();
    } catch (e) {
      setError(e instanceof TypeError ? "No connection. Printing needs one." : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="row">
        <label className="tight">
          <span>Sheets</span>
          <input type="number" min={1} max={10} value={sheets} onChange={(e) => setSheets(e.target.value)} />
        </label>
        <button type="button" onClick={print} disabled={busy}>
          Print codes
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {blobUrl && (
        <p>
          <a download="codes.pdf" href={blobUrl}>
            Download codes.pdf
          </a>{" "}
          if it did not open.
        </p>
      )}
    </>
  );
}
