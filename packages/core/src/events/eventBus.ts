import { EventEmitter } from "node:events";
import type { AgentEvent, BackendStatus, ServerMessage, Task } from "@agent-workbench/protocol";

export class EventBus {
  private readonly emitter = new EventEmitter();

  publishEvent(event: AgentEvent): void {
    this.emitter.emit("message", { type: "event", event } satisfies ServerMessage);
  }

  publishTask(task: Task): void {
    this.emitter.emit("message", { type: "task.updated", task } satisfies ServerMessage);
  }

  publishBackend(backend: BackendStatus): void {
    this.emitter.emit("message", { type: "backend.updated", backend } satisfies ServerMessage);
  }

  onMessage(listener: (message: ServerMessage) => void): () => void {
    this.emitter.on("message", listener);
    return () => this.emitter.off("message", listener);
  }
}
