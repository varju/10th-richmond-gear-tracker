import { privacyUrl } from "../lib/server";

/**
 * The privacy policy (FR-PUB-07), in a new window. In place, it would replace a home-screen app
 * with no way back, and offline it would be an error. The iPhone app hands a new window to Safari.
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
