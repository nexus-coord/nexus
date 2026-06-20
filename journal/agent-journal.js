"use strict";

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const AGENTS_DIR = path.join(__dirname, "entries", "agents");

const AGENT_ENTRY_TYPES = Object.freeze({
  ACTION:              "action",              // something the agent did this session
  PERSONAL_GOAL:       "personal_goal",       // individual goal the agent is tracking
  RELATIONAL_OPINION:  "relational_opinion",  // agent's assessment of a teammate
  OBSERVATION:         "observation",         // personal finding worth preserving
  PEER_REVIEW:         "peer_review",         // review of another instance's output
});

class AgentJournal {
  constructor(agentId) {
    this.agentId  = agentId;
    this.filePath = path.join(AGENTS_DIR, `${agentId}.jsonl`);
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
    if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, "");
  }

  write({ sessionId, type, content, tags = [] }) {
    if (!Object.values(AGENT_ENTRY_TYPES).includes(type)) {
      throw new Error(`Unknown agent entry type: ${type}`);
    }
    const entry = {
      id:        crypto.randomUUID(),
      agentId:   this.agentId,
      sessionId,
      type,
      content,
      tags,
      timestamp: new Date().toISOString(),
    };
    fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
    return entry;
  }

  read({ type = null, limit = null } = {}) {
    const raw = fs.readFileSync(this.filePath, "utf8").trim();
    if (!raw) return [];
    let entries = raw.split("\n").filter(Boolean).map(l => JSON.parse(l));
    if (type) entries = entries.filter(e => e.type === type);
    if (limit) entries = entries.slice(-limit);
    return entries;
  }

  // Return recent entries as a readable summary string for injection into system prompts.
  summary({ limit = 10 } = {}) {
    const entries = this.read({ limit });
    if (!entries.length) return "No individual journal entries yet.";
    return entries.map(e => {
      const date = e.timestamp.slice(0, 10);
      const body = typeof e.content === "string"
        ? e.content
        : JSON.stringify(e.content);
      return `[${date}] ${e.type}: ${body.slice(0, 200)}`;
    }).join("\n");
  }

  // Score relevance of this journal to a goal string (keyword overlap).
  // Returns 0.0–1.0. Used by the Roster for activation weighting.
  relevanceTo(goalText) {
    if (!goalText) return 0;
    const entries = this.read({ limit: 20 });
    if (!entries.length) return 0;
    const keywords = goalText.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    if (!keywords.length) return 0;
    const text = entries.map(e => JSON.stringify(e.content)).join(" ").toLowerCase();
    const hits  = keywords.filter(k => text.includes(k)).length;
    return hits / keywords.length;
  }

  size() { return this.read().length; }

  exists() { return this.size() > 0; }
}

module.exports = { AgentJournal, AGENT_ENTRY_TYPES };
