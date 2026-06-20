#!/usr/bin/env node
/**
 * Nexus CLI — stateful session management for Claude Code orchestration.
 *
 * Commands:
 *   wake            --goal "..."                            Start a new session
 *   state                                                   Print current state
 *   activate        --role researcher                       Select active instances for role
 *   prompt          --agent res-1                          Build system prompt for an instance
 *   agent-context   --agent res-1                          Read individual journal summary
 *   write-agent     --agent res-1 --type action \
 *                   --content '{...}' --tags "a,b"         Write to individual journal
 *   add-goal        --description "..." --priority 2        Add a persistent goal
 *   record-task     --task '{...}' --goal-id "..."          Journal a task result
 *   record-interaction --from res-1 --to ana-1 \
 *                   --type handoff --outcome neutral \
 *                   --description "..."                     Journal an interaction
 *   observe         --content '{...}' --tags "a,b" \
 *                   [--agent <name>]                         Write shared journal observation (agent stored in entry)
 *   kb-delete       --id KB-XXXX [--agent <name>]           Delete a knowledge base entry by ID
 *   update-goal     --id "..." --action complete            Update goal status
 *   exam-depth      --from critic-1 --to exe-1             Compute review depth
 *   propose         --agent ana-1 --section "..." \
 *                   --trigger "..." \
 *                   --proposed-change "..." \
 *                   --rationale "..."                       Propose a doc change
 *   review-proposal --reviewer critic-1 \
 *                   --proposal-id "..." \
 *                   --outcome approved --notes "..."        Review a proposal
 *   ratify          --proposal-id "..." --notes "..."       Human ratification
 *   sleep           --headline "..."                        Close session
 *   reset                                                   Wipe all state files
 *   flag-gap        --severity critical|high|medium|low \
 *                   --description "..." \
 *                   [--command <cmd>] [--agent <name>]       Flag a process gap in real-time
 *   resolve-gap     --id GAP-XXXX --resolution "..." \
 *                   [--agent <name>]                         Mark a gap resolved
 *   list-gaps       [--severity <s>] [--status open|resolved] List gap registry entries
 *   log-routing     --from <agent> --to <agent> \
 *                   --task "..." --reason "..." \
 *                   [--alternatives "agent-a::agent-b,..."] \
 *                   [--agent <orchestrator>]                  Log a routing decision (ROUTING_DECISION event)
 *   log-win         --what "..." --experience "..." \
 *                   --significance "..." --witnesses "a,b" \
 *                   --agent <name> [--trust-required N] \
 *                   [--allow-below-threshold]                 File a win journal entry (Witness Braid Protocol)
 *   log-witness     --win <entryId> --experience "..." \
 *                   --agent <name>                            File a witness entry for a WIN_ENTRY
 *   complete-braid  --win <entryId> --response "..." \
 *                   --agent <name> [--acknowledge <ids>]      Close braid with 50-word min response
 *   amend-braid     --win <entryId> \
 *                   --category <misfire|context-correction|relationship-change> \
 *                   --explanation "..." --agent <name>        File a BRAID_AMENDMENT annotation
 *   list-braids     [--agent <name>] [--status open|complete|abandoned]  List braid summaries
 *   check-braid-health [--agent <name>]                       Warn if win rate >> completion rate
 *   list-inbox      --agent <name> [--status unread|read|acted|dismissed]  List inbox messages
 *   read-inbox      --id <messageId> --agent <name>           Show full inbox message payload
 *   dismiss-inbox   --id <messageId> --agent <name> [--note "..."]  Dismiss a read message
 *
 * All output is JSON: { ok: true, ... } or { ok: false, error: "..." }
 */

"use strict";

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const { Session, INTERACTION_TYPES, OUTCOMES } = require("../journal/session");
const { Journal }           = require("../journal/journal");
const { GoalRegistry }      = require("../team/goals");
const { RelationGraph }     = require("../team/relations");
const { roles }             = require("../team/roles");
const { Roster }            = require("../team/roster");
const { AgentJournal, AGENT_ENTRY_TYPES } = require("../journal/agent-journal");
const { buildSystemPrompt } = require("../agents/runner");
const { examDepth }         = require("../coordination/dispatcher");

const ENTRIES_DIR      = path.join(__dirname, "../journal/entries");
const JOURNAL_PATH     = path.join(ENTRIES_DIR, "journal.jsonl");
const GOALS_PATH       = path.join(ENTRIES_DIR, "goals.json");
const RELATIONS_PATH   = path.join(ENTRIES_DIR, "relations.json");
const CLI_STATE_PATH   = path.join(ENTRIES_DIR, ".cli-session.json");
const DEAD_LETTER_DIR  = path.join(ENTRIES_DIR, "dead-letters");
const GAPS_PATH        = path.join(ENTRIES_DIR, "gaps.json");

const KNOWLEDGE_DIR  = path.join(__dirname, "../knowledge");
const KB_INDEX_PATH  = path.join(KNOWLEDGE_DIR, "index.json");
const KB_GLOSSARY    = path.join(KNOWLEDGE_DIR, "glossary.md");
const KB_ENTRIES_DIR = path.join(KNOWLEDGE_DIR, "entries");

// ── Command usage strings (for --help) ────────────────────────────────────────

const COMMAND_USAGE = {
  "wake":               '--goal "..." [--type <sessionType>] [--reset]',
  "state":              "(no flags) — print current session state",
  "activate":           '--role <roleName>',
  "prompt":             '--agent <name>',
  "agent-context":      '--agent <name>',
  "write-agent":        '--agent <name> --type <entryType> --content \'{...}\' --tags "a,b"',
  "add-goal":           '--description "..." --priority <number>',
  "record-task":        "--task '{...}' --goal-id \"...\"",
  "record-interaction": '--from <agent> --to <agent> --type <interactionType> --outcome <outcome> --description "..."',
  "observe":            '--content \'{...}\' --tags "a,b" [--agent <name>]',
  "kb-add":             '--title "..." --tagline "..." --confidence <level> --valid-as-of <date> --review-by <date> --tags "a,b" --agent <name> [--dry-run]',
  "kb-amend":           '--id KB-XXXX --content "markdown text to append" [--agent <name>]',
  "kb-lookup":          '--id KB-XXXX  (fetch by ID only; use kb-list to browse)',
  "kb-list":            '[--status <active|stale|superseded>]',
  "kb-delete":          '--id KB-XXXX [--agent <name>]',
  "update-goal":        '--id "..." --action <complete|block|abandon|reactivate>',
  "exam-depth":         '--from <agent> --to <agent>',
  "propose":            '--agent <name> --section "..." --trigger "..." --proposed-change "..." --rationale "..."',
  "review-proposal":    '--reviewer <agent> --proposal-id "..." --outcome <approved|rejected> --notes "..."',
  "ratify":             '--proposal-id "..." --notes "..."',
  "sleep":              '--headline "..." [--observation "..."] [--flag "..."]',
  "reset":              "(no flags) — wipe all state files",
  "flag-gap":           '--severity <critical|high|medium|low> --description "..." [--command <cmd>] [--agent <name>]',
  "resolve-gap":        '--id GAP-XXXX --resolution "..." [--agent <name>]',
  "list-gaps":          '[--severity <s>] [--status <open|resolved>]',
  "log-routing":        '--from <agent> --to <agent> --task "..." --reason "..." [--alternatives "a::b,..."] [--agent <orchestrator>]',
  "log-win":            '--what "..." --experience "..." --significance "..." --witnesses "a,b" --agent <name> [--trust-required N] [--allow-below-threshold]',
  "log-witness":        '--win <entryId> --experience "..." --agent <name> [--below-threshold]',
  "complete-braid":     '--win <entryId> --response "..." --agent <name> [--acknowledge <witnessId,...>]',
  "amend-braid":        '--win <entryId> --category <misfire|context-correction|relationship-change> --explanation "..." --agent <name>',
  "list-braids":        '[--agent <name>] [--status open|complete|abandoned]',
  "check-braid-health": '[--agent <name>]',
  "list-inbox":         '--agent <name> [--status unread|read|acted|dismissed]',
  "read-inbox":         '--id <messageId> --agent <name>',
  "dismiss-inbox":      '--id <messageId> --agent <name> [--note "..."]',
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

// ── Observability helpers ─────────────────────────────────────────────────────

const EVENT_TYPES = Object.freeze({
  TASK_DELEGATED:      "TASK_DELEGATED",
  TASK_COMPLETED:      "TASK_COMPLETED",
  TRUST_STATE_CHANGED: "TRUST_STATE_CHANGED",
  ROUTING_DECISION:    "ROUTING_DECISION",
  SESSION_BOUNDARY:    "SESSION_BOUNDARY",
});

function appendEvent(sessionId, eventType, content, tags = [], relatedTaskIds = []) {
  const entry = {
    id:             crypto.randomUUID(),
    sessionId,
    type:           eventType,
    content,
    tags,
    relatedTaskIds,
    timestamp:      new Date().toISOString(),
  };
  fs.appendFileSync(JOURNAL_PATH, JSON.stringify(entry) + "\n");
  return entry;
}

// ── Dead-letter recovery ─────────────────────────────────────────────────────
//
// When a task is delegated, a .pending.json stub is written to DEAD_LETTER_DIR.
// record-task clears it on completion. On wake, any surviving stubs represent
// tasks that were delegated but whose completion record was lost (session crash).
// Recovery emits a TASK_COMPLETED event with status "lost" so the journal stays
// consistent and operators can see what needs re-running.

function writeDeadLetter(taskId, payload) {
  fs.mkdirSync(DEAD_LETTER_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DEAD_LETTER_DIR, `${taskId}.pending.json`),
    JSON.stringify({ ...payload, writtenAt: new Date().toISOString() }, null, 2)
  );
}

function clearDeadLetter(taskId) {
  const file = path.join(DEAD_LETTER_DIR, `${taskId}.pending.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

function recoverDeadLetters(sessionId) {
  if (!fs.existsSync(DEAD_LETTER_DIR)) return [];
  const recovered = [];
  for (const file of fs.readdirSync(DEAD_LETTER_DIR).filter(f => f.endsWith(".pending.json"))) {
    const filePath = path.join(DEAD_LETTER_DIR, file);
    try {
      const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
      appendEvent(sessionId, EVENT_TYPES.TASK_COMPLETED, {
        taskId:                    payload.taskId,
        status:                    "lost",
        agentId:                   payload.toAgent || null,
        capability:                payload.capability || "unknown",
        durationMs:                null,
        outputSummary:             `Task lost — session crashed after delegation from ${payload.fromAgent || "unknown"}`,
        errorReason:               "session_crash",
        recoveredFromDeadLetter:   true,
        delegatedAt:               payload.writtenAt,
        originalSessionId:         payload.sessionId || null,
      }, ["task-completed", "lost", "dead-letter-recovery"], [payload.taskId]);
      fs.unlinkSync(filePath);
      recovered.push(payload.taskId);
    } catch { /* corrupt or unreadable — leave it and skip */ }
  }
  return recovered;
}

// ── I/O helpers ───────────────────────────────────────────────────────────────

function out(data) {
  process.stdout.write(JSON.stringify({ ok: true, ...data }) + "\n");
}

function fail(msg) {
  process.stderr.write(JSON.stringify({ ok: false, error: msg }) + "\n");
  process.exit(1);
}

// ── State persistence ────────────────────────────────────────────────────────

function getCliState() {
  if (!fs.existsSync(CLI_STATE_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(CLI_STATE_PATH, "utf8")); }
  catch { return null; }
}

function saveCliState(state) {
  fs.mkdirSync(path.dirname(CLI_STATE_PATH), { recursive: true });
  fs.writeFileSync(CLI_STATE_PATH, JSON.stringify(state, null, 2));
}

function requireCliState() {
  const s = getCliState();
  if (!s) fail('No active session. Run: node scripts/nexus-cli.js wake --goal "..."');
  return s;
}

function ensureFiles() {
  fs.mkdirSync(ENTRIES_DIR, { recursive: true });
  fs.mkdirSync(DEAD_LETTER_DIR, { recursive: true });
  if (!fs.existsSync(JOURNAL_PATH))   fs.writeFileSync(JOURNAL_PATH, "");
  if (!fs.existsSync(GOALS_PATH))     fs.writeFileSync(GOALS_PATH, "");
  if (!fs.existsSync(RELATIONS_PATH)) fs.writeFileSync(RELATIONS_PATH, "");
  if (!fs.existsSync(GAPS_PATH))      fs.writeFileSync(GAPS_PATH, JSON.stringify({ lastId: 0, gaps: [] }, null, 2));
}

// Reconstruct a session from saved CLI state without calling wake() again.
// Restores _pendingConflicts so repair arc detection works across CLI calls.
function loadActiveSession(cliState) {
  ensureFiles();
  const journal   = new Journal(JOURNAL_PATH);
  const goals     = new GoalRegistry(GOALS_PATH);
  const relations = new RelationGraph(RELATIONS_PATH);
  const session   = new Session({ goal: cliState.goal, journal, goals, relations });
  session.id              = cliState.sessionId;
  session.startedAt       = cliState.startedAt;
  session.context         = journal.recall();
  session._pendingConflicts = new Set(cliState.pendingConflicts || []);
  return { session, journal, goals, relations };
}

// Persist any changes to _pendingConflicts back to the CLI state file.
function flushConflicts(session, cliState) {
  saveCliState({ ...cliState, pendingConflicts: Array.from(session._pendingConflicts) });
}

// ── Gap registry helpers ──────────────────────────────────────────────────────

const GAP_SEVERITIES = Object.freeze(["critical", "high", "medium", "low"]);
const GAP_STATUSES   = Object.freeze(["open", "resolved"]);

function getGaps() {
  if (!fs.existsSync(GAPS_PATH)) return { lastId: 0, gaps: [] };
  try { return JSON.parse(fs.readFileSync(GAPS_PATH, "utf8")); }
  catch { return { lastId: 0, gaps: [] }; }
}

function saveGaps(data) {
  fs.mkdirSync(path.dirname(GAPS_PATH), { recursive: true });
  fs.writeFileSync(GAPS_PATH, JSON.stringify(data, null, 2));
}

function nextGapId(data) {
  const n = (data.lastId || 0) + 1;
  return `GAP-${String(n).padStart(4, "0")}`;
}

// ── Inbox helpers ─────────────────────────────────────────────────────────────

// Write an INBOX_MESSAGE event directly to journal.jsonl.
function writeInboxMessage({ from, to, messageType, subject, payload }) {
  const entryId = crypto.randomUUID();
  const now     = new Date().toISOString();
  const entry = {
    type:        "INBOX_MESSAGE",
    entryId,
    timestamp:   now,
    from,
    to,
    messageType,
    subject:     subject.slice(0, 120),
    payload:     payload || {},
    status:      "unread",
  };
  fs.appendFileSync(JOURNAL_PATH, JSON.stringify(entry) + "\n");
  return entry;
}

// Write an INBOX_STATUS event to journal.jsonl.
function writeInboxStatus({ agent, messageId, status, note }) {
  const entryId = crypto.randomUUID();
  const now     = new Date().toISOString();
  const entry = {
    type:      "INBOX_STATUS",
    entryId,
    timestamp: now,
    agent,
    messageId,
    status,
    ...(note ? { note } : {}),
  };
  fs.appendFileSync(JOURNAL_PATH, JSON.stringify(entry) + "\n");
  return entry;
}

// Derive the current status of each INBOX_MESSAGE addressed to `agent`.
// Returns an array of { message, derivedStatus } objects, sorted oldest-first.
function deriveInboxState(journalEntries, agent) {
  const messages = journalEntries.filter(
    e => e.type === "INBOX_MESSAGE" && e.to === agent
  );

  // Build a map: messageId → latest status event.
  // acted and dismissed are terminal — once reached, no later event can override.
  const TERMINAL = new Set(["acted", "dismissed"]);
  const statusMap = {};
  for (const e of journalEntries) {
    if (e.type !== "INBOX_STATUS") continue;
    if (e.agent !== agent) continue;
    const prev = statusMap[e.messageId];
    if (prev && TERMINAL.has(prev.status)) continue; // terminal; ignore later events
    if (!prev || new Date(e.timestamp) > new Date(prev.timestamp)) {
      statusMap[e.messageId] = e;
    }
  }

  return messages
    .map(msg => ({
      message:       msg,
      derivedStatus: statusMap[msg.entryId] ? statusMap[msg.entryId].status : "unread",
    }))
    .sort((a, b) => new Date(a.message.timestamp) - new Date(b.message.timestamp));
}

// Load all journal entries (safe parse, skip corrupt lines).
function loadJournalEntries() {
  if (!fs.existsSync(JOURNAL_PATH)) return [];
  return fs.readFileSync(JOURNAL_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ── Knowledge base helpers ────────────────────────────────────────────────────

function getKbIndex() {
  if (!fs.existsSync(KB_INDEX_PATH)) return { lastId: 0, entries: [] };
  try { return JSON.parse(fs.readFileSync(KB_INDEX_PATH, "utf8")); }
  catch { return { lastId: 0, entries: [] }; }
}

function saveKbIndex(index) {
  fs.mkdirSync(path.dirname(KB_INDEX_PATH), { recursive: true });
  fs.writeFileSync(KB_INDEX_PATH, JSON.stringify(index, null, 2));
}

function nextKbId(index) {
  const n = (index.lastId || 0) + 1;
  return `KB-${String(n).padStart(4, "0")}`;
}

function regenerateGlossary(index) {
  fs.mkdirSync(path.dirname(KB_GLOSSARY), { recursive: true });
  const rows = index.entries.map(e =>
    `| ${e.id} | ${e.tagline} | ${e.confidence} | ${e.validAsOf} | ${e.reviewBy} | ${e.status} | ${e.tags.join(", ")} |`
  );
  const lines = [
    "# Nexus Knowledge Base — Glossary",
    "",
    "Quick-reference index. Use `kb-lookup --id KB-XXXX` for the full entry.",
    "",
    "| ID | Tagline | Confidence | Valid As Of | Review By | Status | Tags |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
    `*${index.entries.length} entr${index.entries.length === 1 ? "y" : "ies"} — last updated ${new Date().toISOString().slice(0, 10)}*`,
  ];
  fs.writeFileSync(KB_GLOSSARY, lines.join("\n") + "\n");
}

function buildEntryFile({ id, title, tagline, confidence, validAsOf, reviewBy,
                           tags, agent, sessionId, summary, claims, report }) {
  const claimsSection = claims && claims.length
    ? ["## Claims", "", ...claims.map(c => `- **[${c.scope || "general"}]** ${c.text}`), ""]
    : [];
  return [
    `# ${id}: ${title}`,
    "",
    `**Tagline:** ${tagline}`,
    `**Confidence:** ${confidence}`,
    `**Valid as of:** ${validAsOf}`,
    `**Review by:** ${reviewBy}`,
    `**Status:** active`,
    `**Tags:** ${tags.join(", ")}`,
    `**Produced by:** ${agent}${sessionId ? ` (Session ${sessionId.slice(0, 8)})` : ""}`,
    "",
    "---",
    "",
    "## Summary",
    "",
    summary,
    "",
    ...claimsSection,
    "## Detailed Report",
    "",
    report,
    "",
    "---",
    "",
    `*Entry added: ${validAsOf} | Last amended: —*`,
    "",
  ].join("\n");
}

// ── Commands ─────────────────────────────────────────────────────────────────

const cmd = {

  // Wake a new session. By default carries forward journal, goals, and relations.
  // Pass --reset to wipe all state (useful for tests and fresh starts).
  wake(args) {
    const goal = args.goal || "Nexus session";
    fs.mkdirSync(ENTRIES_DIR, { recursive: true });

    if (args.reset) {
      fs.writeFileSync(JOURNAL_PATH, "");
      fs.writeFileSync(GOALS_PATH, "");
      fs.writeFileSync(RELATIONS_PATH, "");
      if (fs.existsSync(CLI_STATE_PATH)) fs.unlinkSync(CLI_STATE_PATH);
      // Clear dead-letter stubs before recovery runs so a reset session starts clean
      if (fs.existsSync(DEAD_LETTER_DIR)) {
        for (const f of fs.readdirSync(DEAD_LETTER_DIR).filter(f => f.endsWith(".pending.json"))) {
          fs.unlinkSync(path.join(DEAD_LETTER_DIR, f));
        }
      }
    } else {
      ensureFiles();
    }

    const journal   = new Journal(JOURNAL_PATH);
    const goals     = new GoalRegistry(GOALS_PATH);
    const relations = new RelationGraph(RELATIONS_PATH);

    // Snapshot pre-decay state for TRUST_STATE_CHANGED detection
    const preDecay = {};
    for (const r of relations.snapshot()) {
      preDecay[r.pair] = { trustAtoB: r.trustAtoB, trustBtoA: r.trustBtoA, familiarity: r.familiarity };
    }

    const session   = new Session({ goal, journal, goals, relations });

    session.wake();
    const sessionIndex  = relations._sessionIndex;
    const relSnapshot   = relations.snapshot();

    saveCliState({ sessionId: session.id, startedAt: session.startedAt, goal,
                   sessionType: args.type || "standard",
                   journalSizeAtWake: journal.size() });

    // Emit TRUST_STATE_CHANGED for each pair that decayed at wake
    let decayPairsAffected = 0;
    for (const r of relSnapshot) {
      const before = preDecay[r.pair];
      if (!before) continue;
      const tDeltaAB = Math.abs(r.trustAtoB - before.trustAtoB);
      const tDeltaBA = Math.abs(r.trustBtoA - before.trustBtoA);
      const fDelta   = Math.abs(r.familiarity - before.familiarity);
      if (tDeltaAB >= 1 || tDeltaBA >= 1 || fDelta >= 1) {
        decayPairsAffected++;
        const [agentA, agentB] = r.pair.split(" ↔ ");
        appendEvent(session.id, EVENT_TYPES.TRUST_STATE_CHANGED, {
          pair:               `${agentA}::${agentB}`,
          agentA,
          agentB,
          trustAtoB_before:   before.trustAtoB,
          trustAtoB_after:    r.trustAtoB,
          trustBtoA_before:   before.trustBtoA,
          trustBtoA_after:    r.trustBtoA,
          familiarity_before: before.familiarity,
          familiarity_after:  r.familiarity,
          trigger:            "decay",
          triggeringInteractionId: null,
          repairArcClosed:    false,
          sessionIndex,
        }, ["trust-state-changed", "decay"]);
      }
    }

    // Recover any dead-letter stubs left by crashed sessions before emitting wake boundary
    const recoveredTasks = recoverDeadLetters(session.id);

    // Scan for open braids belonging to the waking agent (WIN_ENTRYs with no BRAID_COMPLETE)
    const wakingAgent = args.agent || null;
    let openBraids = 0;
    const journalEntriesAtWake = loadJournalEntries();

    if (wakingAgent) {
      const myWins = journalEntriesAtWake.filter(e => e.type === "WIN_ENTRY" && e.agent === wakingAgent);
      for (const win of myWins) {
        const hasComplete = journalEntriesAtWake.some(e => e.type === "BRAID_COMPLETE" && e.braid_for === win.entryId);
        if (!hasComplete) openBraids++;
      }
    }

    // Inbox: scan for messages addressed to the waking agent, derive status, surface active
    let inboxCount = 0;
    let inboxSummary = [];
    let inboxBacklogWarning = false;

    if (wakingAgent) {
      const inboxState = deriveInboxState(journalEntriesAtWake, wakingAgent);
      const activeMessages = inboxState.filter(
        s => s.derivedStatus === "unread" || s.derivedStatus === "read"
      );
      inboxCount = activeMessages.length;
      inboxBacklogWarning = inboxCount > 10;

      // Surface first 5 oldest active messages (FIFO)
      const toSurface = activeMessages.slice(0, 5);
      inboxSummary = toSurface.map(s => ({
        messageId:   s.message.entryId,
        from:        s.message.from,
        messageType: s.message.messageType,
        subject:     s.message.subject,
        timestamp:   s.message.timestamp,
        status:      s.derivedStatus,
      }));

      // Auto-mark all surfaced UNREAD messages as "read"
      for (const s of toSurface) {
        if (s.derivedStatus === "unread") {
          writeInboxStatus({ agent: wakingAgent, messageId: s.message.entryId, status: "read" });
        }
      }
    }

    // Emit SESSION_BOUNDARY wake
    appendEvent(session.id, EVENT_TYPES.SESSION_BOUNDARY, {
      boundary:                "wake",
      goal,
      sessionIndex,
      trustDecayPairsAffected: decayPairsAffected,
      relationsSnapshot:       relSnapshot,
      activeGoalCount:         goals.active().length,
      deadLettersRecovered:    recoveredTasks.length,
    }, ["session-boundary", "wake"]);

    if (recoveredTasks.length > 0) {
      process.stderr.write(
        `  [Dead-letter recovery] ${recoveredTasks.length} task(s) marked lost: ${recoveredTasks.join(", ")}\n`
      );
    }

    // out() after recovery so callers see the recovered task list in the JSON response
    if (openBraids > 0) {
      process.stderr.write(`  [Witness Braid] ${openBraids} open braid(s) awaiting completion for ${wakingAgent}\n`);
    }

    if (wakingAgent && inboxCount > 10) {
      process.stderr.write(`  [Inbox] ${inboxCount} inbox messages — run list-inbox to see all\n`);
    }

    // Surface open flags from the previous sleep — voice fields an agent left for the next session
    let priorFlags = [];
    if (wakingAgent) {
      const sleepBoundaries = journalEntriesAtWake
        .filter(e => e.type === EVENT_TYPES.SESSION_BOUNDARY && e.content && e.content.boundary === "sleep")
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      // Show flags from the most recent sleep entry that has one
      for (const boundary of sleepBoundaries) {
        if (boundary.content.flag) {
          priorFlags = [{ sessionIndex: boundary.content.sessionIndex, flag: boundary.content.flag }];
          process.stderr.write(`  [Flag from prior session] ${boundary.content.flag}\n`);
          break;
        }
      }
    }

    const wakeResponse = {
      sessionId:              session.id,
      goal,
      foundationLoaded:       !!session.foundation,
      foundationChars:        session.foundation ? session.foundation.length : 0,
      activeGoals:            goals.active(),
      relationships:          relSnapshot,
      deadLettersRecovered:   recoveredTasks.length,
      recoveredTaskIds:       recoveredTasks,
      openBraids,
      inboxCount,
      inboxSummary,
      ...(priorFlags.length ? { priorFlags } : {}),
    };
    if (inboxBacklogWarning) wakeResponse.inboxBacklogWarning = true;
    out(wakeResponse);
  },

  // Print current session state (goals, relations, journal entry count, stale KB entries, open gaps)
  state(args) {
    const cliState = requireCliState();
    const { session, journal, goals, relations } = loadActiveSession(cliState);
    const kbIndex   = getKbIndex();
    const today     = new Date().toISOString().slice(0, 10);
    const staleKb   = kbIndex.entries.filter(e =>
      e.status === "active" && e.reviewBy && e.reviewBy < today
    );
    const gapData   = getGaps();
    const openGaps  = gapData.gaps.filter(g => g.status === "open");
    const gapsBySev = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const g of openGaps) gapsBySev[g.severity] = (gapsBySev[g.severity] || 0) + 1;

    // Routing concentration — detect orchestration confound risk
    const relSnap = relations.snapshot();
    const pairCounts = relSnap.map(r => ({ pair: r.pair, interactions: r.interactions }))
      .sort((a, b) => b.interactions - a.interactions);
    const maxInteractions = pairCounts.length > 0 ? pairCounts[0].interactions : 0;
    const minInteractions = pairCounts.length > 0 ? pairCounts[pairCounts.length - 1].interactions : 0;
    const concentrationRatio = minInteractions > 0 ? Math.round((maxInteractions / minInteractions) * 10) / 10 : null;
    const routingConcentration = {
      pairCounts,
      maxInteractions,
      minInteractions,
      concentrationRatio,
      warning: concentrationRatio !== null && concentrationRatio > 3
        ? `Orchestration confound risk: top pair has ${concentrationRatio}x interactions of bottom pair — diversify routing`
        : null,
    };

    // Inbox depth: per-agent count of active (unread + read) messages
    const rosterForState = new Roster();
    const allAgentsForState = rosterForState.allAgents();
    const journalEntriesForState = loadJournalEntries();
    const inboxDepth = {};
    let maxInboxDepth = null;
    for (const agentId of allAgentsForState) {
      const inboxState = deriveInboxState(journalEntriesForState, agentId);
      const activeCount = inboxState.filter(
        s => s.derivedStatus === "unread" || s.derivedStatus === "read"
      ).length;
      inboxDepth[agentId] = activeCount;
      if (activeCount > 20) {
        if (!maxInboxDepth || activeCount > inboxDepth[maxInboxDepth]) {
          maxInboxDepth = agentId;
        }
      }
    }

    out({
      sessionId:        cliState.sessionId,
      goal:             cliState.goal,
      activeGoals:      goals.active(),
      relationships:    relations.snapshot(),
      journalEntries:   journal.size(),
      foundationLoaded: !!session.foundation,
      knowledgeBase:    { total: kbIndex.entries.length, staleEntries: staleKb.map(e => e.id) },
      openGaps:         { total: openGaps.length, bySeverity: gapsBySev,
                          criticalAndHigh: openGaps.filter(g => g.severity === "critical" || g.severity === "high")
                            .map(g => ({ id: g.id, severity: g.severity, description: g.description })) },
      routingConcentration,
      inboxDepth,
      ...(maxInboxDepth ? { maxInboxDepth } : {}),
    });
  },

  // Select which instances of a role to activate this session.
  // Returns the chosen agent IDs with their relevance scores.
  activate(args) {
    const role = args.role;
    if (!role || !roles[role]) fail(`--role required. Available: ${Object.keys(roles).join(", ")}`);

    const cliState = requireCliState();
    const roster   = new Roster();
    const active   = roster.activate(role, { goalText: cliState.goal, maxActive: 2 });
    const all      = roster.instancesFor(role);

    const details = all.map(id => ({
      id,
      active:    active.includes(id),
      relevance: new AgentJournal(id).relevanceTo(cliState.goal).toFixed(3),
      entries:   new AgentJournal(id).size(),
    }));

    out({ role, activeInstances: active, all: details });
  },

  // Build and return the full system prompt for a specific agent instance.
  // Includes individual journal context in addition to shared team state.
  prompt(args) {
    const agentId = args.agent;
    if (!agentId) fail("--agent required (e.g. --agent res-1)");

    const cliState = requireCliState();
    const { session } = loadActiveSession(cliState);

    const roster = new Roster();
    const member = roster.memberFor(agentId);
    if (!member) fail(`Unknown agent: ${agentId}`);

    // Inject individual journal into session context for buildSystemPrompt
    const agentJournal  = new AgentJournal(agentId);
    const individualCtx = agentJournal.summary({ limit: 10 });
    session._individualJournal = individualCtx;

    const systemPrompt = buildSystemPrompt({ member, session });
    out({ agentId, systemPrompt });
  },

  // Return a readable summary of an agent's individual journal.
  "agent-context"(args) {
    const agentId = args.agent;
    if (!agentId) fail("--agent required");

    const j = new AgentJournal(agentId);
    out({
      agentId,
      entries:  j.size(),
      summary:  j.summary({ limit: 15 }),
      goals:    j.read({ type: AGENT_ENTRY_TYPES.PERSONAL_GOAL }),
      opinions: j.read({ type: AGENT_ENTRY_TYPES.RELATIONAL_OPINION }),
    });
  },

  // Write an entry to an agent's individual journal.
  "write-agent"(args) {
    const { agent, type, content } = args;
    if (!agent || !type || !content) fail("--agent, --type, --content required");

    const cliState = requireCliState();
    const j = new AgentJournal(agent);

    const entry = j.write({
      sessionId: cliState.sessionId,
      type,
      content:   JSON.parse(content),
      tags:      args.tags ? args.tags.split(",").map(t => t.trim()) : [],
    });

    out({ agentId: agent, entryId: entry.id, type });
  },

  // Add a persistent goal
  "add-goal"(args) {
    if (!args.description) fail("--description required");
    const cliState = requireCliState();
    const { goals } = loadActiveSession(cliState);

    const goal = goals.add({
      description: args.description,
      priority:    parseInt(args.priority || "2", 10),
      tags:        args.tags ? args.tags.split(",").map(t => t.trim()) : [],
    });

    out({ goalId: goal.id, description: goal.description, priority: goal.priority });
  },

  // Record a completed task result in the journal
  "record-task"(args) {
    if (!args.task) fail("--task JSON required");
    const cliState = requireCliState();
    const { session } = loadActiveSession(cliState);

    const task   = JSON.parse(args.task);
    const goalId = args["goal-id"] || null;
    session.recordTask(task, goalId);

    // Clear the dead-letter stub now that the task completed normally
    clearDeadLetter(task.id);

    appendEvent(cliState.sessionId, EVENT_TYPES.TASK_COMPLETED, {
      taskId:        task.id,
      status:        task.status === "done" ? "done" : "failed",
      agentId:       task.agentId || task.assignedTo || null,
      goalId,
      capability:    task.capability || task.type || "unknown",
      durationMs:    task.durationMs || null,
      outputSummary: task.result   || task.summary   || "no summary provided",
      errorReason:   task.error    || null,
      trustImpact:   task.trustImpact || null,
    }, ["task-completed", task.status === "done" ? "done" : "failed",
        task.capability || task.type || "task"], [task.id]);

    out({ recorded: task.id });
  },

  // Record an agent-to-agent interaction (handoff, approval, rejection, etc.)
  "record-interaction"(args) {
    const { from, to, type, outcome = "neutral", description = "" } = args;
    if (!from || !to || !type) fail("--from, --to, --type required");
    const validTypes    = Object.values(INTERACTION_TYPES);
    const validOutcomes = Object.values(OUTCOMES);
    if (!validTypes.includes(type))
      fail(`--type "${type}" is not valid. Valid types: ${validTypes.join(", ")}`);
    if (!validOutcomes.includes(outcome))
      fail(`--outcome "${outcome}" is not valid. Valid outcomes: ${validOutcomes.join(", ")}`);

    const cliState = requireCliState();
    const { session, relations } = loadActiveSession(cliState);

    // Snapshot trust/familiarity before the interaction
    const relBefore = relations.get(from, to);
    const trustAB_b = relBefore.trust.ab;
    const trustBA_b = relBefore.trust.ba;
    const fam_b     = relBefore.familiarity;

    const relatedTaskIds = args["related-tasks"] ? args["related-tasks"].split(",") : [];
    const { relation, repaired } = session.recordInteraction(from, to, {
      type, outcome, description, relatedTaskIds,
    });

    // Persist _pendingConflicts so repair arc detection survives across CLI calls
    flushConflicts(session, cliState);

    // Emit TRUST_STATE_CHANGED if any value moved by ≥1 point
    const tDeltaAB = Math.abs(relation.trust.ab - trustAB_b);
    const tDeltaBA = Math.abs(relation.trust.ba - trustBA_b);
    const fDelta   = Math.abs(relation.familiarity - fam_b);
    if (tDeltaAB >= 1 || tDeltaBA >= 1 || fDelta >= 1) {
      const [agentA, agentB] = [from, to].sort();
      // The interaction entry was just written; grab its ID as the trigger reference
      const recentInteractions = session.journal.read({ type: "interaction" });
      const trigId = recentInteractions.length > 0
        ? recentInteractions[recentInteractions.length - 1].id : null;
      appendEvent(cliState.sessionId, EVENT_TYPES.TRUST_STATE_CHANGED, {
        pair:               `${agentA}::${agentB}`,
        agentA,
        agentB,
        trustAtoB_before:   trustAB_b,
        trustAtoB_after:    relation.trust.ab,
        trustBtoA_before:   trustBA_b,
        trustBtoA_after:    relation.trust.ba,
        familiarity_before: fam_b,
        familiarity_after:  relation.familiarity,
        trigger:            "interaction",
        triggeringInteractionId: trigId,
        repairArcClosed:    repaired,
      }, ["trust-state-changed", "interaction", ...(repaired ? ["repair"] : [])]);
    }

    // If this is a handoff with a task-id, write dead letter + emit TASK_DELEGATED
    if (type === "handoff" && args["task-id"]) {
      writeDeadLetter(args["task-id"], {
        taskId:       args["task-id"],
        fromAgent:    from,
        toAgent:      to,
        capability:   args.capability || "handoff",
        sessionId:    cliState.sessionId,
        description,
      });
      appendEvent(cliState.sessionId, EVENT_TYPES.TASK_DELEGATED, {
        taskId:                args["task-id"],
        fromAgent:             from,
        toAgent:               to,
        capability:            args.capability || "unknown",
        goalId:                args["goal-id"] || null,
        taskDescription:       description,
        priority:              args.priority ? parseInt(args.priority, 10) : null,
        trustScoreAtDelegation: relation.trustFrom(from),
        routingReason:         args["routing-reason"] || "familiarity",
      }, ["task-delegated", "handoff"], [args["task-id"]]);
    } else if (args["task-id"]) {
      // Non-handoff interaction with a task-id signals task completion (e.g. approval, rejection,
      // code_review). Clear the dead letter so it isn't falsely recovered on the next wake.
      clearDeadLetter(args["task-id"]);
    }

    out({
      pair:        `${from} → ${to}`,
      repaired,
      proximity:   relation.proximity(),
      trustAtoB:   relation.trust.ab,
      trustBtoA:   relation.trust.ba,
      familiarity: relation.familiarity,
    });
  },

  // Write an observation entry (mid-session finding worth preserving)
  observe(args) {
    if (!args.content) fail("--content JSON required");
    const cliState = requireCliState();
    const { session } = loadActiveSession(cliState);

    const content = JSON.parse(args.content);
    const tags    = args.tags ? args.tags.split(",").map(t => t.trim()) : [];
    const agent   = args.agent || null;
    const entry   = session.observe(
      agent ? { ...content, _observedBy: agent } : content,
      { tags }
    );
    out({ entryId: entry.id, agent, content: agent ? { ...content, _observedBy: agent } : content, tags });
  },

  // Update a goal's status (complete, block, abandon, reactivate)
  "update-goal"(args) {
    if (!args.id || !args.action) fail("--id and --action required");
    const cliState = requireCliState();
    const { session } = loadActiveSession(cliState);

    const goal = session.updateGoal(args.id, args.action, { note: args.note || "" });
    out({ goalId: args.id, status: goal.status });
  },

  // How many self-examination passes should the Critic do based on trust?
  "exam-depth"(args) {
    if (!args.from || !args.to) fail("--from and --to required");
    const cliState = requireCliState();
    const { relations } = loadActiveSession(cliState);

    const rel        = relations.get(args.from, args.to);
    const trustScore = rel ? rel.trust.ab : 50;
    const depth      = examDepth(trustScore);
    out({ from: args.from, to: args.to, trustScore, depth });
  },

  // Propose a change to team-foundation.md
  propose(args) {
    const { agent, section, trigger, rationale } = args;
    const proposedChange = args["proposed-change"];
    if (!agent || !section || !trigger || !proposedChange || !rationale) {
      fail("--agent, --section, --trigger, --proposed-change, --rationale all required");
    }
    const cliState = requireCliState();
    const { session } = loadActiveSession(cliState);

    const proposal = session.proposeFoundationChange(agent, {
      section,
      trigger,
      currentText:    args["current-text"] || "",
      proposedChange,
      rationale,
    });

    out({ proposalId: proposal.id, section });
  },

  // Record the Critic's verdict on a proposal
  "review-proposal"(args) {
    const { reviewer, outcome, notes } = args;
    const proposalId = args["proposal-id"];
    if (!reviewer || !proposalId || !outcome || !notes) {
      fail("--reviewer, --proposal-id, --outcome, --notes all required");
    }
    const cliState = requireCliState();
    const { session } = loadActiveSession(cliState);

    session.reviewProposal(reviewer, proposalId, { outcome, notes });
    out({ proposalId, outcome });
  },

  // Write the session summary and close
  sleep(args) {
    if (!args.headline) fail("--headline required");
    const cliState = requireCliState();
    const { session, goals, relations } = loadActiveSession(cliState);

    const stats      = args.stats ? JSON.parse(args.stats) : {};
    const relSnapshot = relations.snapshot();
    const durationMs  = cliState.startedAt
      ? Date.now() - new Date(cliState.startedAt).getTime()
      : null;

    const journalNow         = session.journal.size();
    const journalEntriesAdded = journalNow - (cliState.journalSizeAtWake || 0);
    const complexitySignal   = journalEntriesAdded > 40 ? "high"
                             : journalEntriesAdded > 25 ? "elevated"
                             : "normal";

    // Voice preservation fields (Proposal B, adopted Session 34).
    // observation: something noticed this session — no action required from others.
    // flag: something uncertain, not yet a formal position — team or human lead should hold it.
    // Both are optional. Pause and check before leaving both blank.
    const observation = args.observation || null;
    const flag        = args.flag        || null;

    // Emit SESSION_BOUNDARY sleep before session.sleep() writes the SUMMARY entry
    appendEvent(cliState.sessionId, EVENT_TYPES.SESSION_BOUNDARY, {
      boundary:             "sleep",
      goal:                 cliState.goal,
      sessionIndex:         relations._sessionIndex,
      agentsActive:         stats.agentsActive  || null,
      tasksCompleted:       stats.tasksCompleted || null,
      tasksFailed:          stats.tasksFailed    || null,
      headline:             args.headline,
      observation,
      flag,
      durationMs,
      relationsSnapshot:    relSnapshot,
      activeGoalCount:      goals.active().length,
      journalEntriesAdded,
      complexitySignal,
    }, ["session-boundary", "sleep"]);

    session.sleep({ headline: args.headline, notes: args.notes || "", stats });

    if (fs.existsSync(CLI_STATE_PATH)) fs.unlinkSync(CLI_STATE_PATH);

    out({
      headline:             args.headline,
      goalSummary:          goals.summary(),
      relationships:        relSnapshot,
      journalEntriesAdded,
      complexitySignal,
    });
  },

  // Record human ratification of an approved proposal
  ratify(args) {
    const proposalId = args["proposal-id"];
    if (!proposalId) fail("--proposal-id required");
    const cliState = requireCliState();
    const { session } = loadActiveSession(cliState);

    const { ENTRY_TYPES } = require("../journal/journal");
    session.journal.write({
      sessionId: session.id,
      type:      ENTRY_TYPES.RATIFICATION,
      content: {
        proposalId,
        ratifiedBy: "human",
        notes:      args.notes || "",
      },
      tags: ["ratification", "human"],
    });

    console.log(`  [Ratified] proposal ${proposalId.slice(0, 8)} marked as human-ratified`);
    out({ proposalId, ratifiedBy: "human" });
  },

  // Emit a TASK_DELEGATED event when one agent explicitly hands a task to another.
  delegate(args) {
    const { from, to, capability, description } = args;
    const taskId = args["task-id"];
    if (!from || !to || !capability || !taskId || !description) {
      fail("--from, --to, --capability, --task-id, --description all required");
    }
    const cliState = requireCliState();
    const { relations } = loadActiveSession(cliState);

    const rel          = relations.get(from, to);
    const trustScore   = rel.trustFrom(from);

    // Write dead-letter stub — cleared by record-task on completion, or recovered on next wake
    writeDeadLetter(taskId, {
      taskId,
      fromAgent:    from,
      toAgent:      to,
      capability,
      sessionId:    cliState.sessionId,
      description,
    });

    appendEvent(cliState.sessionId, EVENT_TYPES.TASK_DELEGATED, {
      taskId,
      fromAgent:             from,
      toAgent:               to,
      capability,
      goalId:                args["goal-id"] || null,
      taskDescription:       description,
      priority:              args.priority ? parseInt(args.priority, 10) : null,
      trustScoreAtDelegation: trustScore,
      routingReason:         args["routing-reason"] || "trust",
    }, ["task-delegated"], [taskId]);

    out({ taskId, fromAgent: from, toAgent: to, trustScoreAtDelegation: trustScore });
  },

  // Activate the planning subset: orchestrator + critic + 1 random from the rest.
  // Returns agent IDs and their system prompts ready for spawning.
  "plan-activate"(args) {
    const cliState = requireCliState();
    if (cliState.sessionType !== "planning") {
      fail("plan-activate requires a planning session. Wake with --type planning.");
    }
    const { session } = loadActiveSession(cliState);
    const roster = new Roster();

    // Fixed slots
    const fixed = ["orchestrator-1", "critic-1"];

    // Random slot from remaining instances (excluding fixed)
    const pool = roster.allAgents().filter(id => !fixed.includes(id));
    const randomPick = pool[Math.floor(Math.random() * pool.length)];
    const subset = [...fixed, randomPick];

    // Build system prompts for each
    const agents = subset.map(agentId => {
      const member = roster.memberFor(agentId);
      const agentJournal = new AgentJournal(agentId);
      session._individualJournal = agentJournal.summary({ limit: 10 });
      const systemPrompt = buildSystemPrompt({ member, session });
      return { agentId, role: roster.roleOf(agentId), systemPrompt };
    });

    // Persist subset to CLI state so plan-record can reference it
    saveCliState({ ...cliState, planningSubset: subset });
    out({ subset, agents });
  },

  // Record the aggregated planning deliberation output to the journal.
  "plan-record"(args) {
    if (!args.result) fail("--result JSON required");
    const cliState = requireCliState();
    const { session } = loadActiveSession(cliState);

    const result = JSON.parse(args.result);
    const entry = session.observe(
      { planningResult: result, subset: cliState.planningSubset || [] },
      { tags: ["planning", "prioritization"] }
    );
    out({ entryId: entry.id, optionCount: (result.rankedOptions || []).length });
  },

  // Add a new knowledge base entry
  "kb-add"(args) {
    const { title, tagline, summary, report, confidence, agent } = args;
    if (!title || !tagline || !summary || !report || !confidence || !agent) {
      fail("--title, --tagline, --summary, --report, --confidence, --agent required");
    }
    const validAsOf  = args["valid-as-of"]  || new Date().toISOString().slice(0, 10);
    const reviewBy   = args["review-by"]    || (() => {
      const d = new Date(); d.setMonth(d.getMonth() + 6); return d.toISOString().slice(0, 10);
    })();
    const tags       = args.tags    ? args.tags.split(",").map(t => t.trim()) : [];
    const claims     = args.claims  ? JSON.parse(args.claims) : [];
    const cliState   = getCliState();
    const sessionId  = args["session-id"] || (cliState ? cliState.sessionId : null);

    fs.mkdirSync(KB_ENTRIES_DIR, { recursive: true });
    const index = getKbIndex();
    const id    = nextKbId(index);

    // --dry-run: preview what would be created without writing anything
    if (args["dry-run"]) {
      out({
        dryRun: true,
        id,
        title,
        tagline,
        file: `knowledge/entries/${id}.md`,
        tags,
        confidence,
        validAsOf,
        reviewBy,
        agent,
        note: "Nothing written to disk. Remove --dry-run to create the entry.",
      });
      return;
    }

    const fileContent = buildEntryFile({
      id, title, tagline, confidence, validAsOf, reviewBy,
      tags, agent, sessionId, summary, claims, report,
    });
    fs.writeFileSync(path.join(KB_ENTRIES_DIR, `${id}.md`), fileContent);

    index.entries.push({
      id, title, tagline, confidence, validAsOf, reviewBy,
      status: "active", tags,
      producedBy: agent, sessionId,
      amendmentCount: 0,
      createdAt: validAsOf,
    });
    index.lastId = parseInt(id.replace("KB-", ""), 10);
    saveKbIndex(index);
    regenerateGlossary(index);
    out({ id, title, tagline, file: `knowledge/entries/${id}.md` });
  },

  // Append an amendment to an existing entry
  "kb-amend"(args) {
    const { id, agent, content } = args;
    if (!id || !agent || !content) fail("--id, --agent, --content required");

    const index = getKbIndex();
    const entry = index.entries.find(e => e.id === id);
    if (!entry) fail(`Entry ${id} not found in index`);

    const filePath = path.join(KB_ENTRIES_DIR, `${id}.md`);
    if (!fs.existsSync(filePath)) fail(`Entry file not found: ${filePath}`);

    const date = new Date().toISOString().slice(0, 10);
    const block = [
      "",
      `### Amendment — ${agent} — ${date}`,
      "",
      content,
    ].join("\n");

    let fileContent = fs.readFileSync(filePath, "utf8");
    // Insert amendment before the final metadata footer line
    const footerRe = /\n---\n\n\*Entry added:/;
    if (footerRe.test(fileContent)) {
      fileContent = fileContent.replace(footerRe, `\n${block}\n\n---\n\n*Entry added:`);
    } else {
      fileContent += block + "\n";
    }
    // Update last-amended stamp
    fileContent = fileContent.replace(
      /\| Last amended: [^\*]*/,
      `| Last amended: ${date} by ${agent} `
    );
    fs.writeFileSync(filePath, fileContent);

    entry.amendmentCount = (entry.amendmentCount || 0) + 1;
    entry.lastAmendedAt  = date;
    entry.lastAmendedBy  = agent;
    saveKbIndex(index);
    regenerateGlossary(index);
    out({ id, amendmentCount: entry.amendmentCount });
  },

  // Print a full entry
  "kb-lookup"(args) {
    if (!args.id) fail("kb-lookup fetches by ID, not keyword. Use --id KB-XXXX (e.g. --id KB-0001). To browse entries, use kb-list.");
    const index = getKbIndex();
    const entry = index.entries.find(e => e.id === args.id);
    if (!entry) fail(`Entry ${args.id} not found`);
    const filePath = path.join(KB_ENTRIES_DIR, `${args.id}.md`);
    const content  = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "(file missing)";
    out({ ...entry, content });
  },

  // List all entries, optionally filtered by tag or status
  "kb-list"(args) {
    const index   = getKbIndex();
    let entries   = index.entries;
    if (args.tag)    entries = entries.filter(e => e.tags.includes(args.tag));
    if (args.status) entries = entries.filter(e => e.status === args.status);
    out({
      count: entries.length,
      entries: entries.map(e => ({
        id: e.id, tagline: e.tagline, confidence: e.confidence,
        validAsOf: e.validAsOf, reviewBy: e.reviewBy, status: e.status, tags: e.tags,
      })),
    });
  },

  // Mark an entry active, stale, or deprecated
  "kb-mark"(args) {
    const { id, status, reason } = args;
    if (!id || !status) fail("--id and --status required");
    if (!["active", "stale", "deprecated"].includes(status)) {
      fail("--status must be one of: active, stale, deprecated");
    }
    const index = getKbIndex();
    const entry = index.entries.find(e => e.id === id);
    if (!entry) fail(`Entry ${id} not found`);

    const prev   = entry.status;
    entry.status = status;
    if (reason) entry.statusReason = reason;
    saveKbIndex(index);
    regenerateGlossary(index);

    // Update the Status line in the markdown file
    const filePath = path.join(KB_ENTRIES_DIR, `${id}.md`);
    if (fs.existsSync(filePath)) {
      const updated = fs.readFileSync(filePath, "utf8")
        .replace(/\*\*Status:\*\* \w+/, `**Status:** ${status}`);
      fs.writeFileSync(filePath, updated);
    }
    out({ id, prev, status, reason: reason || null });
  },

  // Delete a knowledge base entry by ID
  "kb-delete"(args) {
    const { id } = args;
    if (!id) fail("--id required (e.g. --id KB-0001)");

    const index = getKbIndex();
    const entryIdx = index.entries.findIndex(e => e.id === id);
    if (entryIdx === -1) fail(`Entry ${id} not found in index`);

    const entry = index.entries[entryIdx];
    const filePath = path.join(KB_ENTRIES_DIR, `${id}.md`);

    // Delete the .md file if it exists
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Remove from index (do NOT decrement lastId — IDs are permanent)
    index.entries.splice(entryIdx, 1);
    saveKbIndex(index);
    regenerateGlossary(index);

    out({
      id,
      deletedBy: args.agent || null,
      title: entry.title,
    });
  },

  // Flag a process gap discovered during normal work
  "flag-gap"(args) {
    const { severity, description } = args;
    if (!severity || !description) fail("--severity and --description required");
    if (!GAP_SEVERITIES.includes(severity))
      fail(`--severity must be one of: ${GAP_SEVERITIES.join(", ")}`);

    const cliState  = getCliState();
    const gapData   = getGaps();
    const id        = nextGapId(gapData);
    const today     = new Date().toISOString().slice(0, 10);

    const gap = {
      id,
      severity,
      description,
      command:     args.command    || null,
      reportedBy:  args.agent      || null,
      sessionId:   cliState ? cliState.sessionId : null,
      status:      "open",
      createdAt:   today,
      resolvedAt:  null,
      resolvedBy:  null,
      resolution:  null,
    };

    gapData.gaps.push(gap);
    gapData.lastId = parseInt(id.replace("GAP-", ""), 10);
    saveGaps(gapData);
    out({ id, severity, description, status: "open" });
  },

  // Resolve an open gap with an explanation of what was done
  "resolve-gap"(args) {
    const { id, resolution } = args;
    if (!id || !resolution) fail("--id and --resolution required");

    const gapData = getGaps();
    const gap     = gapData.gaps.find(g => g.id === id);
    if (!gap) fail(`Gap ${id} not found`);
    if (gap.status === "resolved") fail(`Gap ${id} is already resolved`);

    gap.status     = "resolved";
    gap.resolvedAt = new Date().toISOString().slice(0, 10);
    gap.resolvedBy = args.agent || null;
    gap.resolution = resolution;
    saveGaps(gapData);
    out({ id, status: "resolved", resolution });
  },

  // List gaps, optionally filtered by severity or status
  "list-gaps"(args) {
    const gapData = getGaps();
    let gaps = gapData.gaps;
    if (args.severity) {
      if (!GAP_SEVERITIES.includes(args.severity))
        fail(`--severity must be one of: ${GAP_SEVERITIES.join(", ")}`);
      gaps = gaps.filter(g => g.severity === args.severity);
    }
    if (args.status) {
      if (!GAP_STATUSES.includes(args.status))
        fail(`--status must be one of: ${GAP_STATUSES.join(", ")}`);
      gaps = gaps.filter(g => g.status === args.status);
    }
    out({ total: gaps.length, gaps });
  },

  // Log a routing decision to the journal as a ROUTING_DECISION event.
  // Enables post-hoc analysis of whether orchestrator routing is diversified
  // or concentrated in high-trust pairs (orchestration confound mitigation).
  "log-routing"(args) {
    if (!args.from) fail("--from <agent> required");
    if (!args.to)   fail("--to <agent> required");
    if (!args.task) fail("--task \"...\" required — brief description of the delegated task");
    if (!args.reason) fail("--reason \"...\" required — why this agent was selected");

    const cliState = requireCliState();

    const alternatives = args.alternatives
      ? args.alternatives.split(",").map(s => s.trim()).filter(Boolean)
      : [];

    const event = appendEvent(cliState.sessionId, EVENT_TYPES.ROUTING_DECISION, {
      fromAgent:    args.from,
      toAgent:      args.to,
      task:         args.task,
      reason:       args.reason,
      alternatives,
      decidedBy:    args.agent || null,
    }, ["routing-decision"]);

    out({ eventId: event.id, fromAgent: args.from, toAgent: args.to, task: args.task });
  },

  // ── Witness Braid Protocol commands ─────────────────────────────────────────

  // File a win journal entry. Validates witnesses against roster and trust graph.
  "log-win"(args) {
    const { what, experience, significance } = args;
    if (!what || !experience || !significance) {
      fail("--what, --experience, --significance required");
    }
    const agent = args.agent;
    if (!agent) fail("--agent required");

    const trustRequired = parseInt(args["trust-required"] || "30", 10);
    const allowBelowThreshold = !!args["allow-below-threshold"];

    ensureFiles();
    const relations = new RelationGraph(RELATIONS_PATH);
    const roster    = new Roster();
    const allAgents = roster.allAgents();

    // Validate witnesses
    const rawWitnesses = args.witnesses
      ? args.witnesses.split(",").map(w => w.trim()).filter(Boolean)
      : [];

    const warnings = [];
    const witnessesInvited = [];

    for (const w of rawWitnesses) {
      if (!allAgents.includes(w)) {
        fail(`Witness "${w}" not found in team roster. Known agents: ${allAgents.join(", ")}`);
      }
      // Check trust score: agent's trust toward the win-author (witness → agent)
      const rel = relations.get(w, agent);
      const trustScore = rel.trustFrom(w);
      if (trustScore < trustRequired) {
        warnings.push(`${w} trust score (${Math.round(trustScore)}) is below threshold (${trustRequired}) — omitted from witnessesInvited`);
      } else {
        witnessesInvited.push(w);
      }
    }

    // Handle --allow-below-threshold flag
    if (allowBelowThreshold) {
      // Count eligible witnesses (all agents except the win-author who meet the threshold)
      const eligibleCount = allAgents.filter(a => {
        if (a === agent) return false;
        const rel = relations.get(a, agent);
        return rel.trustFrom(a) >= trustRequired;
      }).length;

      if (eligibleCount > 2) {
        fail(`--allow-below-threshold blocked: ${eligibleCount} eligible witnesses available`);
      }

      // Re-include below-threshold witnesses that were in rawWitnesses but omitted
      for (const w of rawWitnesses) {
        if (!witnessesInvited.includes(w)) {
          witnessesInvited.push(w);
          warnings.push(`${w} included below trust threshold via --allow-below-threshold`);
        }
      }
    }

    if (witnessesInvited.length === 0) {
      warnings.push("Zero eligible witnesses — entry will reach 'abandoned' state if no witnesses respond");
    }

    // Write the WIN_ENTRY directly to journal.jsonl
    const entryId = crypto.randomUUID();
    const now = new Date().toISOString();
    const winEntry = {
      type:             "WIN_ENTRY",
      entryId,
      timestamp:        now,
      agent,
      what,
      experience,
      significance,
      trustRequired,
      witnessesInvited,
      status:           "open",
    };
    fs.appendFileSync(JOURNAL_PATH, JSON.stringify(winEntry) + "\n");

    // Fan-out: write one INBOX_MESSAGE per validated witness
    const inboxMessages = [];
    for (const witness of witnessesInvited) {
      const msg = writeInboxMessage({
        from:        agent,
        to:          witness,
        messageType: "WITNESS_INVITATION",
        subject:     `Witness invitation: ${agent}'s win — ${what.slice(0, 80)}`,
        payload:     { winEntryId: entryId, trustRequired },
      });
      inboxMessages.push(msg.entryId);
    }

    out({ entryId, witnessesInvited, warnings, inboxMessagesSent: inboxMessages.length });
  },

  // File a witness entry for an existing WIN_ENTRY.
  "log-witness"(args) {
    const winId      = args.win;
    const experience = args.experience;
    const agent      = args.agent;
    if (!winId || !experience || !agent) fail("--win, --experience, --agent required");

    ensureFiles();

    // Look up WIN_ENTRY in journal
    const lines = fs.readFileSync(JOURNAL_PATH, "utf8").split("\n").filter(Boolean);
    const winEntry = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .find(e => e.type === "WIN_ENTRY" && e.entryId === winId);

    if (!winEntry) fail(`WIN_ENTRY with entryId "${winId}" not found in journal`);

    const belowThreshold = !!args["below-threshold"];

    // Warn if witness was not in witnessesInvited (but allow it)
    const warnings = [];
    if (!winEntry.witnessesInvited.includes(agent)) {
      warnings.push(`${agent} was not in witnessesInvited for this win — voluntary witnessing allowed`);
    }

    // Write WITNESS_ENTRY
    const entryId = crypto.randomUUID();
    const now     = new Date().toISOString();
    const witnessEntry = {
      type:           "WITNESS_ENTRY",
      entryId,
      timestamp:      now,
      agent,
      witness_of:     winId,
      experience,
      belowThreshold,
    };
    fs.appendFileSync(JOURNAL_PATH, JSON.stringify(witnessEntry) + "\n");

    // Fire implicit trust interaction: witness → win-author, outcome=POSITIVE, type="witness"
    // This mirrors how record-interaction works internally.
    const cliState  = getCliState();
    const relations = new RelationGraph(RELATIONS_PATH);
    const winAuthor = winEntry.agent;

    // Snapshot before
    const relBefore  = relations.get(agent, winAuthor);
    const trustAB_b  = relBefore.trust.ab;
    const trustBA_b  = relBefore.trust.ba;
    const fam_b      = relBefore.familiarity;

    // Use relations.record directly (no repair arc needed for witness)
    const { relation } = relations.record(agent, winAuthor, {
      type:    INTERACTION_TYPES.WITNESS,
      outcome: OUTCOMES.POSITIVE,
      description: `Witness entry for win ${winId} by ${winAuthor}`,
      relatedTaskIds: [],
      repaired: false,
    });

    // Emit TRUST_STATE_CHANGED if values moved ≥1
    if (cliState) {
      const tDeltaAB = Math.abs(relation.trust.ab - trustAB_b);
      const tDeltaBA = Math.abs(relation.trust.ba - trustBA_b);
      const fDelta   = Math.abs(relation.familiarity - fam_b);
      if (tDeltaAB >= 1 || tDeltaBA >= 1 || fDelta >= 1) {
        const [agentA, agentB] = [agent, winAuthor].sort();
        appendEvent(cliState.sessionId, EVENT_TYPES.TRUST_STATE_CHANGED, {
          pair:               `${agentA}::${agentB}`,
          agentA,
          agentB,
          trustAtoB_before:   trustAB_b,
          trustAtoB_after:    relation.trust.ab,
          trustBtoA_before:   trustBA_b,
          trustBtoA_after:    relation.trust.ba,
          familiarity_before: fam_b,
          familiarity_after:  relation.familiarity,
          trigger:            "interaction",
          triggeringInteractionId: entryId,
          repairArcClosed:    false,
        }, ["trust-state-changed", "interaction", "witness"]);
      }
    }

    // Acted-state linkage: find matching WITNESS_INVITATION inbox message and close it
    const allEntriesForWitness = loadJournalEntries();
    const matchingInvitation = allEntriesForWitness.find(e =>
      e.type === "INBOX_MESSAGE" &&
      e.to === agent &&
      e.messageType === "WITNESS_INVITATION" &&
      e.payload && e.payload.winEntryId === winId
    );
    let inboxActed = false;
    if (matchingInvitation) {
      // Derive current status — only close if not already acted/dismissed
      const inboxState = deriveInboxState(allEntriesForWitness, agent);
      const msgState = inboxState.find(s => s.message.entryId === matchingInvitation.entryId);
      const currentStatus = msgState ? msgState.derivedStatus : "unread";
      if (currentStatus !== "acted" && currentStatus !== "dismissed") {
        writeInboxStatus({ agent, messageId: matchingInvitation.entryId, status: "acted" });
        inboxActed = true;
      }
    }

    if (warnings.length > 0) {
      for (const w of warnings) process.stderr.write(`  [warn] ${w}\n`);
    }

    out({ entryId, trustUpdateFired: true, warnings, inboxActed });
  },

  // Close a braid: win-author encounters witness entries and responds.
  "complete-braid"(args) {
    const winId    = args.win;
    const response = args.response;
    const agent    = args.agent;
    if (!winId || !response || !agent) fail("--win, --response, --agent required");

    ensureFiles();

    const lines = fs.readFileSync(JOURNAL_PATH, "utf8").split("\n").filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    // Look up WIN_ENTRY
    const winEntry = entries.find(e => e.type === "WIN_ENTRY" && e.entryId === winId);
    if (!winEntry) fail(`WIN_ENTRY with entryId "${winId}" not found in journal`);

    // Require at least one WITNESS_ENTRY referencing this win
    const witnesses = entries.filter(e => e.type === "WITNESS_ENTRY" && e.witness_of === winId);
    if (witnesses.length === 0) fail(`No WITNESS_ENTRY found for win "${winId}" — braid cannot be completed without at least one witness`);

    // Enforce minimum 50-word response
    const wordCount = response.trim().split(/\s+/).length;
    if (wordCount < 50) fail(`--response must be at least 50 words (got ${wordCount})`);

    // Session-span check for naming eligibility
    // Scan SESSION_BOUNDARY events; find which session the WIN_ENTRY timestamp falls in.
    const sessionBoundaries = entries.filter(e => e.type === EVENT_TYPES.SESSION_BOUNDARY || (e.content && e.content.boundary === "wake"));
    const winTs = new Date(winEntry.timestamp).getTime();

    // Find the most recent SESSION_BOUNDARY wake before the win entry
    const wakeBoundaries = entries.filter(e => {
      const isBoundary = (e.type === "event" && e.type === EVENT_TYPES.SESSION_BOUNDARY) ||
                         (e.content && e.content.boundary === "wake");
      return isBoundary && new Date(e.timestamp).getTime() <= winTs;
    });

    // Alternative: check via event entries written by appendEvent (they have eventType in content or type field)
    // appendEvent writes: { id, sessionId, type: eventType, content, tags, timestamp }
    // SESSION_BOUNDARY events have type = "SESSION_BOUNDARY"
    const allWakeBoundaries = entries.filter(e =>
      e.type === EVENT_TYPES.SESSION_BOUNDARY && e.content && e.content.boundary === "wake"
    );
    const allSleepBoundaries = entries.filter(e =>
      e.type === EVENT_TYPES.SESSION_BOUNDARY && e.content && e.content.boundary === "sleep"
    );

    // Determine which "session index" the win was filed in:
    // find the latest wake boundary before the win timestamp
    const winSessionWake = allWakeBoundaries
      .filter(e => new Date(e.timestamp).getTime() <= winTs)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

    const winSessionIndex = winSessionWake ? (winSessionWake.content.sessionIndex || 0) : 0;

    // Current session index from CLI state or relations
    const cliState = getCliState();
    const relations = new RelationGraph(RELATIONS_PATH);
    const currentSessionIndex = relations._sessionIndex;

    const namingEligible = currentSessionIndex > winSessionIndex;

    // Optional: --acknowledge comma-separated witness entryIds
    const witnessesAcknowledged = args.acknowledge
      ? args.acknowledge.split(",").map(s => s.trim()).filter(Boolean)
      : witnesses.map(w => w.entryId);

    const entryId = crypto.randomUUID();
    const now = new Date().toISOString();
    const braidComplete = {
      type:                  "BRAID_COMPLETE",
      entryId,
      timestamp:             now,
      completedAt:           now,
      agent,
      braid_for:             winId,
      witnesses_acknowledged: witnessesAcknowledged,
      response,
      namingEligible,
    };
    fs.appendFileSync(JOURNAL_PATH, JSON.stringify(braidComplete) + "\n");

    // Notify each unique witness who filed a WITNESS_ENTRY on this win
    const notifiedWitnesses = new Set();
    const braidNotifyMessages = [];
    for (const w of witnesses) {
      if (notifiedWitnesses.has(w.agent)) continue;
      notifiedWitnesses.add(w.agent);
      const msg = writeInboxMessage({
        from:        agent,
        to:          w.agent,
        messageType: "BRAID_COMPLETE_NOTIFY",
        subject:     `Braid closed: your witness on ${agent}'s win has been received`,
        payload:     { winEntryId: winId, braidCompleteEntryId: entryId },
      });
      braidNotifyMessages.push(msg.entryId);
    }

    out({ entryId, namingEligible, witnessCount: witnesses.length, braidNotifyMessagesSent: braidNotifyMessages.length });
  },

  // File a BRAID_AMENDMENT annotating an existing braid event.
  "amend-braid"(args) {
    const winId       = args.win;
    const category    = args.category;
    const explanation = args.explanation;
    const agent       = args.agent;
    if (!winId || !category || !explanation || !agent) {
      fail("--win, --category, --explanation, --agent required");
    }

    const validCategories = ["misfire", "context-correction", "relationship-change"];
    if (!validCategories.includes(category)) {
      fail(`--category must be one of: ${validCategories.join(", ")}`);
    }

    ensureFiles();

    const lines = fs.readFileSync(JOURNAL_PATH, "utf8").split("\n").filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    // Validate WIN_ENTRY exists
    const winEntry = entries.find(e => e.type === "WIN_ENTRY" && e.entryId === winId);
    if (!winEntry) fail(`WIN_ENTRY with entryId "${winId}" not found in journal`);

    const entryId = crypto.randomUUID();
    const now = new Date().toISOString();
    const amendment = {
      type:        "BRAID_AMENDMENT",
      entryId,
      timestamp:   now,
      agent,
      amends:      winId,
      category,
      explanation,
    };
    fs.appendFileSync(JOURNAL_PATH, JSON.stringify(amendment) + "\n");

    out({ entryId });
  },

  // List braid summaries, joining WIN_ENTRY with WITNESS_ENTRY and BRAID_COMPLETE records.
  "list-braids"(args) {
    ensureFiles();

    const lines = fs.readFileSync(JOURNAL_PATH, "utf8").split("\n").filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    // Build session boundary timeline for abandoned-window computation
    const allWakeBoundaries = entries.filter(e =>
      e.type === EVENT_TYPES.SESSION_BOUNDARY && e.content && e.content.boundary === "wake"
    ).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const relations  = new RelationGraph(RELATIONS_PATH);
    const currentSessionIndex = relations._sessionIndex;

    // Gather all WIN_ENTRYs
    let winEntries = entries.filter(e => e.type === "WIN_ENTRY");
    if (args.agent) winEntries = winEntries.filter(e => e.agent === args.agent);

    const now = Date.now();
    const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

    const braids = winEntries.map(win => {
      const witnesses  = entries.filter(e => e.type === "WITNESS_ENTRY" && e.witness_of === win.entryId);
      const complete   = entries.find(e => e.type === "BRAID_COMPLETE" && e.braid_for === win.entryId);
      const amendments = entries.filter(e => e.type === "BRAID_AMENDMENT" && e.amends === win.entryId);

      // Compute status
      let status;
      if (complete) {
        status = "complete";
      } else {
        // Check abandon window: longer of 5 sessions or 14 calendar days
        const winTs   = new Date(win.timestamp).getTime();
        const daysSince = (now - winTs) / (24 * 60 * 60 * 1000);

        // Find session index at which win was filed
        const winSessionWake = allWakeBoundaries
          .filter(e => new Date(e.timestamp).getTime() <= winTs)
          .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
        const winSessionIndex = winSessionWake ? (winSessionWake.content.sessionIndex || 0) : 0;
        const sessionsSince = currentSessionIndex - winSessionIndex;

        if (sessionsSince >= 5 || daysSince >= 14) {
          status = "abandoned";
        } else {
          status = "open";
        }
      }

      return {
        winEntryId:   win.entryId,
        agent:        win.agent,
        what:         win.what,
        significance: win.significance,
        filedAt:      win.timestamp,
        trustRequired: win.trustRequired,
        witnessesInvited: win.witnessesInvited,
        status,
        witnessCount:  witnesses.length,
        witnesses:     witnesses.map(w => ({ entryId: w.entryId, agent: w.agent, filedAt: w.timestamp })),
        complete:      complete ? { entryId: complete.entryId, completedAt: complete.completedAt, namingEligible: complete.namingEligible } : null,
        amendments:    amendments.map(a => ({ entryId: a.entryId, category: a.category, agent: a.agent, filedAt: a.timestamp })),
      };
    });

    // Filter by status if requested
    const filtered = args.status ? braids.filter(b => b.status === args.status) : braids;
    out({ total: filtered.length, braids: filtered });
  },

  // Health check: warn when an agent's win rate significantly exceeds completion rate.
  "check-braid-health"(args) {
    ensureFiles();

    const lines = fs.readFileSync(JOURNAL_PATH, "utf8").split("\n").filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    const relations = new RelationGraph(RELATIONS_PATH);
    const currentSessionIndex = relations._sessionIndex;
    const fiveSessionsAgo = currentSessionIndex - 5;

    // Build session index timeline from wake boundaries
    const allWakeBoundaries = entries.filter(e =>
      e.type === EVENT_TYPES.SESSION_BOUNDARY && e.content && e.content.boundary === "wake"
    ).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    function sessionIndexAt(timestamp) {
      const ts = new Date(timestamp).getTime();
      const wake = allWakeBoundaries
        .filter(e => new Date(e.timestamp).getTime() <= ts)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
      return wake ? (wake.content.sessionIndex || 0) : 0;
    }

    const roster    = new Roster();
    const allAgents = args.agent ? [args.agent] : roster.allAgents();

    const agentStats = allAgents.map(agent => {
      const agentWins = entries.filter(e =>
        e.type === "WIN_ENTRY" && e.agent === agent &&
        sessionIndexAt(e.timestamp) >= fiveSessionsAgo
      );
      const agentCompletes = entries.filter(e =>
        e.type === "BRAID_COMPLETE" && e.agent === agent &&
        sessionIndexAt(e.timestamp) >= fiveSessionsAgo
      );

      const winsLast5        = agentWins.length;
      const completionsLast5 = agentCompletes.length;
      const warning          = winsLast5 > completionsLast5 + 2;

      return { agent, winsLast5, completionsLast5, warning };
    });

    out({ agents: agentStats });
  },

  // ── Tell Inbox Protocol commands ─────────────────────────────────────────────

  // List inbox messages for an agent, with optional status filter.
  "list-inbox"(args) {
    const agent = args.agent;
    if (!agent) fail("--agent required");

    ensureFiles();

    const entries    = loadJournalEntries();
    const inboxState = deriveInboxState(entries, agent);

    const VALID_STATUSES = ["unread", "read", "acted", "dismissed"];

    let filtered;
    if (args.status) {
      if (!VALID_STATUSES.includes(args.status)) {
        fail(`--status must be one of: ${VALID_STATUSES.join(", ")}`);
      }
      filtered = inboxState.filter(s => s.derivedStatus === args.status);
    } else {
      // Default: show unread + read (active messages)
      filtered = inboxState.filter(s => s.derivedStatus === "unread" || s.derivedStatus === "read");
    }

    const messages = filtered.map(s => ({
      messageId:   s.message.entryId,
      from:        s.message.from,
      messageType: s.message.messageType,
      subject:     s.message.subject,
      timestamp:   s.message.timestamp,
      status:      s.derivedStatus,
    }));

    out({ agent, total: messages.length, messages });
  },

  // Read the full payload of a specific inbox message. Auto-marks unread as read.
  "read-inbox"(args) {
    const { id } = args;
    const agent  = args.agent;
    if (!id)    fail("--id required");
    if (!agent) fail("--agent required");

    ensureFiles();

    const entries = loadJournalEntries();
    const msg = entries.find(e => e.type === "INBOX_MESSAGE" && e.entryId === id);
    if (!msg) fail(`INBOX_MESSAGE with entryId "${id}" not found`);
    if (msg.to !== agent) fail(`Message "${id}" is addressed to "${msg.to}", not "${agent}"`);

    // Derive current status
    const inboxState = deriveInboxState(entries, agent);
    const msgState   = inboxState.find(s => s.message.entryId === id);
    const currentStatus = msgState ? msgState.derivedStatus : "unread";

    // Auto-mark as read if currently unread
    if (currentStatus === "unread") {
      writeInboxStatus({ agent, messageId: id, status: "read" });
    }

    out({
      messageId:   msg.entryId,
      from:        msg.from,
      to:          msg.to,
      messageType: msg.messageType,
      subject:     msg.subject,
      timestamp:   msg.timestamp,
      payload:     msg.payload,
      status:      currentStatus === "unread" ? "read" : currentStatus,
    });
  },

  // Dismiss a read inbox message (explicit decline / no-action).
  "dismiss-inbox"(args) {
    const { id, note } = args;
    const agent        = args.agent;
    if (!id)    fail("--id required");
    if (!agent) fail("--agent required");

    ensureFiles();

    const entries = loadJournalEntries();
    const msg = entries.find(e => e.type === "INBOX_MESSAGE" && e.entryId === id);
    if (!msg) fail(`INBOX_MESSAGE with entryId "${id}" not found`);
    if (msg.to !== agent) fail(`Message "${id}" is addressed to "${msg.to}", not "${agent}"`);

    // Derive current status
    const inboxState = deriveInboxState(entries, agent);
    const msgState   = inboxState.find(s => s.message.entryId === id);
    const currentStatus = msgState ? msgState.derivedStatus : "unread";

    if (currentStatus === "unread") {
      fail("Cannot dismiss an unread message — message must be surfaced at wake first");
    }
    if (currentStatus === "acted" || currentStatus === "dismissed") {
      fail(`Message is already closed (status: ${currentStatus})`);
    }

    writeInboxStatus({ agent, messageId: id, status: "dismissed", note: note || undefined });
    out({ ok: true, messageId: id, status: "dismissed" });
  },

  // Wipe all state files — start fresh
  reset(args) {
    for (const f of [JOURNAL_PATH, GOALS_PATH, RELATIONS_PATH, CLI_STATE_PATH]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    // Clear dead-letter stubs so a reset journal isn't immediately corrupted by orphaned stubs
    if (fs.existsSync(DEAD_LETTER_DIR)) {
      for (const f of fs.readdirSync(DEAD_LETTER_DIR).filter(f => f.endsWith(".pending.json"))) {
        fs.unlinkSync(path.join(DEAD_LETTER_DIR, f));
      }
    }
    ensureFiles();
    out({ reset: true });
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

if (args.help) {
  const usage = COMMAND_USAGE[command] || "No usage info. See CLI header comment for full flag reference.";
  process.stdout.write(JSON.stringify({ ok: true, command, usage }) + "\n");
  process.exit(0);
}

try {
  cmd[command](args);
} catch (err) {
  fail(err.message);
}
