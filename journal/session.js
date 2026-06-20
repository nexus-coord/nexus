const fs     = require("fs");
const crypto = require("crypto");
const path   = require("path");
const { Journal, ENTRY_TYPES } = require("./journal");
const { GoalRegistry } = require("../team/goals");
const { RelationGraph, INTERACTION_TYPES, OUTCOMES } = require("../team/relations");

const ENTRIES_DIR   = path.join(__dirname, "entries");
const FOUNDATION_PATH = path.join(__dirname, "../docs/team-foundation.md");

// Loaded once and cached — all sessions in a process share the same text
const FOUNDATION_DOC = fs.existsSync(FOUNDATION_PATH)
  ? fs.readFileSync(FOUNDATION_PATH, "utf8")
  : null;

function pairKey(a, b) {
  return [a, b].sort().join("::");
}

class Session {
  constructor({
    goal,
    journal   = new Journal(),
    goals     = new GoalRegistry(path.join(ENTRIES_DIR, "goals.json")),
    relations = new RelationGraph(path.join(ENTRIES_DIR, "relations.json")),
  } = {}) {
    this.id           = crypto.randomUUID();
    this.sessionGoal  = goal;
    this.journal      = journal;
    this.goals        = goals;
    this.relations    = relations;
    this.context      = null;
    this.foundation   = FOUNDATION_DOC; // team charter — injected into agent system prompts
    this.startedAt    = null;
    this.stoppedAt    = null;

    this._pendingConflicts = new Set();
  }

  wake() {
    this.startedAt = new Date().toISOString();

    // Advance the session counter and apply decay to stale pairs
    const sessionIndex = this.relations.advanceSession();

    this.context = this.journal.recall();
    const activeGoals  = this.goals.active();
    const pastSessions = this.context.summaries.length;
    const relSnapshot  = this.relations.snapshot();

    console.log(`\n[Session ${this.id.slice(0, 8)}] Waking  (session index: ${sessionIndex})`);
    console.log(`  Foundation doc: ${this.foundation ? `loaded (${this.foundation.length} chars)` : "NOT FOUND"}`);
    console.log(`  Goal: "${this.sessionGoal}"`);
    console.log(`  Past sessions recalled: ${pastSessions}`);

    if (activeGoals.length) {
      console.log(`  Active goals (${activeGoals.length}):`);
      for (const g of activeGoals) {
        console.log(`    • [P${g.priority}] ${g.description}`);
      }
    }

    if (relSnapshot.length) {
      console.log(`  Team relationships:`);
      for (const r of relSnapshot) {
        console.log(
          `    ${r.pair} — ${r.label}` +
          `  (proximity ${r.proximity}` +
          `  | A→B trust ${r.trustAtoB}  B→A trust ${r.trustBtoA}` +
          `  | familiarity ${r.familiarity})`
        );
      }
    }

    const pending = this.context.pendingProposals || [];
    if (pending.length) {
      console.log(`  Pending foundation proposals (${pending.length}) — need Critic review:`);
      for (const p of pending) {
        console.log(`    • [${p.id.slice(0, 8)}] Section "${p.content.section}": ${p.content.trigger.slice(0, 80)}...`);
      }
    }

    const awaiting = this.journal.awaitingRatification();
    if (awaiting.length) {
      console.log(`  Proposals awaiting human ratification (${awaiting.length}):`);
      for (const { proposal, review } of awaiting) {
        console.log(`    • [${proposal.id.slice(0, 8)}] "${proposal.content.proposedChange.slice(0, 80)}..."`);
      }
    }

    this.journal.write({
      sessionId: this.id,
      type: ENTRY_TYPES.CONTEXT,
      content: {
        sessionGoal:        this.sessionGoal,
        sessionIndex,
        foundationLoaded:   !!this.foundation,
        activeGoals:        activeGoals.map((g) => ({ id: g.id, description: g.description })),
        recalledSessions:   pastSessions,
        relationSnapshot:   relSnapshot,
      },
      tags: ["wake"],
    });

    return this;
  }

  // Record an agent-to-agent interaction.
  // Automatically detects repair arcs: rejection followed by approval from the same pair.
  recordInteraction(fromId, toId, { type, outcome = OUTCOMES.NEUTRAL, description = "", relatedTaskIds = [] }) {
    const key = pairKey(fromId, toId);

    // Detect conflict opening
    if (type === INTERACTION_TYPES.REJECTION) {
      this._pendingConflicts.add(key);
    }

    // Detect repair arc: a positive resolution after a pending conflict
    let repaired = false;
    if (
      this._pendingConflicts.has(key) &&
      (type === INTERACTION_TYPES.APPROVAL || outcome === OUTCOMES.POSITIVE) &&
      type !== INTERACTION_TYPES.REJECTION
    ) {
      repaired = true;
      this._pendingConflicts.delete(key);
      console.log(`  ✦ Repair arc: ${fromId} → ${toId} (conflict resolved this session)`);
    }

    const { relation, entry } = this.relations.record(fromId, toId, {
      type,
      outcome,
      description,
      relatedTaskIds,
      repaired,
    });

    this.journal.write({
      sessionId: this.id,
      type: ENTRY_TYPES.INTERACTION,
      content: {
        from:             fromId,
        to:               toId,
        interactionType:  type,
        outcome,
        description,
        repaired,
        proximityAfter:   relation.proximity(),
        trustAtoB:        relation.trust.ab,
        trustBtoA:        relation.trust.ba,
        familiarityAfter: relation.familiarity,
      },
      tags: [type, outcome, ...(repaired ? ["repair"] : [])],
      relatedTaskIds,
    });

    return { relation, entry, repaired };
  }

  recordTask(task, goalId = null) {
    if (goalId) {
      this.goals.update(goalId, (g) => g.linkTask(task.id));
    }
    return this.journal.write({
      sessionId: this.id,
      type: ENTRY_TYPES.TASK_RESULT,
      content: {
        taskId:     task.id,
        type:       task.type,
        capability: task.capability,
        status:     task.status,
        result:     task.result,
        error:      task.error,
        goalId,
      },
      tags: [task.status, task.capability],
      relatedTaskIds: [task.id],
    });
  }

  updateGoal(goalId, action, { note = "" } = {}) {
    const goal = this.goals.update(goalId, (g) => {
      if (action === "complete")   g.complete(note);
      else if (action === "block")    g.block(note);
      else if (action === "abandon")  g.abandon(note);
      else if (action === "reactivate") g.reactivate();
      else if (note) g.addNote(note);
    });

    this.journal.write({
      sessionId: this.id,
      type: ENTRY_TYPES.GOAL_UPDATE,
      content: { goalId, action, description: goal.description, note, status: goal.status },
      tags: ["goal", action],
    });

    return goal;
  }

  // Propose a change to team-foundation.md.
  // Does NOT modify the document — records intent for Critic review and human ratification.
  proposeFoundationChange(proposingAgentId, { section, trigger, currentText = "", proposedChange, rationale }) {
    const proposal = this.journal.write({
      sessionId: this.id,
      type: ENTRY_TYPES.PROPOSAL,
      content: {
        proposedBy:     proposingAgentId,
        section,
        trigger,
        currentText,
        proposedChange,
        rationale,
      },
      tags: ["proposal", "foundation", section.toLowerCase().replace(/\s+/g, "-")],
    });

    // Automatically record a consultation — proposing agent brings it to the Critic
    this.recordInteraction(proposingAgentId, "critic-1", {
      type:        INTERACTION_TYPES.CONSULTATION,
      outcome:     OUTCOMES.NEUTRAL,
      description: `Proposed foundation change in section "${section}" — awaiting Critic review`,
      relatedTaskIds: [],
    });

    return proposal;
  }

  // Record the Critic's verdict on a proposal.
  // outcome: "approved" | "rejected"
  reviewProposal(reviewerAgentId, proposalId, { outcome, notes }) {
    const review = this.journal.write({
      sessionId: this.id,
      type:      ENTRY_TYPES.PROPOSAL_REVIEW,
      content: {
        proposalId,
        reviewedBy:     reviewerAgentId,
        outcome,
        notes,
        humanRatified:  false, // set to true externally when a human applies the change
      },
      tags: ["proposal_review", outcome],
    });

    // Critic escalates approved proposals to Orchestrator for final sign-off
    if (outcome === "approved") {
      this.recordInteraction(reviewerAgentId, "orchestrator-1", {
        type:        INTERACTION_TYPES.HANDOFF,
        outcome:     OUTCOMES.POSITIVE,
        description: `Critic approved proposal [${proposalId.slice(0, 8)}] — escalating to Orchestrator for ratification`,
        relatedTaskIds: [],
      });
      console.log(`  [Proposal Review] APPROVED by ${reviewerAgentId} → awaiting human ratification`);
    } else {
      console.log(`  [Proposal Review] REJECTED by ${reviewerAgentId}: ${notes}`);
    }

    return review;
  }

  observe(content, { tags = [], relatedTaskIds = [] } = {}) {
    return this.journal.write({
      sessionId: this.id,
      type: ENTRY_TYPES.OBSERVATION,
      content,
      tags,
      relatedTaskIds,
    });
  }

  sleep({ headline, notes = "", stats = {} } = {}) {
    this.stoppedAt = new Date().toISOString();
    const goalSummary = this.goals.summary();
    const relSnapshot = this.relations.snapshot();

    this.journal.write({
      sessionId: this.id,
      type: ENTRY_TYPES.SUMMARY,
      content: {
        headline,
        notes,
        stats,
        goalSummary,
        relationSnapshot: relSnapshot,
        sessionGoal:      this.sessionGoal,
        duration:         this._duration(),
      },
      tags: ["sleep", "summary"],
    });

    console.log(`\n[Session ${this.id.slice(0, 8)}] Sleeping`);
    console.log(`  "${headline}"`);
    console.log(`  Task stats:`, stats);
    console.log(`  Goals:`, goalSummary);
    if (relSnapshot.length) {
      console.log(`  Relationships at sleep:`);
      for (const r of relSnapshot) {
        console.log(
          `    ${r.pair} — ${r.label}` +
          `  (proximity ${r.proximity}` +
          `  | A→B ${r.trustAtoB}  B→A ${r.trustBtoA}` +
          `  | fam ${r.familiarity})`
        );
      }
    }
    console.log(`  Journal size: ${this.journal.size()} entries total`);

    return this;
  }

  _duration() {
    if (!this.startedAt || !this.stoppedAt) return null;
    const ms = new Date(this.stoppedAt) - new Date(this.startedAt);
    return `${(ms / 1000).toFixed(2)}s`;
  }
}

module.exports = { Session, INTERACTION_TYPES, OUTCOMES };
