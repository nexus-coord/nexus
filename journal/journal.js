const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ENTRIES_DIR = path.join(__dirname, "entries");
const JOURNAL_FILE = path.join(ENTRIES_DIR, "journal.jsonl");

const ENTRY_TYPES = Object.freeze({
  OBSERVATION:      "observation",       // general note about what the agent noticed
  TASK_RESULT:      "task_result",       // outcome of a completed task
  DECISION:         "decision",          // why a choice was made
  ERROR:            "error",             // something went wrong
  SUMMARY:          "summary",           // end-of-session recap
  CONTEXT:          "context",           // beginning-of-session state recall
  INTERACTION:      "interaction",       // agent-to-agent event (review, approval, handoff, etc.)
  GOAL_UPDATE:      "goal_update",       // a goal changed status or received a note
  PROPOSAL:         "proposal",          // agent proposes a change to the foundation doc
  PROPOSAL_REVIEW:  "proposal_review",   // Critic's verdict on a proposal
  RATIFICATION:     "ratification",      // human applies a proposal to the foundation doc
});

class Journal {
  constructor(filePath = JOURNAL_FILE) {
    this.filePath = filePath;
    if (!fs.existsSync(path.dirname(filePath))) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, "");
    }
  }

  // Append a single entry. Returns the written entry.
  write({ sessionId, type, content, tags = [], relatedTaskIds = [] }) {
    if (!Object.values(ENTRY_TYPES).includes(type)) {
      throw new Error(`Unknown entry type: ${type}`);
    }
    const entry = {
      id: crypto.randomUUID(),
      sessionId,
      type,
      content,
      tags,
      relatedTaskIds,
      timestamp: new Date().toISOString(),
    };
    fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
    return entry;
  }

  // Read all entries, optionally filtered.
  read({ type = null, sessionId = null, tags = [], limit = null } = {}) {
    const raw = fs.readFileSync(this.filePath, "utf8").trim();
    if (!raw) return [];

    let entries = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    if (type) entries = entries.filter((e) => e.type === type);
    if (sessionId) entries = entries.filter((e) => e.sessionId === sessionId);
    if (tags.length) entries = entries.filter((e) => tags.some((t) => e.tags.includes(t)));
    if (limit) entries = entries.slice(-limit); // most recent N

    return entries;
  }

  // Return a lightweight context object for wake-up reorientation.
  recall(limit = 5) {
    const summaries    = this.read({ type: ENTRY_TYPES.SUMMARY, limit });
    const errors       = this.read({ type: ENTRY_TYPES.ERROR, limit: 3 });
    const goalUpdates  = this.read({ type: ENTRY_TYPES.GOAL_UPDATE, limit });
    const interactions = this.read({ type: ENTRY_TYPES.INTERACTION, limit: 10 });
    const pendingProposals = this.pendingProposals();
    return { summaries, errors, goalUpdates, interactions, pendingProposals, retrievedAt: new Date().toISOString() };
  }

  // All proposals that have not yet received a Critic review and have not been ratified directly
  pendingProposals() {
    const proposals = this.read({ type: ENTRY_TYPES.PROPOSAL });
    const reviewed  = new Set(
      this.read({ type: ENTRY_TYPES.PROPOSAL_REVIEW }).map((e) => e.content.proposalId)
    );
    const ratified  = new Set(
      this.read({ type: ENTRY_TYPES.RATIFICATION }).map((e) => e.content.proposalId)
    );
    return proposals.filter((p) => !reviewed.has(p.id) && !ratified.has(p.id));
  }

  // All proposals that passed Critic review but haven't been ratified by a human yet
  awaitingRatification() {
    const ratified = new Set(
      this.read({ type: ENTRY_TYPES.RATIFICATION }).map((e) => e.content.proposalId)
    );
    const reviews = this.read({ type: ENTRY_TYPES.PROPOSAL_REVIEW });
    return reviews
      .filter((r) => r.content.outcome === "approved" && !ratified.has(r.content.proposalId))
      .map((r) => ({
        review: r,
        proposal: this.read({ type: ENTRY_TYPES.PROPOSAL }).find((p) => p.id === r.content.proposalId),
      }))
      .filter((item) => item.proposal);
  }

  // Interaction history between a specific pair of agents
  interactionsBetween(agentA, agentB) {
    return this.read({ type: ENTRY_TYPES.INTERACTION }).filter((e) => {
      const { from, to } = e.content;
      return (from === agentA && to === agentB) || (from === agentB && to === agentA);
    });
  }

  // How many entries exist total
  size() {
    return this.read().length;
  }
}

module.exports = { Journal, ENTRY_TYPES };
