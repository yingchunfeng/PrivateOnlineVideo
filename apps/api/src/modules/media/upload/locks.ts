/** 有界并发由调用层控制，此处串行同一任务的分片及完成 CAS。 */
export class UploadLocks {
  private readonly tails = new Map<string, Promise<void>>();
  async run<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    let release!: () => void; const tail = new Promise<void>(resolve => { release = resolve; });
    this.tails.set(id, tail);
    await previous;
    try { return await operation(); }
    finally { release(); if (this.tails.get(id) === tail) this.tails.delete(id); }
  }
}
