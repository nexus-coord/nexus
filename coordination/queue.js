const { STATUS } = require("./task");

// Priority queue — highest priority tasks surface first.
// Blocks tasks whose dependencies haven't completed yet.

class TaskQueue {
  constructor() {
    this._tasks = new Map(); // id → Task
  }

  enqueue(task) {
    this._tasks.set(task.id, task);
    return task;
  }

  // Returns the highest-priority pending task whose dependencies are all done,
  // optionally filtered to a specific capability.
  next(capability = null) {
    const doneIds = new Set(
      [...this._tasks.values()]
        .filter((t) => t.status === STATUS.DONE)
        .map((t) => t.id)
    );

    return [...this._tasks.values()]
      .filter((t) => {
        if (t.status !== STATUS.PENDING) return false;
        if (capability && t.capability !== capability) return false;
        return t.dependsOn.every((id) => doneIds.has(id));
      })
      .sort((a, b) => b.priority - a.priority)[0] ?? null;
  }

  get(id) {
    return this._tasks.get(id) ?? null;
  }

  // Summary counts by status
  stats() {
    const counts = { pending: 0, in_progress: 0, done: 0, failed: 0 };
    for (const t of this._tasks.values()) counts[t.status]++;
    return counts;
  }

  all() {
    return [...this._tasks.values()];
  }
}

module.exports = { TaskQueue };
