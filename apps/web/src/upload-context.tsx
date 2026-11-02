import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { api } from "./api";
import { useAuth } from "./auth";
import { UploadQueue } from "./upload-queue";

const Context = createContext<UploadQueue | undefined>(undefined);
export function UploadQueueProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const ownerId = auth.session?.guest?.id ?? auth.session?.user.id;
  const canUpload = auth.can("upload");
  const queue = useMemo(() => new UploadQueue(api), [ownerId, canUpload]);
  useEffect(() => () => queue.stop(), [queue]);
  return <Context.Provider value={queue}>{children}</Context.Provider>;
}
export function useUploadQueue() {
  const queue = useContext(Context); if (!queue) throw new Error("Missing UploadQueueProvider");
  const entries = useSyncExternalStore(queue.subscribe, queue.snapshot, queue.snapshot);
  return { queue, entries };
}
