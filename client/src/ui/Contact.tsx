/** A tappable contact when we can tell what it is, and the plain text when we cannot. */
export function Contact({ contact }: { contact: string }) {
  const href = /^https?:\/\//i.test(contact)
    ? contact
    : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)
      ? `mailto:${contact}`
      : null;
  return href ? <a href={href}>{contact}</a> : <>{contact}</>;
}
