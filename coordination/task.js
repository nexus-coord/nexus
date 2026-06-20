const crypto = require("crypto");

const STATUS = Object.freeze({
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  DONE: "done",
  FAILED: "failed",
});

class Task {
  constructor({ type, capability, input, dependsOn = [], priority = 0, fromAgentId = null }) {
    this.id = crypto.randomUUID();
    this.type = type;
    this.capability = capability;
    this.input = input;
    this.dependsOn = dependsOn;
    this.priority = priority;
    this.fromAgentId = fromAgentId; // agent that produced the upstream work for this task
    this.status = STATUS.PENDING;
    this.result = null;
    this.error = null;
    this.assignedTo = null;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
  }

  assign(agentId) {
    this.assignedTo = agentId;
    this.status = STATUS.IN_PROGRESS;
    this.updatedAt = Date.now();
  }

  complete(result) {
    this.result = result;
    this.status = STATUS.DONE;
    this.updatedAt = Date.now();
  }

  fail(error) {
    this.error = error instanceof Error ? error.message : String(error);
    this.status = STATUS.FAILED;
    this.updatedAt = Date.now();
  }
}

module.exports = { Task, STATUS };
