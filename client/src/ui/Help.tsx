import { sections } from "virtual:guide";
import { Page } from "./Page";

/**
 * The user guide (NFR-USE-11). Each section is one file under docs/guide/,
 * turned into HTML at build time, so nothing parses markdown on the phone.
 * Contents first, then the tasks. Adding a section is adding a file.
 */
export function Help() {
  return (
    <Page title="Help" back="/">
      {sections.length === 0 && <p>No guide was built into this copy.</p>}
      {sections.map((section) => (
        <section key={section.id} aria-labelledby={section.id}>
          <h2 className="section" id={section.id}>
            {section.title}
          </h2>
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
      ))}
    </Page>
  );
}
