import { changesFor, reconcile, ConflictError } from "./replica.js";
import { adoptTaskAuthors } from "../../shared/task-authors.js";
const overlay = (rows, incoming) => {
  const map = new Map(rows.map((r) => [r.id, r]));
  for (const row of incoming)
    if ((map.get(row.id)?.revision || 0) <= row.revision) map.set(row.id, row);
  return [...map.values()];
};
export class RoomReplica {
  constructor(saved, send, changed) {
    this.base = saved?.base || [];
    this.objects = saved?.objects || [];
    this.flight = saved?.flight || null;
    this.remote = this.base;
    this.send = send;
    this.changed = changed;
    this.ready = false;
    this.conflict = null;
    this.error = "";
  }
  get dirty() {
    return !!this.flight || changesFor(this.base, this.objects).length > 0;
  }
  save() {
    return {
      version: 1,
      base: this.base,
      objects: this.objects,
      flight: this.flight,
    };
  }
  edit(objects) {
    this.objects = objects;
    this.changed();
  }
  integrate(resolution) {
    try {
      this.objects = reconcile(
        this.base,
        this.objects,
        this.remote,
        resolution,
      );
      this.base = this.remote;
      this.conflict = null;
      this.error = "";
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      this.conflict = error.message;
    }
    this.changed();
  }
  receive(message) {
    if (message.type === "snapshot") {
      this.remote = message.rows;
      this.ready = true;
      if (this.flight) {
        this.send(this.flight);
        this.changed();
      } else this.integrate();
    } else if (message.type === "changes") {
      this.remote = overlay(this.remote, message.rows);
      if (!this.flight) this.integrate();
    } else if (message.type === "ack" && message.opId === this.flight?.opId) {
      this.objects = adoptTaskAuthors(
        this.objects,
        message.rows.filter((r) => !r.deleted && r.data).map((r) => r.data),
      );
      this.base = overlay(this.base, message.rows);
      this.remote = overlay(this.remote, message.rows);
      this.flight = null;
      this.integrate();
    } else if (
      message.type === "conflict" &&
      message.opId === this.flight?.opId
    ) {
      this.flight = null;
      this.remote = overlay(this.remote, message.rows);
      this.integrate();
    } else if (message.type === "error") {
      if (message.opId === this.flight?.opId) this.flight = null;
      this.error = message.message;
      this.changed();
    }
  }
  flush() {
    if (!this.ready || this.flight || this.conflict || this.error) return;
    const changes = changesFor(this.base, this.objects);
    if (!changes.length) return;
    if (changes.length > 200) {
      this.error = "一次修改超过 200 个对象，请撤销后分批操作。";
      this.changed();
      return;
    }
    const message = { type: "commit", opId: crypto.randomUUID(), changes };
    if (
      new TextEncoder().encode(JSON.stringify(message)).length >
      1024 * 1024
    ) {
      this.error = "一次修改过大，请撤销后分批操作。";
      this.changed();
      return;
    }
    this.flight = message;
    this.changed(); // Persist before sending; a refresh can then replay the exact operation.
    this.send(message);
  }
  resolve(choice) {
    this.integrate(choice);
  }
  retry() {
    this.error = "";
    if (this.ready && this.flight) this.send(this.flight);
    else this.flush();
  }
}
