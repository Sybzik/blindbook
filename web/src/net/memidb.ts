// An in-memory IndexedDB for the mixnet worker (THREAT_MODEL N12). The worker runs with an opaque
// origin, which has no IndexedDB, and its mixnet identity should never reach the disk anyway: it
// lives as long as the worker. vite.config.ts bundles this file into the worker's code, ahead of
// mix-tunnel's own.
import {
  IDBCursor,
  IDBCursorWithValue,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
  IDBVersionChangeEvent,
  indexedDB,
} from 'fake-indexeddb';

const globals = { indexedDB, IDBCursor, IDBCursorWithValue, IDBDatabase, IDBFactory, IDBIndex, IDBKeyRange, IDBObjectStore, IDBOpenDBRequest, IDBRequest, IDBTransaction, IDBVersionChangeEvent };
// `indexedDB` is a getter on the worker's prototype chain: define own properties that shadow it.
for (const [name, value] of Object.entries(globals)) Object.defineProperty(self, name, { value, configurable: true, writable: true });
