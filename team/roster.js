"use strict";

const { AgentJournal } = require("../journal/agent-journal");
const { roles }        = require("./roles");

// Default team roster — which agent instances exist per role.
// Single-instance roles (orchestrator, critic) stay at 1 for now.
const DEFAULT_ROSTER = {
  orchestrator: ["orchestrator-1"],
  researcher:   ["res-1", "res-2"],
  analyst:      ["ana-1", "ana-2"],
  executor:     ["exe-1", "exe-2"],
  critic:       ["critic-1"],
};

class Roster {
  constructor(rosterMap = DEFAULT_ROSTER) {
    this.rosterMap       = rosterMap;
    // How many consecutive sessions each instance has been excluded.
    // Persisted across CLI calls via the session state file if needed,
    // but managed in-memory within a single process for now.
    this._exclusions = {};
  }

  // Return the role key for an agent ID.
  roleOf(agentId) {
    for (const [role, ids] of Object.entries(this.rosterMap)) {
      if (ids.includes(agentId)) return role;
    }
    return null;
  }

  // All instances for a given role.
  instancesFor(role) {
    return this.rosterMap[role] || [];
  }

  // All agent IDs across all roles.
  allAgents() {
    return Object.values(this.rosterMap).flat();
  }

  // Select which instances to activate for a given role this session.
  //
  // Selection algorithm:
  //   1. Score each instance by journal relevance to the session goal.
  //   2. Any instance excluded for 2+ consecutive sessions is force-activated (floor rule).
  //   3. Fill remaining activation slots by relevance score descending.
  //   4. Update exclusion counters.
  //
  // Returns an array of agent IDs (≤ maxActive).
  activate(role, { goalText = "", maxActive = 2 } = {}) {
    const instances = this.instancesFor(role);

    if (instances.length <= 1) {
      // Nothing to choose — always active.
      for (const id of instances) this._exclusions[id] = 0;
      return instances;
    }

    const scored = instances.map(id => ({
      id,
      relevance:    new AgentJournal(id).relevanceTo(goalText),
      exclusions:   this._exclusions[id] || 0,
      mustActivate: (this._exclusions[id] || 0) >= 2,
    }));

    scored.sort((a, b) => b.relevance - a.relevance);

    const selected = [];

    // Force-activate any instance that has been excluded too long.
    for (const s of scored.filter(s => s.mustActivate)) {
      if (selected.length < maxActive) selected.push(s.id);
    }

    // Fill remaining slots by relevance.
    for (const s of scored.filter(s => !s.mustActivate)) {
      if (selected.length >= maxActive) break;
      selected.push(s.id);
    }

    // Update exclusion counters.
    for (const { id } of scored) {
      this._exclusions[id] = selected.includes(id)
        ? 0
        : (this._exclusions[id] || 0) + 1;
    }

    return selected;
  }

  // Build a member object suitable for passing to runAgent / buildSystemPrompt.
  memberFor(agentId) {
    const role = this.roleOf(agentId);
    if (!role || !roles[role]) return null;
    return { id: agentId, ...roles[role] };
  }

  // Snapshot of roster state for logging.
  snapshot() {
    return Object.entries(this.rosterMap).map(([role, ids]) => ({
      role,
      instances: ids,
      exclusions: ids.map(id => ({ id, count: this._exclusions[id] || 0 })),
    }));
  }
}

module.exports = { Roster, DEFAULT_ROSTER };
