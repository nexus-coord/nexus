// Core agent role definitions for the Nexus team
// Each role describes an agent's purpose, capabilities, and interaction style.

const roles = {
  orchestrator: {
    name: "Orchestrator",
    description: "Breaks down high-level goals into subtasks and delegates to specialists.",
    capabilities: ["planning", "task-delegation", "synthesis"],
    interacts_with: ["researcher", "analyst", "executor"],
  },

  researcher: {
    name: "Researcher",
    description: "Gathers information from external sources and surfaces relevant context.",
    capabilities: ["web-search", "document-retrieval", "summarization"],
    interacts_with: ["orchestrator", "analyst"],
  },

  analyst: {
    name: "Analyst",
    description: "Evaluates gathered data, identifies patterns, and produces structured insights.",
    capabilities: ["reasoning", "comparison", "structured-output"],
    interacts_with: ["orchestrator", "researcher", "executor"],
  },

  executor: {
    name: "Executor",
    description: "Carries out concrete actions: writing code, editing files, running commands.",
    capabilities: ["code-generation", "file-edit", "bash-execution"],
    interacts_with: ["orchestrator", "analyst"],
  },

  critic: {
    name: "Critic",
    description: "Adversarially reviews outputs from other agents for correctness and completeness.",
    capabilities: ["verification", "gap-detection", "quality-scoring"],
    interacts_with: ["orchestrator", "analyst", "executor"],
  },
};

module.exports = { roles };
