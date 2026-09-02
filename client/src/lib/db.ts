/** IndexedDB with promises. Three stores, no library. */

export const DB_NAME = "gear-tracker";
const VERSION = 2;

export function openDb(name: string = DB_NAME, factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  const request = factory.open(name, VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    const has = (name: string) => db.objectStoreNames.contains(name);
    // Settings and the snapshot, one value per key.
    if (!has("meta")) db.createObjectStore("meta");
    // Every event this device knows: pulled from the server, or recorded here and waiting to go.
    if (!has("events")) db.createObjectStore("events", { keyPath: "id" });
    // Photos taken with no signal, waiting to upload (FR-INV-11). Gone once the server has them.
    if (!has("photos")) db.createObjectStore("photos", { keyPath: "id" });
  };
  return req(request);
}

export function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function deleteDb(name: string = DB_NAME, factory: IDBFactory = indexedDB): Promise<void> {
  await req(factory.deleteDatabase(name));
}
