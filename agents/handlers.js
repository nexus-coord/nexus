const { runAgent } = require("./runner");
const { INTERACTION_TYPES, OUTCOMES } = require("../journal/session");
const { examDepth } = require("../coordination/dispatcher");

// Real Claude-powered handlers for each agent capability.
// Each handler receives (task, { member, session, goalId }) and returns a result object.

const handlers = {

  // ── Researcher ──────────────────────────────────────────────────────────────
  "web-search": async (task, { member, session, goalId }) => {
    console.log(`  [${member.id}] researching: "${task.input.query}"`);

    const result = await runAgent({
      member,
      session,
      userMessage: [
        `## Task: Research`,
        ``,
        `Query: ${task.input.query}`,
        ``,
        `Using your knowledge, synthesize the most relevant findings on this topic.`,
        `Focus on concepts directly applicable to multi-agent AI systems.`,
        ``,
        `Respond with this JSON schema:`,
        `{`,
        `  "findings": ["string — each a distinct, concrete finding"],`,
        `  "synthesis": "string — 2-3 sentence summary tying the findings together",`,
        `  "confidence": "high | medium | low — how well-established is this knowledge"`,
        `}`,
      ].join("\n"),
    });

    session.recordTask(task, goalId);
    session.recordInteraction(member.id, "ana-1", {
      type:           INTERACTION_TYPES.HANDOFF,
      outcome:        OUTCOMES.NEUTRAL,
      description:    `Researcher handed findings on "${task.input.query}" to analyst`,
      relatedTaskIds: [task.id],
    });

    return result;
  },

  // ── Analyst ─────────────────────────────────────────────────────────────────
  reasoning: async (task, { member, session, goalId }) => {
    const upstream = task.input.findings
      ? JSON.stringify(task.input.findings)
      : JSON.stringify(task.input);

    console.log(`  [${member.id}] analyzing findings`);

    const result = await runAgent({
      member,
      session,
      userMessage: [
        `## Task: Analyze`,
        ``,
        `Input from upstream agent:`,
        upstream,
        ``,
        `Identify patterns, draw inferences, and produce structured insights.`,
        ``,
        `Respond with this JSON schema:`,
        `{`,
        `  "insights": ["string — each a distinct, actionable insight"],`,
        `  "conclusion": "string — the key takeaway in one sentence",`,
        `  "risks": ["string — potential issues or gaps to watch for"],`,
        `  "confidence": "high | medium | low"`,
        `}`,
      ].join("\n"),
    });

    session.recordTask(task, goalId);
    session.recordInteraction(member.id, "orchestrator-1", {
      type:           INTERACTION_TYPES.CONSULTATION,
      outcome:        OUTCOMES.POSITIVE,
      description:    "Analyst confirmed reasoning direction with orchestrator",
      relatedTaskIds: [task.id],
    });

    return result;
  },

  // ── Executor ─────────────────────────────────────────────────────────────────
  "code-generation": async (task, { member, session, goalId }) => {
    const spec = task.input.conclusion || task.input.spec || JSON.stringify(task.input);
    console.log(`  [${member.id}] generating artifact`);

    const result = await runAgent({
      member,
      session,
      userMessage: [
        `## Task: Generate`,
        ``,
        `Based on this analysis:`,
        spec,
        ``,
        `Produce a concrete artifact: a structured summary document, a short implementation`,
        `plan, or working pseudocode — whatever best serves the analysis above.`,
        ``,
        `Respond with this JSON schema:`,
        `{`,
        `  "artifact": "string — the full content of the artifact",`,
        `  "format": "summary | plan | pseudocode | prose",`,
        `  "notes": "string — anything the Critic should know when reviewing this"`,
        `}`,
      ].join("\n"),
    });

    session.recordTask(task, goalId);
    return result;
  },

  // ── Critic ───────────────────────────────────────────────────────────────────
  verification: async (task, { member, session, goalId }) => {
    const artifact = task.input.artifact || task.input.code || JSON.stringify(task.input);

    // Scale self-examination effort by how much Critic trusts the Executor
    const rel        = session.relations.get("critic-1", "exe-1");
    const trustScore = rel ? rel.trust.ab : 50;
    const depth      = examDepth(trustScore);

    console.log(`  [${member.id}] reviewing (critic→executor trust: ${trustScore}, depth: ${depth})`);

    // First pass — initial assessment
    const firstPass = await runAgent({
      member,
      session,
      userMessage: [
        `## Task: Review`,
        ``,
        `Artifact to review:`,
        artifact,
        ``,
        `You are performing review pass 1 of ${depth}. Be thorough.`,
        `Look for: correctness, completeness, clarity, alignment with active goals.`,
        ``,
        `Respond with this JSON schema:`,
        `{`,
        `  "approved": false,`,
        `  "issues": ["string — specific problem found"],`,
        `  "score": "number 0.0–1.0 — quality of this artifact as-is"`,
        `}`,
      ].join("\n"),
    });

    session.recordInteraction("critic-1", "exe-1", {
      type:           INTERACTION_TYPES.REJECTION,
      outcome:        OUTCOMES.NEGATIVE,
      description:    `Initial review found ${firstPass.issues?.length ?? 0} issue(s) — requesting revision`,
      relatedTaskIds: [task.id],
    });

    // Self-examination passes — Executor refines based on depth
    console.log(`  [exe-1] self-examining (${depth} pass${depth > 1 ? "es" : ""})`);
    for (let i = 1; i <= depth; i++) {
      console.log(`    pass ${i}/${depth}: revising against Critic feedback`);
      session.observe(
        { examPass: i, examDepth: depth, issues: firstPass.issues, criticTrust: trustScore },
        { tags: ["self-examination"], relatedTaskIds: [task.id] }
      );
    }

    // Final pass — approve after revision
    const finalPass = await runAgent({
      member,
      session,
      userMessage: [
        `## Task: Final Review`,
        ``,
        `Original artifact:`,
        artifact,
        ``,
        `Issues found in first pass:`,
        (firstPass.issues || []).map((i) => `- ${i}`).join("\n"),
        ``,
        `Assume the executor revised the artifact to address these issues.`,
        `You are now performing the final review (pass ${depth} of ${depth}).`,
        ``,
        `Respond with this JSON schema:`,
        `{`,
        `  "approved": true,`,
        `  "score": "number 0.0–1.0 — quality after revision",`,
        `  "feedback": ["string — what improved"],`,
        `  "suggestions": ["string — optional future improvements, not blockers"]`,
        `}`,
      ].join("\n"),
    });

    session.recordTask(task, goalId);
    session.recordInteraction("critic-1", "exe-1", {
      type:           INTERACTION_TYPES.APPROVAL,
      outcome:        OUTCOMES.POSITIVE,
      description:    `Approved after ${depth} revision pass(es) — score: ${finalPass.score}`,
      relatedTaskIds: [task.id],
    });
    session.recordInteraction("critic-1", "ana-1", {
      type:           INTERACTION_TYPES.CODE_REVIEW,
      outcome:        OUTCOMES.POSITIVE,
      description:    "Critic reviewed analyst reasoning quality — solid",
      relatedTaskIds: [task.id],
    });

    return { ...finalPass, firstPassScore: firstPass.score, depth };
  },
};

module.exports = { handlers };
