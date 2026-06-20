const fs = require("fs");

const INTERACTION_TYPES = Object.freeze({
  CODE_REVIEW:   "code_review",
  APPROVAL:      "approval",
  REJECTION:     "rejection",
  HANDOFF:       "handoff",
  CONSULTATION:  "consultation",
  COLLABORATION: "collaboration",
  WITNESS:       "witness",
});

const OUTCOMES = Object.freeze({
  POSITIVE: "positive",
  NEGATIVE: "negative",
  NEUTRAL:  "neutral",
});

const TRUST_DELTA = {
  [OUTCOMES.POSITIVE]: +4,
  [OUTCOMES.NEUTRAL]:   0,
  [OUTCOMES.NEGATIVE]: -2,
};

const REPAIR_BONUS = 6; // extra trust applied when a conflict resolves in the same session

const FAMILIARITY_DELTA = {
  [INTERACTION_TYPES.CODE_REVIEW]:   4,
  [INTERACTION_TYPES.APPROVAL]:      3,
  [INTERACTION_TYPES.REJECTION]:     3,
  [INTERACTION_TYPES.HANDOFF]:       2,
  [INTERACTION_TYPES.CONSULTATION]:  2,
  [INTERACTION_TYPES.COLLABORATION]: 5,
  [INTERACTION_TYPES.WITNESS]:       3,
};

const TRUST_DECAY_RATE    = 0.05; // trust drifts 5% toward 50 per missed session (compounding)
const FAMILIARITY_DECAY   = 0.5;  // familiarity points lost per missed session (linear)

const SURPRISE_MAX_N      = 10; // directionCount at which surprise weight reaches 1.0
const SURPRISE_RAMP_START = 3;  // directionCount at or below which weight is zero (cold-start)

function pairKey(a, b) {
  return [a, b].sort().join("::");
}

// Cold-start ramp: k=0 for n<=3, linear to k=1.0 at n=10
function surpriseWeight(n) {
  if (n <= SURPRISE_RAMP_START) return 0;
  if (n >= SURPRISE_MAX_N) return 1.0;
  return (n - SURPRISE_RAMP_START) / (SURPRISE_MAX_N - SURPRISE_RAMP_START);
}

class Relation {
  constructor(agentA, agentB) {
    this.key     = pairKey(agentA, agentB);
    this.agents  = [agentA, agentB].sort();
    this.familiarity = 0;

    // Directional trust: ab = agents[0]→agents[1], ba = agents[1]→agents[0]
    this.trust = { ab: 50, ba: 50 };

    this.interactionCount       = 0;
    // Per-direction interaction counts for surprise weight ramp (not decayed)
    this.directionCount         = { ab: 0, ba: 0 };
    this.history                = []; // capped at last 20
    this.lastInteractedSession  = null;
    this.updatedAt              = null;
  }

  _trustKey(fromId) {
    return fromId === this.agents[0] ? "ab" : "ba";
  }

  // Trust that agentId has in the other agent
  trustFrom(agentId) {
    return this.trust[this._trustKey(agentId)];
  }

  record({ from, type, outcome = OUTCOMES.NEUTRAL, description = "", relatedTaskIds = [], repaired = false, sessionIndex = null }) {
    const baseDelta     = TRUST_DELTA[outcome] ?? 0;
    const effectiveBase = repaired ? baseDelta + REPAIR_BONUS : baseDelta;
    const familiarDelta = FAMILIARITY_DELTA[type] ?? 2;

    const tKey = this._trustKey(from);
    const P    = this.trust[tKey] / 100;
    const k    = surpriseWeight(this.directionCount[tKey]);

    // Branch on sign of effectiveBase (not outcome label) so repaired-negative
    // interactions (effectiveBase > 0) use the positive surprise branch correctly.
    let surpriseFactor;
    if (outcome === OUTCOMES.NEUTRAL) {
      surpriseFactor = 0;
    } else if (effectiveBase >= 0) {
      surpriseFactor = 1 - P;
    } else {
      surpriseFactor = P;
    }

    const urgencyFactor = 1 + Math.abs(this.trust[tKey] - 50) / 50;
    let trustDelta = effectiveBase * urgencyFactor * (1 + k * surpriseFactor);
    trustDelta = Math.sign(trustDelta) * Math.min(Math.abs(trustDelta), 15);  // hard cap ±15
    this.trust[tKey] = Math.max(0, Math.min(100, this.trust[tKey] + trustDelta));
    this.directionCount[tKey]++;

    this.familiarity         += familiarDelta;
    this.interactionCount++;
    this.lastInteractedSession = sessionIndex;
    this.updatedAt             = new Date().toISOString();

    const entry = {
      from,
      type,
      outcome,
      description,
      relatedTaskIds,
      repaired,
      trustAfter:      { ...this.trust },
      familiarityAfter: this.familiarity,
      at: new Date().toISOString(),
    };
    this.history.push(entry);
    if (this.history.length > 20) this.history.shift();
    return entry;
  }

  // Decay called when sessions have passed without this pair interacting
  applyDecay(sessionsMissed) {
    if (sessionsMissed <= 0) return;
    this.familiarity = Math.max(0, this.familiarity - sessionsMissed * FAMILIARITY_DECAY);
    // Compounding drift toward neutral (50)
    const rate = 1 - Math.pow(1 - TRUST_DECAY_RATE, sessionsMissed);
    this.trust.ab = Math.round(this.trust.ab + (50 - this.trust.ab) * rate);
    this.trust.ba = Math.round(this.trust.ba + (50 - this.trust.ba) * rate);
    this.updatedAt = new Date().toISOString();
  }

  // Composite 0–100 score using average of both trust directions
  proximity() {
    const famScore  = Math.min(100, this.familiarity * 2);
    const avgTrust  = (this.trust.ab + this.trust.ba) / 2;
    return Math.round(famScore * 0.35 + avgTrust * 0.65);
  }

  label() {
    const p = this.proximity();
    if (p >= 80) return "close";
    if (p >= 60) return "familiar";
    if (p >= 40) return "acquainted";
    return "distant";
  }
}

class RelationGraph {
  constructor(filePath) {
    this.filePath      = filePath;
    this._relations    = new Map();
    this._sessionIndex = 0;
    this._load();
  }

  // Call once per session on wake — increments the session counter and decays stale pairs.
  // Applies exactly 1 session of decay per call for pairs that haven't interacted recently.
  // The original formula (missed = index - lastInteracted - 1) double-counted because it
  // grew by 1 each wake even though prior wakes had already applied earlier decay.
  advanceSession() {
    this._sessionIndex++;
    for (const rel of this._relations.values()) {
      if (rel.lastInteractedSession === null) continue;
      // Stale = no interaction in the session immediately preceding this one
      if (this._sessionIndex > rel.lastInteractedSession + 1) {
        rel.applyDecay(1);
      }
    }
    this._save();
    return this._sessionIndex;
  }

  get(agentA, agentB) {
    const key = pairKey(agentA, agentB);
    if (!this._relations.has(key)) {
      this._relations.set(key, new Relation(agentA, agentB));
    }
    return this._relations.get(key);
  }

  // agentA is the initiator (from); agentB is the recipient (to)
  record(agentA, agentB, interaction) {
    const rel   = this.get(agentA, agentB);
    const entry = rel.record({ ...interaction, from: agentA, sessionIndex: this._sessionIndex });
    this._save();
    return { relation: rel, entry };
  }

  peersOf(agentId) {
    return [...this._relations.values()]
      .filter((r) => r.agents.includes(agentId))
      .sort((a, b) => b.proximity() - a.proximity());
  }

  snapshot() {
    return [...this._relations.values()].map((r) => ({
      pair:            `${r.agents[0]} ↔ ${r.agents[1]}`,
      trustAtoB:       Math.round(r.trust.ab),
      trustBtoA:       Math.round(r.trust.ba),
      familiarity:     r.familiarity,
      proximity:       r.proximity(),
      label:           r.label(),
      interactions:    r.interactionCount,
      directionCounts: { ...r.directionCount },
      surpriseWeights: { ab: surpriseWeight(r.directionCount.ab), ba: surpriseWeight(r.directionCount.ba) },
    }));
  }

  _save() {
    fs.writeFileSync(
      this.filePath,
      JSON.stringify({ sessionIndex: this._sessionIndex, relations: [...this._relations.values()] }, null, 2)
    );
  }

  _load() {
    if (!fs.existsSync(this.filePath)) return;
    const raw = fs.readFileSync(this.filePath, "utf8").trim();
    if (!raw) return;
    const { sessionIndex = 0, relations = [] } = JSON.parse(raw);
    this._sessionIndex = sessionIndex;
    for (const plain of relations) {
      const rel = Object.assign(new Relation(...plain.agents), plain);
      this._relations.set(rel.key, rel);
    }
  }
}

module.exports = { RelationGraph, INTERACTION_TYPES, OUTCOMES };
