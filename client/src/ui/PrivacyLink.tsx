import { privacyUrl } from "../lib/server";

/**
 * The privacy policy (FR-PUB-07), in a new window, so the app's own window stays where it was. In
 * place, it would replace a home-screen app with no way back. The iPhone app hands it to Safari.
 */
export function PrivacyLink() {
  return (
    <p className="muted small">
      <a href={privacyUrl()} target="_blank" rel="noopener">
        Privacy
      </a>
    </p>
  );
}
