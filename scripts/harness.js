#!/usr/bin/env node
/**
 * harness.js — Trust construct validation harness
 *
 * Owner: exe-1
 * Session: 18
 * Spec: docs/trust-construct-validation.md Section 6
 *
 * Commands:
 *   run-trial    --pair <A>::<B> --condition <name> --n <int> [--seed <int>] [--dry-run] [--journal-dir <path>]
 *   run-study    --config <file.json> [--parallel] [--out-dir <path>] [--dry-run]
 *   export-icc   --aggregate <file.json> [--metric trustAtoB|trustBtoA|proximity]
 *   list-conditions
 *   reset-harness --run-dir <path>
 *
 * Isolation guarantee: canonical journal/entries/ is NEVER touched.
 * Each trial writes its own isolated RelationGraph to scripts/harness-runs/<studyId>/<trialId>/
 */

"use strict";

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const { RelationGraph, INTERACTION_TYPES, OUTCOMES } = require("../team/relations");

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT      = path.join(__dirname, "..");
const CANONICAL_ENTRIES = path.join(PROJECT_ROOT, "journal", "entries");
const HARNESS_RUNS_DIR  = path.join(__dirname, "harness-runs");
const GITIGNORE_PATH    = path.join(PROJECT_ROOT, ".gitignore");

// ── Condition definitions ─────────────────────────────────────────────────────
//
// Each condition is an array of step descriptors.
// For non-asymmetric conditions, each step has:
//   { from: "A"|"B", outcome: "positive"|"negative"|"neutral", type }
// For asymmetric_diverge, steps alternate A→B and B→A with different outcome series.
//
// Outcome sequences from spec Section 6.2:
//   positive_heavy:   PPPN₀PPRPPP  (8P+1N+1R, N=10)
//   negative_heavy:   RRN₀RRPRN₀R  (7R+2N+1P) — spec shows 9 chars; padded to 10 with trailing R
//   alternating:      PRPRPRPRPR   (5P+5R)
//   repair_arc:       RRPPPPPPPP   (2R+8P per ordered sequence in spec; narrative says 3R+7P — spec table ordered sequence governs)
//   baseline_flat:    NNNNNNNNNN   (10N)
//   asymmetric_diverge: A→B uses positive_heavy sequence; B→A uses negative_heavy sequence, interleaved

const P = OUTCOMES.POSITIVE;
const N = OUTCOMES.NEUTRAL;
const R = OUTCOMES.NEGATIVE;

// Default interaction type for harness trials (handoff — common, carries full trust signal)
const DEFAULT_TYPE = INTERACTION_TYPES.HANDOFF;

// Repair arc detection: a negative followed later by a positive from the same direction
// triggers repair. The harness tracks pending conflicts per-direction manually.

const CONDITIONS = {
  positive_heavy: {
    description: "8P + 1N + 1R — ordered: P P P N P P R P P P",
    mix: "8P+1N+1R",
    sequence: [P, P, P, N, P, P, R, P, P, P],
    type: "symmetric",   // A→B direction only
  },
  negative_heavy: {
    description: "7R + 2N + 1P — ordered: R R N R R P R N R R",
    mix: "7R+2N+1P",
    sequence: [R, R, N, R, R, P, R, N, R, R],
    type: "symmetric",   // A→B direction only
  },
  alternating: {
    description: "5P + 5R strictly alternating — P R P R P R P R P R (repair arc bonus suppressed; volatility is intrinsic not relational repair)",
    mix: "5P+5R",
    sequence: [P, R, P, R, P, R, P, R, P, R],
    type: "symmetric",
    skipRepairArcs: true,   // Each P-after-R is not a repair event; it's genuine alternation
  },
  repair_arc: {
    description: "2R then 8P — tests repair bonus inflection (spec ordered: R R P P P P P P P P)",
    mix: "2R+8P",
    sequence: [R, R, P, P, P, P, P, P, P, P],
    type: "symmetric",
  },
  baseline_flat: {
    description: "10N — consultations only; trust unchanged, familiarity accumulates",
    mix: "10N",
    sequence: [N, N, N, N, N, N, N, N, N, N],
    type: "symmetric",
  },
  asymmetric_diverge: {
    description: "A→B: 8P+1N+1R; B→A: 7R+2N+1P — interleaved, validates directional independence",
    mix: "A→B: 8P+1N+1R / B→A: 7R+2N+1P",
    seqAB: [P, P, P, N, P, P, R, P, P, P],   // same as positive_heavy
    seqBA: [R, R, N, R, R, P, R, N, R, R],   // same as negative_heavy
    type: "asymmetric",
  },
};

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

// ── I/O helpers ───────────────────────────────────────────────────────────────

function out(data) {
  process.stdout.write(JSON.stringify({ ok: true, ...data }, null, 2) + "\n");
}

function fail(msg) {
  process.stderr.write(JSON.stringify({ ok: false, error: msg }) + "\n");
  process.exit(1);
}

// ── .gitignore management ─────────────────────────────────────────────────────

function ensureGitignoreEntry() {
  const entry = "scripts/harness-runs/";
  let content = "";
  if (fs.existsSync(GITIGNORE_PATH)) {
    content = fs.readFileSync(GITIGNORE_PATH, "utf8");
  }
  if (!content.includes(entry)) {
    const sep = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(GITIGNORE_PATH, content + sep + entry + "\n");
  }
}

// ── Canonical path guard ──────────────────────────────────────────────────────

function isInsideCanonical(targetPath) {
  const resolved    = path.resolve(targetPath);
  const canonicalR  = path.resolve(CANONICAL_ENTRIES);
  return resolved === canonicalR || resolved.startsWith(canonicalR + path.sep);
}

// ── Repair arc detection ──────────────────────────────────────────────────────
//
// A repair arc is: a negative interaction from X→Y, followed later by a positive
// from X→Y in the same "session" (here: same trial). We track pending conflicts
// per direction as a simple boolean flag. The first negative opens the conflict;
// the first positive after that closes it with the repair bonus.
//
// The RelationGraph.record() interface accepts `repaired` as a field in the
// interaction descriptor. We manage the flag here and pass it in.

// ── Isolated RelationGraph factory ────────────────────────────────────────────
//
// Creates a fresh RelationGraph backed by a temp file in the trial directory.
// Does NOT touch canonical journal/entries/.

function makeIsolatedGraph(trialDir) {
  fs.mkdirSync(trialDir, { recursive: true });
  const relPath = path.join(trialDir, "relations.json");
  // Start empty (no prior sessions, no decay)
  fs.writeFileSync(relPath, "");
  return new RelationGraph(relPath);
}

// ── Seeded isolated graph factory ─────────────────────────────────────────────
//
// Like makeIsolatedGraph, but pre-seeds the pair's trust values before
// any interactions run. Uses the same JSON format as RelationGraph._save().
// familiarity and directionCount start at 0 (cold-start); only trust is seeded.

function seedIsolatedGraph(trialDir, agentA, agentB, startTrustAB, startTrustBA) {
  fs.mkdirSync(trialDir, { recursive: true });
  const relPath = path.join(trialDir, "relations.json");

  // Determine canonical sorted order (matches pairKey / Relation.agents)
  const sorted = [agentA, agentB].sort();

  const seededRelation = {
    key:                sorted.join("::"),
    agents:             sorted,
    familiarity:        0,
    trust:              { ab: startTrustAB, ba: startTrustBA },
    interactionCount:   0,
    directionCount:     { ab: 0, ba: 0 },
    history:            [],
    lastInteractedSession: null,
    updatedAt:          null,
  };

  const data = {
    sessionIndex: 0,
    relations:    [seededRelation],
  };

  fs.writeFileSync(relPath, JSON.stringify(data, null, 2));
  return new RelationGraph(relPath);
}

// ── Seeded PRNG (mulberry32) ──────────────────────────────────────────────────
// Used only for future extension (seed is recorded in output for reproducibility).
// Current conditions are deterministic sequences, so the seed is stored but not
// used for outcome generation — reserved for stochastic extensions.

function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ── Analytical trust delta (dry-run mode) ────────────────────────────────────
//
// Computes the expected trust trajectory without writing any files.
// Uses the same formula as Relation.record() but operates on a plain object.

function analyticalTrustDelta(sequence, startTrust, startDirCount, direction, skipRepairArcs = false) {
  const REPAIR_BONUS = 6;
  const SURPRISE_RAMP_START = 3;
  const SURPRISE_MAX_N = 10;

  function surpriseWeight(n) {
    if (n <= SURPRISE_RAMP_START) return 0;
    if (n >= SURPRISE_MAX_N) return 1.0;
    return (n - SURPRISE_RAMP_START) / (SURPRISE_MAX_N - SURPRISE_RAMP_START);
  }

  let trust    = startTrust;
  let dirCount = startDirCount;
  let pendingConflict = false;
  const steps  = [];

  for (let i = 0; i < sequence.length; i++) {
    const outcome = sequence[i];
    const TRUST_DELTA = { positive: +4, neutral: 0, negative: -2 };

    let baseDelta = TRUST_DELTA[outcome] ?? 0;
    let repaired  = false;

    // Repair arc tracking (suppressed for conditions where volatility is intrinsic)
    if (!skipRepairArcs) {
      if (outcome === OUTCOMES.NEGATIVE) {
        pendingConflict = true;
      } else if (outcome === OUTCOMES.POSITIVE && pendingConflict) {
        repaired = true;
        pendingConflict = false;
      }
    }

    const effectiveBase = repaired ? baseDelta + REPAIR_BONUS : baseDelta;
    const P = trust / 100;
    const k = surpriseWeight(dirCount);

    let surpriseFactor;
    if (outcome === OUTCOMES.NEUTRAL) {
      surpriseFactor = 0;
    } else if (effectiveBase >= 0) {
      surpriseFactor = 1 - P;
    } else {
      surpriseFactor = P;
    }

    const urgencyFactor = 1 + Math.abs(trust - 50) / 50;
    let trustDelta = effectiveBase * urgencyFactor * (1 + k * surpriseFactor);
    trustDelta = Math.sign(trustDelta) * Math.min(Math.abs(trustDelta), 15);  // hard cap ±15
    trust = Math.max(0, Math.min(100, trust + trustDelta));
    dirCount++;

    steps.push({
      step: i + 1,
      outcome,
      direction,
      repaired,
      trustAfterStep: Math.round(trust * 100) / 100,
    });
  }

  return { finalTrust: trust, steps };
}

// ── Trial execution ───────────────────────────────────────────────────────────

function runTrial({ pair, condition, n, seed, dryRun, journalDir, studyId, trialId, startTrustAB, startTrustBA }) {
  const condDef = CONDITIONS[condition];
  if (!condDef) fail(`Unknown condition: ${condition}. Use list-conditions to see available conditions.`);

  const parts = pair.split("::");
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
    fail(`--pair must be in format A::B (got: ${pair})`);
  }
  const [agentA, agentB] = parts.map(p => p.trim());

  if (!trialId) trialId = crypto.randomUUID();
  if (!studyId) studyId = "standalone";
  if (seed === undefined || seed === null) seed = Date.now();

  const effectiveN = parseInt(n, 10);
  if (isNaN(effectiveN) || effectiveN < 1) fail("--n must be a positive integer");

  // Determine the run directory
  const runDir = journalDir
    ? path.resolve(journalDir)
    : path.join(HARNESS_RUNS_DIR, studyId, trialId);

  // Safety: never write inside canonical entries
  if (isInsideCanonical(runDir)) {
    fail(`Refusing to write trial data inside canonical journal path: ${runDir}`);
  }

  // Ensure .gitignore is updated on first harness use
  ensureGitignoreEntry();

  // ── DRY RUN ──────────────────────────────────────────────────────────────
  if (dryRun) {
    return dryRunTrial({ agentA, agentB, condition, condDef, n: effectiveN, seed, pair, trialId, studyId, runDir, startTrustAB, startTrustBA });
  }

  // ── LIVE RUN ─────────────────────────────────────────────────────────────
  const graph = (startTrustAB !== undefined || startTrustBA !== undefined)
    ? seedIsolatedGraph(runDir, agentA, agentB, startTrustAB !== undefined ? startTrustAB : 50, startTrustBA !== undefined ? startTrustBA : 50)
    : makeIsolatedGraph(runDir);

  // Snapshot "before" trust values
  const relBefore = graph.get(agentA, agentB);
  const trustAtoB_before = relBefore.trust.ab;
  const trustBtoA_before = relBefore.trust.ba;

  const interactions = [];

  // Pending conflict trackers per direction
  const pendingConflict = { ab: false, ba: false };

  function dirKey(from) {
    const sorted = [agentA, agentB].sort();
    return from === sorted[0] ? "ab" : "ba";
  }

  function recordStep(step, from, to, outcome, type) {
    const rel = graph.get(from, to);
    const dk  = dirKey(from);

    let repaired = false;
    if (!condDef.skipRepairArcs) {
      if (outcome === OUTCOMES.NEGATIVE) {
        pendingConflict[dk] = true;
      } else if (outcome === OUTCOMES.POSITIVE && pendingConflict[dk]) {
        repaired = true;
        pendingConflict[dk] = false;
      }
    }

    graph.record(from, to, { type, outcome, repaired, description: `harness step ${step}` });

    const relAfter = graph.get(from, to);
    const trustAfterStep = from === [agentA, agentB].sort()[0]
      ? relAfter.trust.ab
      : relAfter.trust.ba;

    interactions.push({
      step,
      from,
      to,
      type,
      outcome,
      trustAfterStep: Math.round(trustAfterStep * 100) / 100,
      repaired,
    });
  }

  if (condDef.type === "symmetric") {
    const seq = condDef.sequence.slice(0, effectiveN);
    for (let i = 0; i < seq.length; i++) {
      recordStep(i + 1, agentA, agentB, seq[i], DEFAULT_TYPE);
    }
  } else if (condDef.type === "asymmetric") {
    // Interleave: even steps (0-indexed) are A→B, odd steps are B→A
    // Each direction accumulates effectiveN interactions total
    const seqAB = condDef.seqAB.slice(0, effectiveN);
    const seqBA = condDef.seqBA.slice(0, effectiveN);
    let stepNum = 1;
    for (let i = 0; i < Math.max(seqAB.length, seqBA.length); i++) {
      if (i < seqAB.length) {
        recordStep(stepNum++, agentA, agentB, seqAB[i], DEFAULT_TYPE);
      }
      if (i < seqBA.length) {
        recordStep(stepNum++, agentB, agentA, seqBA[i], DEFAULT_TYPE);
      }
    }
  }

  const relAfter = graph.get(agentA, agentB);
  const trustAtoB_after = relAfter.trust.ab;
  const trustBtoA_after = relAfter.trust.ba;

  const result = {
    trialId,
    studyId,
    pair,
    condition,
    seed,
    n: effectiveN,
    trustAtoB_before: Math.round(trustAtoB_before * 100) / 100,
    trustAtoB_after:  Math.round(trustAtoB_after  * 100) / 100,
    trustBtoA_before: Math.round(trustBtoA_before * 100) / 100,
    trustBtoA_after:  Math.round(trustBtoA_after  * 100) / 100,
    interactions,
    deltaAtoB: Math.round((trustAtoB_after - trustAtoB_before) * 100) / 100,
    deltaBtoA: Math.round((trustBtoA_after - trustBtoA_before) * 100) / 100,
  };

  // Write trial result to run directory
  const resultPath = path.join(runDir, "trial-result.json");
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));

  return result;
}

// ── Dry-run trial ─────────────────────────────────────────────────────────────

function dryRunTrial({ agentA, agentB, condition, condDef, n, seed, pair, trialId, studyId, runDir, startTrustAB, startTrustBA }) {
  const startTrustAtoB = startTrustAB !== undefined ? startTrustAB : 50;
  const startTrustBtoA = startTrustBA !== undefined ? startTrustBA : 50;

  let analyticsAB, analyticsBA;

  const skipRepairArcs = condDef.skipRepairArcs || false;
  if (condDef.type === "symmetric") {
    analyticsAB = analyticalTrustDelta(condDef.sequence.slice(0, n), startTrustAtoB, 0, `${agentA}→${agentB}`, skipRepairArcs);
    analyticsBA = { finalTrust: startTrustBtoA, steps: [] };
  } else {
    analyticsAB = analyticalTrustDelta(condDef.seqAB.slice(0, n), startTrustAtoB, 0, `${agentA}→${agentB}`, skipRepairArcs);
    analyticsBA = analyticalTrustDelta(condDef.seqBA.slice(0, n), startTrustBtoA, 0, `${agentB}→${agentA}`, skipRepairArcs);
  }

  const result = {
    dryRun: true,
    trialId,
    studyId,
    pair,
    condition,
    seed,
    n,
    runDir,
    trustAtoB_before: startTrustAtoB,
    trustAtoB_after:  Math.round(analyticsAB.finalTrust * 100) / 100,
    trustBtoA_before: startTrustBtoA,
    trustBtoA_after:  Math.round(analyticsBA.finalTrust * 100) / 100,
    deltaAtoB: Math.round((analyticsAB.finalTrust - startTrustAtoB) * 100) / 100,
    deltaBtoA: Math.round((analyticsBA.finalTrust - startTrustBtoA) * 100) / 100,
    analyticsAtoB: analyticsAB.steps,
    analyticsBtoA: analyticsBA.steps,
    wouldWrite: [
      `${runDir}/relations.json`,
      `${runDir}/trial-result.json`,
    ],
    note: "Dry run — no files written, no canonical state touched",
  };

  return result;
}

// ── Study aggregation ─────────────────────────────────────────────────────────

function buildAggregate(studyId, trials) {
  const summaryByCondition = {};

  for (const trial of trials) {
    const cond = trial.condition;
    if (!summaryByCondition[cond]) {
      summaryByCondition[cond] = {
        trialCount: 0,
        meanDeltaAtoB: 0,
        meanDeltaBtoA: 0,
        meanTrustAtoB_after: 0,
        meanTrustBtoA_after: 0,
      };
    }
    const s = summaryByCondition[cond];
    s.trialCount++;
    s.meanDeltaAtoB        += trial.deltaAtoB;
    s.meanDeltaBtoA        += trial.deltaBtoA;
    s.meanTrustAtoB_after  += trial.trustAtoB_after;
    s.meanTrustBtoA_after  += trial.trustBtoA_after;
  }

  for (const cond of Object.keys(summaryByCondition)) {
    const s = summaryByCondition[cond];
    const k = s.trialCount;
    s.meanDeltaAtoB        = Math.round((s.meanDeltaAtoB        / k) * 100) / 100;
    s.meanDeltaBtoA        = Math.round((s.meanDeltaBtoA        / k) * 100) / 100;
    s.meanTrustAtoB_after  = Math.round((s.meanTrustAtoB_after  / k) * 100) / 100;
    s.meanTrustBtoA_after  = Math.round((s.meanTrustBtoA_after  / k) * 100) / 100;
  }

  // ICC-ready table: one row per directional pair × trial
  // rater = directional pair (e.g. "agent-a→agent-b")
  // subject = condition::seed
  // score = trust score for that direction
  const iccReadyTable = [];
  for (const trial of trials) {
    const [a, b] = trial.pair.split("::");
    iccReadyTable.push({
      rater:   `${a}→${b}`,
      subject: `${trial.condition}::${trial.seed}`,
      score:   trial.trustAtoB_after,
    });
    iccReadyTable.push({
      rater:   `${b}→${a}`,
      subject: `${trial.condition}::${trial.seed}`,
      score:   trial.trustBtoA_after,
    });
  }

  return {
    studyId,
    trials,
    summaryByCondition,
    iccReadyTable,
  };
}

// ── Commands ──────────────────────────────────────────────────────────────────

const cmd = {

  "list-conditions"() {
    const defs = Object.entries(CONDITIONS).map(([name, def]) => ({
      name,
      description: def.description,
      mix:         def.mix,
      type:        def.type,
      sequence:    def.type === "asymmetric"
        ? { AtoB: def.seqAB, BtoA: def.seqBA }
        : def.sequence,
    }));
    out({ conditions: defs });
  },

  "run-trial"(args) {
    if (!args.pair)      fail("--pair required (format: A::B)");
    if (!args.condition) fail("--condition required");
    if (!args.n)         fail("--n required (number of interactions)");

    const seed = args.seed !== undefined ? parseInt(args.seed, 10) : Date.now();

    const startTrustAB = args["start-trust-ab"] !== undefined ? parseFloat(args["start-trust-ab"]) : undefined;
    const startTrustBA = args["start-trust-ba"] !== undefined ? parseFloat(args["start-trust-ba"]) : undefined;

    if (startTrustAB !== undefined && (isNaN(startTrustAB) || startTrustAB < 0 || startTrustAB > 100)) {
      fail("--start-trust-ab must be a number between 0 and 100");
    }
    if (startTrustBA !== undefined && (isNaN(startTrustBA) || startTrustBA < 0 || startTrustBA > 100)) {
      fail("--start-trust-ba must be a number between 0 and 100");
    }

    const result = runTrial({
      pair:         args.pair,
      condition:    args.condition,
      n:            args.n,
      seed,
      dryRun:       !!args["dry-run"],
      journalDir:   args["journal-dir"] || null,
      studyId:      args["study-id"]    || "standalone",
      trialId:      args["trial-id"]    || crypto.randomUUID(),
      startTrustAB,
      startTrustBA,
    });

    out({ trial: result });
  },

  "run-study"(args) {
    if (!args.config) fail("--config <file.json> required");

    const configPath = path.resolve(args.config);
    if (!fs.existsSync(configPath)) fail(`Config file not found: ${configPath}`);

    let config;
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (e) {
      fail(`Failed to parse config JSON: ${e.message}`);
    }

    const { studyId, trials: trialConfigs } = config;
    if (!studyId)      fail("Config must have a studyId field");
    if (!trialConfigs || !Array.isArray(trialConfigs)) fail("Config must have a trials array");

    const outDir = args["out-dir"]
      ? path.resolve(args["out-dir"])
      : path.join(HARNESS_RUNS_DIR, studyId);

    // Safety check
    if (isInsideCanonical(outDir)) {
      fail(`Refusing to write study output inside canonical journal path: ${outDir}`);
    }

    ensureGitignoreEntry();
    fs.mkdirSync(outDir, { recursive: true });

    const dryRun = !!args["dry-run"];
    const useCurrentTrust = !!args["use-current-trust"];
    const completedTrials = [];

    // Load canonical relations.json once if --use-current-trust is set
    let canonicalRelations = null;
    if (useCurrentTrust) {
      const canonicalRelPath = path.join(CANONICAL_ENTRIES, "relations.json");
      if (!fs.existsSync(canonicalRelPath)) {
        process.stderr.write("[harness] Warning: --use-current-trust specified but canonical relations.json not found; using 50/50 for all pairs\n");
      } else {
        try {
          const raw = fs.readFileSync(canonicalRelPath, "utf8").trim();
          if (raw) {
            const parsed = JSON.parse(raw);
            canonicalRelations = parsed.relations || [];
          }
        } catch (e) {
          process.stderr.write(`[harness] Warning: failed to parse canonical relations.json (${e.message}); using 50/50 for all pairs\n`);
        }
      }
    }

    function lookupCurrentTrust(pair) {
      if (!canonicalRelations) return { startTrustAB: undefined, startTrustBA: undefined };
      const [a, b] = pair.split("::").map(p => p.trim());
      const sorted = [a, b].sort();
      const key = sorted.join("::");
      const rel = canonicalRelations.find(r => r.key === key);
      if (!rel) {
        process.stderr.write(`[harness] Warning: pair ${pair} not found in canonical relations.json; using 50/50\n`);
        return { startTrustAB: undefined, startTrustBA: undefined };
      }
      // trust.ab = sorted[0]→sorted[1], trust.ba = sorted[1]→sorted[0]
      // We need: startTrustAB = trust from a→b direction
      // If a === sorted[0], ab is a→b; otherwise ba is a→b
      const startTrustAB = a === sorted[0] ? rel.trust.ab : rel.trust.ba;
      const startTrustBA = a === sorted[0] ? rel.trust.ba : rel.trust.ab;
      return { startTrustAB, startTrustBA };
    }

    // Note: --parallel flag is accepted but trials run sequentially here.
    // True parallelism requires worker_threads; deferred for now (no new deps constraint).
    if (args.parallel) {
      process.stderr.write("[harness] Warning: --parallel flag noted; running sequentially (worker_threads not wired yet)\n");
    }

    for (const tc of trialConfigs) {
      const trialId = tc.trialId || crypto.randomUUID();
      const seed    = tc.seed    !== undefined ? parseInt(tc.seed, 10) : Date.now();

      const { startTrustAB, startTrustBA } = useCurrentTrust
        ? lookupCurrentTrust(tc.pair)
        : { startTrustAB: undefined, startTrustBA: undefined };

      try {
        const result = runTrial({
          pair:         tc.pair,
          condition:    tc.condition,
          n:            tc.n || 10,
          seed,
          dryRun,
          journalDir:   tc.journalDir || null,
          studyId,
          trialId,
          startTrustAB,
          startTrustBA,
        });
        completedTrials.push(result);
      } catch (err) {
        process.stderr.write(`[harness] Trial ${trialId} failed: ${err.message}\n`);
        completedTrials.push({
          trialId, studyId,
          pair:      tc.pair,
          condition: tc.condition,
          error:     err.message,
          failed:    true,
        });
      }
    }

    const aggregate = buildAggregate(studyId, completedTrials.filter(t => !t.failed));

    // Write aggregate result
    const aggregatePath = path.join(outDir, "aggregate.json");
    if (!dryRun) {
      fs.writeFileSync(aggregatePath, JSON.stringify(aggregate, null, 2));
    }

    out({
      studyId,
      dryRun,
      trialCount:    completedTrials.length,
      failedCount:   completedTrials.filter(t => t.failed).length,
      aggregatePath: dryRun ? null : aggregatePath,
      aggregate,
    });
  },

  "export-icc"(args) {
    if (!args.aggregate) fail("--aggregate <file.json> required");

    const aggPath = path.resolve(args.aggregate);
    if (!fs.existsSync(aggPath)) fail(`Aggregate file not found: ${aggPath}`);

    let aggregate;
    try {
      aggregate = JSON.parse(fs.readFileSync(aggPath, "utf8"));
    } catch (e) {
      fail(`Failed to parse aggregate JSON: ${e.message}`);
    }

    const metric = args.metric || "trustAtoB";
    const validMetrics = ["trustAtoB", "trustBtoA", "proximity"];
    if (!validMetrics.includes(metric)) {
      fail(`--metric must be one of: ${validMetrics.join(", ")}`);
    }

    // Build ICC table from trials in the aggregate
    // If metric is proximity, score = average of trustAtoB_after and trustBtoA_after
    // If metric is trustAtoB or trustBtoA, use the specified direction
    const trials = aggregate.trials || [];
    const iccTable = [];

    for (const trial of trials) {
      if (trial.failed) continue;
      const [a, b] = trial.pair.split("::");

      if (metric === "trustAtoB") {
        iccTable.push({
          rater:   `${a}→${b}`,
          subject: `${trial.condition}::${trial.seed}`,
          score:   trial.trustAtoB_after,
        });
      } else if (metric === "trustBtoA") {
        iccTable.push({
          rater:   `${b}→${a}`,
          subject: `${trial.condition}::${trial.seed}`,
          score:   trial.trustBtoA_after,
        });
      } else if (metric === "proximity") {
        // Proximity = familiarity-weighted composite; approximate from trust scores
        // (exact familiarity not in aggregate output; use trust average as proxy)
        const avgTrust = (trial.trustAtoB_after + trial.trustBtoA_after) / 2;
        iccTable.push({
          rater:   `${a}↔${b}`,
          subject: `${trial.condition}::${trial.seed}`,
          score:   Math.round(avgTrust * 100) / 100,
          note:    "proximity approximated from trust average (familiarity absent from aggregate; actual formula weights familiarity 0.35 — after 10 interactions approximation underestimates by ~10–17 points at high trust)",
        });
      }
    }

    // Emit CSV-friendly format alongside JSON for R/Python compatibility
    const csvLines = ["rater,subject,score"];
    for (const row of iccTable) {
      csvLines.push(`"${row.rater}","${row.subject}",${row.score}`);
    }

    out({
      studyId: aggregate.studyId,
      metric,
      iccReadyTable: iccTable,
      csv: csvLines.join("\n"),
      rowCount: iccTable.length,
    });
  },

  "reset-harness"(args) {
    if (!args["run-dir"]) fail("--run-dir required");

    const targetDir = path.resolve(args["run-dir"]);

    // Safety: refuse to delete canonical journal entries
    if (isInsideCanonical(targetDir)) {
      fail(`Refusing to delete path inside canonical journal entries directory: ${targetDir}`);
    }

    // Additional safety: refuse to delete the project root or harness script itself
    const projectRoot = path.resolve(PROJECT_ROOT);
    if (targetDir === projectRoot || targetDir === path.resolve(__dirname)) {
      fail(`Refusing to delete project root or scripts directory`);
    }

    if (!fs.existsSync(targetDir)) {
      fail(`Run directory does not exist: ${targetDir}`);
    }

    // Hard-fail for any path outside harness-runs — no valid use case for deleting arbitrary project paths
    const harnessRunsResolved = path.resolve(HARNESS_RUNS_DIR);
    if (!targetDir.startsWith(harnessRunsResolved + path.sep) && targetDir !== harnessRunsResolved) {
      fail(`Refusing to delete path outside scripts/harness-runs/: ${targetDir}`);
    }

    fs.rmSync(targetDir, { recursive: true, force: true });
    out({ deleted: targetDir });
  },
};

// ── Entry point ───────────────────────────────────────────────────────────────

const [,, command, ...rest] = process.argv;
const args = parseArgs(rest);

if (!command || !cmd[command]) {
  const available = Object.keys(cmd).join(", ");
  process.stderr.write(`Unknown command: ${command || "(none)"}\nAvailable: ${available}\n`);
  process.exit(1);
}

try {
  cmd[command](args);
} catch (err) {
  fail(err.message);
}
