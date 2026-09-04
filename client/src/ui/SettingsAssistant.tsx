import { useState } from "react";
import { type Api, ApiError, type AssistantToken, Offline } from "../lib/api";
import { BASE, navigate } from "../lib/router";
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
          An AI assistant that speaks MCP (Model Context Protocol) can search the inventory, book gear, and check it out
          and in for you. It acts as you, with what you are allowed to do.
        </p>
        <p className="muted small">
          Connecting makes a token. Add this site as an MCP server in your assistant and paste the token in. It needs a
          connection, so it is no use in the yard.{" "}
          <button className="link" type="button" onClick={() => navigate("/help?guide=assistant")}>
            More in the guide
          </button>
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
        Your token. It is shown once, so copy it now.
        <br />
        <code className="wrap">{made.token}</code>
      </p>
      <p className="muted small">
        In your assistant, add an MCP server at <code className="wrap">{`${location.origin}${BASE}${made.path}`}</code>
        <br />
        with the header <code>Authorization: Bearer &lt;token&gt;</code>.
      </p>
      <p className="muted small">
        The assistant is now in your device list. Revoke it there if the token is ever lost.
      </p>
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
