import { LocalStore, defaultStorePath, type WorkbenchStore } from "./localStore.js";

export function createWorkbenchStore(path?: string): WorkbenchStore {
  return new LocalStore(path ?? defaultStorePath());
}
