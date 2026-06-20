"use strict";

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const JOURNAL_PATH = path.join(__dirname, "../journal/entries/journal.jsonl");

function _appendEvent(sessionId, eventType, content, tags = []) {
  const entry = {
    id:        crypto.randomUUID(),
    sessionId,
    type:      eventType,
    content,
    tags,
    relatedTaskIds: [],
    timestamp: new Date().toISOString(),
  };
  fs.appendFileSync(JOURNAL_PATH, JSON.stringify(entry) + "\n");
}

// Trust thresholds → how many self-examination passes a rejection triggers
function examDepth(trustScore) {
  if (trustScore >= 76) return 4;
  if (trustScore >= 61) return 3;
  if (trustScore >= 41) return 2;
  return 1;
}

// Weighting for trust vs familiarity in routing score (ratified Section 4 change).
const TRUST_WEIGHT       = 0.4;
const FAMILIARITY_WEIGHT = 0.6;
const EXPLORATION_RATE   = 0.12; // ~12% of assignments routed to non-top agent

function routingScore(familiarity, trustScore) {
  const normFam   = Math.min(familiarity / 20, 1);  // familiarity grows slowly; cap at 20 for normalization
  const normTrust = trustScore / 100;
  return FAMILIARITY_WEIGHT * normFam + TRUST_WEIGHT * normTrust;
}

// Return the agent ID that would win on trust score alone (ignoring familiarity).
function rankByTrustOnly(scored) {
  if (!scored || scored.length === 0) return null;
  return [...scored].sort((a, b) => b.trustScore - a.trustScore)[0].member.id;
}

class Dispatcher {
  constructor(queue, { relations = null, sessionId = null } = {}) {
    this.queue        = queue;
    this.relations    = relations;
    this.sessionId    = sessionId;
    this._agents      = new Map(); // capability → [{ member, handler }]
    this._onComplete  = [];
    this._taskCount   = 0;         // tracks when to apply exploration budget
  }

  register(member, handler) {
    for (const capability of member.capabilities) {
      if (!this._agents.has(capability)) this._agents.set(capability, []);
      this._agents.get(capability).push({ member, handler });
    }
    return this;
  }

  onComplete(fn) {
    this._onComplete.push(fn);
    return this;
  }

  // Select the best candidate for a task using trust+familiarity weighted score.
  // Applies exploration budget: ~12% of assignments go to a non-top agent.
  _selectAgent(candidates, task) {
    if (candidates.length === 1 || !this.relations || !task.fromAgentId) {
      return candidates[0];
    }

    const scored = candidates.map(c => {
      const rel         = this.relations.get(task.fromAgentId, c.member.id);
      const familiarity = rel ? rel.familiarity   : 0;
      const trustScore  = rel ? rel.trustFrom(task.fromAgentId) : 50;
      const score       = routingScore(familiarity, trustScore);
      return { ...c, familiarity, trustScore, score };
    }).sort((a, b) => b.score - a.score);

    this._taskCount++;
    const useExploration = candidates.length > 1 &&
      Math.random() < EXPLORATION_RATE &&
      this._taskCount > 1; // never explore on the very first task

    let chosen;
    if (useExploration && scored.length > 1) {
      // Pick any non-top agent at random from the rest
      const pool = scored.slice(1);
      chosen     = pool[Math.floor(Math.random() * pool.length)];
      console.log(
        `  [Dispatcher] ${task.type}: exploration budget — routed to ${chosen.member.id}` +
        ` (score ${chosen.score.toFixed(2)}) instead of top ${scored[0].member.id}`
      );
    } else {
      chosen = scored[0];
      const runner = scored[1];
      console.log(
        `  [Dispatcher] ${task.type}: selected ${chosen.member.id}` +
        ` (score ${chosen.score.toFixed(2)}, fam ${chosen.familiarity}, trust ${chosen.trustScore})` +
        (runner ? ` over ${runner.member.id} (score ${runner.score.toFixed(2)})` : "")
      );
    }

    // Emit ROUTING_DECISION event when sessionId is available
    if (this.sessionId) {
      const trustOnlyTop    = rankByTrustOnly(scored);
      const selectionReason = useExploration ? "exploration"
        : (chosen.member.id !== trustOnlyTop ? "familiarity" : "trust");
      _appendEvent(this.sessionId, "ROUTING_DECISION", {
        decidedBy:          task.fromAgentId || "dispatcher",
        taskId:             task.id          || null,
        capability:         task.type,
        candidates:         scored.map(c => ({
          agentId:        c.member.id,
          trustScore:     c.trustScore,
          familiarity:    c.familiarity,
          relevanceScore: 0,
        })),
        selected:           chosen.member.id,
        selectionReason,
        selectionRationale: useExploration
          ? `Exploration budget — routed to ${chosen.member.id} instead of top ${scored[0].member.id}`
          : `${chosen.member.id} scored highest (composite ${chosen.score.toFixed(2)}, fam ${chosen.familiarity}, trust ${chosen.trustScore})`,
        counterfactualAgent: trustOnlyTop,
        routingDrift:        chosen.member.id !== trustOnlyTop,
      }, ["routing-decision"]);
    }

    return chosen;
  }

  async tick() {
    for (const [capability, agents] of this._agents) {
      const task = this.queue.next(capability);
      if (!task || !agents.length) continue;

      const { member, handler } = this._selectAgent(agents, task);
      task.assign(member.id);

      try {
        const result = await handler(task);
        task.complete(result);
      } catch (err) {
        task.fail(err);
      }

      for (const cb of this._onComplete) cb(task);
      return true;
    }
    return false;
  }

  async run() {
    let idle = 0;
    while (idle < 3) {
      const dispatched = await this.tick();
      idle = dispatched ? 0 : idle + 1;
    }
    return this.queue.stats();
  }
}

module.exports = { Dispatcher, examDepth, routingScore, rankByTrustOnly };
