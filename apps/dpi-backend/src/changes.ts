// The device change feed: one synchronous channel that tells viewers something durable changed.
// Writers notify next to the write; streams subscribe once and coalesce their own re-reads.
export type Listener = () => void;

export class ChangeFeed {
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  notify = () => {
    for (const fn of this.listeners) fn();
  };
}
