import { useState } from "react";
import { type Api, ApiError, Offline } from "../lib/api";

interface Props {
  api: Api;
  /** Called after a sheet is made, so the new codes reach this phone. */
  onDone: () => Promise<unknown>;
}

/**
 * A PDF of unassigned codes for Avery 6576 stock (S-BOOT-02). The one thing
 * in these screens that needs the server: the PDF is built there. It goes
 * through the API like every other call, so it finds the server wherever the
 * app is served from.
 */
export function PrintCodes({ api, onDone }: Props) {
  const [sheets, setSheets] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  async function print() {
    setBusy(true);
    setError(null);
    try {
      // Clamped here, not while typing, so the field never fights the thumb.
      const pdf = await api.codeSheets(Math.min(10, Math.max(1, Number(sheets) || 1)));
      const url = URL.createObjectURL(pdf);
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      setBlobUrl(url);
      window.open(url, "_blank");
      await onDone();
    } catch (e) {
      if (e instanceof Offline) setError("No connection. Printing needs one.");
      else if (e instanceof ApiError) setError(e.message);
      else setError(String(e));
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
