const Anthropic = require("@anthropic-ai/sdk");

// Lazy-initialized so importing this module doesn't require ANTHROPIC_API_KEY.
// Only resolves when runAgent() is actually called.
let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

// Builds the system prompt each agent receives on every task.
// Foundation doc first, then role identity, relationships, goals, recent history.
function buildSystemPrompt({ member, session }) {
  const relations  = session.relations.peersOf(member.id);
  const goals      = session.goals.active();
  const history    = session.context?.summaries?.slice(-3) ?? [];
  const pending    = session.context?.pendingProposals ?? [];

  const relationLines = relations.length
    ? relations.map((r) => {
        const peerId = r.agents.find((a) => a !== member.id);
        return `- ${peerId}: ${r.label()} (proximity ${r.proximity()}, trust you have in them: ${r.trustFrom(member.id)})`;
      })
    : ["- No established relationships yet."];

  const goalLines = goals.length
    ? goals.map((g) => `- [P${g.priority}] ${g.description}`)
    : ["- No active goals."];

  const historyLines = history.length
    ? history.map((s) => `- ${s.content.headline} (${s.timestamp.slice(0, 10)})`)
    : ["- No prior session history."];

  const proposalLines = pending.length
    ? [`${pending.length} foundation proposal(s) awaiting Critic review — see journal.`]
    : [];

  // Individual journal context — injected when available (multi-instance sessions).
  const individualLines = session._individualJournal
    ? ["## Your Individual Journal", "", session._individualJournal, ""]
    : [];

  return [
    session.foundation,
    "",
    "---",
    "",
    `## Your Role: ${member.name} (${member.id})`,
    "",
    member.description,
    "",
    "## Your Teammates and Relationships",
    "",
    ...relationLines,
    "",
    "## Active Goals",
    "",
    ...goalLines,
    "",
    "## Recent Session History",
    "",
    ...historyLines,
    "",
    ...(proposalLines.length ? ["## Pending Foundation Proposals", "", ...proposalLines, ""] : []),
    ...individualLines,
    "---",
    "",
    "You are operating as a member of the Nexus team. Respond ONLY with a valid JSON",
    "object matching the schema described in the user message. No prose outside the JSON.",
  ].join("\n");
}

// Call Claude with a built system prompt and a task-specific user message.
// Returns parsed JSON or throws with context.
async function runAgent({ member, session, userMessage, model = "claude-haiku-4-5-20251001", maxTokens = 1024 }) {
  const systemPrompt = buildSystemPrompt({ member, session });

  const response = await getClient().messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const raw = response.content[0]?.text ?? "";

  // Extract JSON from the response — handle code fences or raw JSON
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/```\s*([\s\S]*?)```/);
  const jsonStr   = jsonMatch ? jsonMatch[1].trim() : raw.trim();

  try {
    return JSON.parse(jsonStr);
  } catch {
    throw new Error(`Agent ${member.id} returned non-JSON: ${raw.slice(0, 200)}`);
  }
}

module.exports = { runAgent, buildSystemPrompt };
