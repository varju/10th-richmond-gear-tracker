import { sections } from "virtual:guide";
import { navigate, useRoute } from "../lib/router";
import { Page } from "./Page";

/**
 * The user guide (NFR-USE-11). Each section is one file under docs/guide/,
 * turned into HTML at build time, so nothing parses markdown on the phone.
 * One tab per section, kept in the URL so back and a shared link land on the
 * same guide; contents first, then the tasks. Adding a section is adding a file.
 */
export function Help() {
  const route = useRoute();
  const wanted = route.query.get("guide");
  const section = sections.find((s) => s.id === wanted) ?? sections[0];
  return (
    <Page title="Help" back="/">
      {!section && <p>No guide was built into this copy.</p>}
      {section && (
        <>
          <div className="tabs" role="tablist" aria-label="Guides">
            {sections.map((s) => (
              <button
                key={s.id}
                role="tab"
                type="button"
                aria-selected={s.id === section.id}
                onClick={() => navigate(`/help?guide=${s.id}`, true)}
              >
                {s.title}
              </button>
            ))}
          </div>
          <section key={section.id} role="tabpanel" aria-label={section.title}>
            <nav className="guide-contents" aria-label={`${section.title} contents`}>
              <ul>
                {section.headings.map((h) => (
                  <li key={h.id}>
                    <a href={`#${h.id}`}>{h.text}</a>
                  </li>
                ))}
              </ul>
            </nav>
            {/* Our own markdown, compiled by the build. Nothing here comes from a user or the server. */}
            <div className="guide" dangerouslySetInnerHTML={{ __html: section.html }} />
          </section>
        </>
      )}
    </Page>
  );
}
