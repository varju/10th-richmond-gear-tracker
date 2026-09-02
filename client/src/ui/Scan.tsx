import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { bindCode } from "../lib/actions";
import { parseCode } from "../lib/codes";
import { code as codeOf, codeStatus, item } from "../lib/inventory";
import { navigate, useRoute } from "../lib/router";
import { startScanner } from "../lib/scanner";
import type { Store } from "../lib/store";
import { Page } from "./Page";

const FLASH_MS = 2000;

/**
 * The camera, full screen. A code goes to /g/<code>. With ?for=<itemId> the
 * code is a replacement sticker for that item and is bound here (FR-TAG-04).
 */
export function Scan({ store }: { store: Store }) {
  const forItem = useRoute().query.get("for");
  const video = useRef<HTMLVideoElement>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");

  const say = (message: string) => {
    setFlash(message);
    window.setTimeout(() => setFlash((current) => (current === message ? null : current)), FLASH_MS);
  };

  const handle = useCallback(
    async (text: string) => {
      const id = parseCode(text);
      if (!id) return say("Not a gear code");
      if (!forItem) return navigate(`/g/${id}`);
      const status = codeStatus(store.state, id);
      if (status === "unknown") return say("Not one of our codes");
      if (status !== "unassigned") {
        const owner = item(store.state, codeOf(store.state, id)?.item_id ?? "");
        return say(`That code is already on ${owner?.name ?? "another item"}`);
      }
      try {
        await bindCode(store, id, forItem);
      } catch (e) {
        return say(e instanceof Error ? e.message : "Could not bind the code");
      }
      navigate(`/items/${forItem}`, true);
    },
    [store, forItem],
  );

  // The scanner closes over the latest handler without restarting the camera on every render.
  const latest = useRef(handle);
  latest.current = handle;

  useEffect(() => {
    if (!video.current) return;
    const scanner = startScanner(video.current, (text) => void latest.current(text), { onError: setCameraError });
    return () => scanner.stop();
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = typed;
    setTyped("");
    void handle(text);
  }

  return (
    <Page
      title={forItem ? "Scan new code" : "Scan"}
      back={forItem ? `/items/${forItem}` : "/"}
      actions={
        <>
          {typing && (
            <form onSubmit={submit} className="scan-typed">
              <input
                aria-label="Code or URL"
                placeholder="Code or URL"
                autoFocus
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
              <button type="submit" className="primary">
                Go
              </button>
            </form>
          )}
          {!typing && (
            <button type="button" onClick={() => setTyping(true)}>
              Type a code instead
            </button>
          )}
        </>
      }
    >
      <div className="viewfinder">
        <video ref={video} muted playsInline hidden={cameraError !== null} />
        {cameraError ? (
          <p className="scan-error" role="alert">
            {cameraError}
          </p>
        ) : (
          <p className="scan-hint">{forItem ? "Point at the new sticker" : "Point at a code"}</p>
        )}
        {flash && (
          <p className="scan-flash" role="status">
            {flash}
          </p>
        )}
      </div>
    </Page>
  );
}
