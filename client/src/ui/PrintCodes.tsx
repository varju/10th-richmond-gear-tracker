import { useState } from "react";
import { type Api, ApiError, Offline } from "../lib/api";
import { NATIVE } from "../lib/server";
import { NOT_SHARED, shareFile } from "../lib/share";

interface Props {
  api: Api;
  /** Called after a sheet is made, so the new codes reach this device. */
  onDone: () => Promise<unknown>;
  /** The iPhone app's build. A prop so tests can reach that branch. */
  native?: boolean;
}

/**
 * A PDF of unassigned codes for Avery 6576 stock (S-BOOT-02). The one thing
 * in these screens that needs the server: the PDF is built there. It goes
 * through the API like every other call, so it finds the server wherever the
 * app is served from.
 */
export function PrintCodes({ api, onDone, native = NATIVE }: Props) {
  const [sheets, setSheets] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  // The app shares the PDF rather than opening it. Kept so a second tap can share it again.
  const [pdf, setPdf] = useState<Blob | null>(null);

  async function print() {
    setBusy(true);
    setError(null);
    try {
      // Clamped here, not while typing, so the field never fights the thumb.
      const pdf = await api.codeSheets(Math.min(10, Math.max(1, Number(sheets) || 1)));
      if (native) {
        setPdf(pdf);
        // Straight away, while the tap still counts: the sheet will not open after a long wait.
        const shared = share(pdf);
        await onDone();
        await shared;
        return;
      }
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

  async function share(file: Blob) {
    try {
      await shareFile(file, "codes.pdf");
    } catch {
      setError(NOT_SHARED);
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
          Print QR codes
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {pdf && (
        <button
          type="button"
          onClick={() => {
            setError(null);
            void share(pdf);
          }}
        >
          Share codes.pdf
        </button>
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
