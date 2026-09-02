/** IndexedDB with promises. Two stores, no library. */

export const DB_NAME = "gear-tracker";
const VERSION = 1;

export function openDb(name: string = DB_NAME, factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  const request = factory.open(name, VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    // Settings and the snapshot, one value per key.
    db.createObjectStore("meta");
    // Every event this device knows: pulled from the server, or recorded here and waiting to go.
    db.createObjectStore("events", { keyPath: "id" });
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
