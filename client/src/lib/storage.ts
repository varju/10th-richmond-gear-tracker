/** Ask the browser to keep our data (NFR-DATA-11). iOS answers "refused"; nothing is shown for it. */
export type Persistence = "persisted" | "refused" | "unsupported";

export async function ensurePersistent(storage: StorageManager | undefined = navigator.storage): Promise<Persistence> {
  if (!storage?.persist) return "unsupported";
  if (await storage.persisted()) return "persisted";
  return (await storage.persist()) ? "persisted" : "refused";
}
