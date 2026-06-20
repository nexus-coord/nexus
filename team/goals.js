const fs = require("fs");
const crypto = require("crypto");

const GOAL_STATUS = Object.freeze({
  ACTIVE: "active",
  COMPLETED: "completed",
  BLOCKED: "blocked",
  ABANDONED: "abandoned",
});

class Goal {
  constructor({ description, priority = 0, parentGoalId = null, tags = [] }) {
    this.id = crypto.randomUUID();
    this.description = description;
    this.status = GOAL_STATUS.ACTIVE;
    this.priority = priority;
    this.parentGoalId = parentGoalId;
    this.subGoalIds = [];
    this.relatedTaskIds = [];
    this.tags = tags;
    this.notes = [];
    this.createdAt = new Date().toISOString();
    this.updatedAt = new Date().toISOString();
    this.completedAt = null;
  }

  _touch() {
    this.updatedAt = new Date().toISOString();
  }

  linkTask(taskId) {
    if (!this.relatedTaskIds.includes(taskId)) this.relatedTaskIds.push(taskId);
    this._touch();
  }

  addNote(note) {
    this.notes.push({ note, at: new Date().toISOString() });
    this._touch();
  }

  complete(note = "") {
    this.status = GOAL_STATUS.COMPLETED;
    this.completedAt = new Date().toISOString();
    if (note) this.addNote(note);
    this._touch();
  }

  block(reason = "") {
    this.status = GOAL_STATUS.BLOCKED;
    if (reason) this.addNote(`Blocked: ${reason}`);
    this._touch();
  }

  abandon(reason = "") {
    this.status = GOAL_STATUS.ABANDONED;
    if (reason) this.addNote(`Abandoned: ${reason}`);
    this._touch();
  }

  reactivate() {
    this.status = GOAL_STATUS.ACTIVE;
    this._touch();
  }
}

class GoalRegistry {
  constructor(filePath) {
    this.filePath = filePath;
    this._goals = new Map();
    this._load();
  }

  add({ description, priority = 0, parentGoalId = null, tags = [] }) {
    const goal = new Goal({ description, priority, parentGoalId, tags });
    if (parentGoalId && this._goals.has(parentGoalId)) {
      this._goals.get(parentGoalId).subGoalIds.push(goal.id);
    }
    this._goals.set(goal.id, goal);
    this._save();
    return goal;
  }

  get(id) {
    return this._goals.get(id) ?? null;
  }

  active() {
    return [...this._goals.values()].filter((g) => g.status === GOAL_STATUS.ACTIVE);
  }

  all() {
    return [...this._goals.values()];
  }

  update(id, fn) {
    const goal = this._goals.get(id);
    if (!goal) throw new Error(`Goal not found: ${id}`);
    fn(goal);
    this._save();
    return goal;
  }

  summary() {
    const counts = { active: 0, completed: 0, blocked: 0, abandoned: 0 };
    for (const g of this._goals.values()) counts[g.status]++;
    return counts;
  }

  _save() {
    const data = JSON.stringify([...this._goals.values()], null, 2);
    fs.writeFileSync(this.filePath, data);
  }

  _load() {
    if (!fs.existsSync(this.filePath)) return;
    const raw = fs.readFileSync(this.filePath, "utf8").trim();
    if (!raw) return;
    for (const plain of JSON.parse(raw)) {
      const goal = Object.assign(new Goal({ description: plain.description }), plain);
      this._goals.set(goal.id, goal);
    }
  }
}

module.exports = { Goal, GoalRegistry, GOAL_STATUS };
