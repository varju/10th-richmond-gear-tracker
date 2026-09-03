import { useState } from "react";
import { type Api, ApiError, type AssistantToken, Offline } from "../lib/api";
import { BASE } from "../lib/router";
import { Page } from "./Page";

interface Props {
  api: Api;
}

/** Connect an assistant to the inventory (FR-MCP-01). */
export function SettingsAssistant({ api }: Props) {
  return (
    <Page title="AI assistant" back="/settings">
      <ConnectAssistant api={api} />
    </Page>
  );
}

/**
 * A token for an MCP client, minted by whoever is signed in (FR-MCP-01). Shown
 * once, like an invite link. It is a device session, so it is listed with the
 * person's devices and revoked the same way (FR-MCP-02).
 */
function ConnectAssistant({ api }: { api: Api }) {
  const [made, setMade] = useState<AssistantToken | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      setMade((await api.connectAssistant()).data);
    } catch (e) {
      if (e instanceof Offline) setError("Needs a connection. Tokens are made on the server.");
      else if (e instanceof ApiError) setError(e.message);
      else throw e;
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (!made) {
    return (
      <>
        <p className="muted small">
          Ask an assistant about the inventory, and let it book gear for you. It can do what you can do in the app,
          Admin work included when you are one.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="button" onClick={connect} disabled={busy}>
          Connect an assistant
        </button>
      </>
    );
  }

  return (
    <div className="notice" role="status">
      <p>
        Paste this token into your assistant. It is shown once.
        <br />
        <code className="wrap">{made.token}</code>
      </p>
      <p className="muted small">
        Server: <code className="wrap">{`${location.origin}${BASE}${made.path}`}</code>
        <br />
        Send it as the header <code>Authorization: Bearer &lt;token&gt;</code>.
      </p>
      <p className="muted small">It is now in your device list above. Revoke it there if it is ever lost.</p>
      <div className="row">
        <button type="button" className="minor primary" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className="minor" onClick={() => setMade(null)}>
          Done
        </button>
      </div>
    </div>
  );
}
