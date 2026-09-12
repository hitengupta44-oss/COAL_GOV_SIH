// Records written with no signal, held until there is one.
//
// IndexedDB rather than localStorage: an inspection carries notes,
// coordinates and a timestamp, several may pile up across a shift, and
// localStorage is synchronous and size-limited. IndexedDB is neither, and
// it survives the app being closed — which matters when someone records a
// finding underground and does not reopen the app until the next day.
//
// Nothing here talks to the network. The queue only stores intent; the
// sync function is handed the same submit callbacks the online path uses,
// so an offline record goes through exactly the same validation and the
// same permission checks as a live one.

const DB_NAME = "coalgov-offline";
const STORE = "queue";
const VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("No offline storage on this device"));
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

export async function enqueue(kind, payload) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, "readwrite").add({
      kind,
      payload,
      queuedAt: new Date().toISOString(),
      attempts: 0,
      lastError: null,
    });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listQueue() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, "readonly").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function remove(id) {
  const db = await openDb();
  return new Promise((resolve) => {
    const req = tx(db, "readwrite").delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
  });
}

async function markFailed(item, message) {
  const db = await openDb();
  return new Promise((resolve) => {
    const req = tx(db, "readwrite").put({
      ...item,
      attempts: (item.attempts || 0) + 1,
      lastError: message,
    });
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
  });
}

/**
 * Sends everything queued. `handlers` maps a kind to an async function
 * that performs the real write.
 *
 * A failed item is kept and retried, not discarded — the whole point is
 * that a record survives a bad connection. But an item that has failed
 * repeatedly is left in place with its error visible rather than retried
 * forever in the background, so a genuine problem (a revoked role, a mine
 * reassignment) surfaces to a person instead of silently looping.
 */
export async function syncQueue(handlers) {
  const items = await listQueue();
  let sent = 0, failed = 0;

  for (const item of items) {
    const handler = handlers[item.kind];
    if (!handler) continue;
    if ((item.attempts || 0) >= 5) { failed++; continue; }
    try {
      const result = await handler(item.payload);
      if (result?.error) throw new Error(result.error);
      await remove(item.id);
      sent++;
    } catch (e) {
      await markFailed(item, e.message || String(e));
      failed++;
    }
  }
  return { sent, failed, remaining: (await listQueue()).length };
}

export async function clearQueue() {
  const db = await openDb();
  return new Promise((resolve) => {
    const req = tx(db, "readwrite").clear();
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
  });
}
