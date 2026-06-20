const { Team } = require("../team/team");

// Example: a general-purpose research-and-execute team
const defaultTeam = new Team("Nexus Alpha", "Assist with complex multi-step tasks")
  .addMember("orch-1", "orchestrator")
  .addMember("res-1", "researcher")
  .addMember("ana-1", "analyst")
  .addMember("exe-1", "executor")
  .addMember("crit-1", "critic");

console.log("Team:", defaultTeam.name);
console.log("Goal:", defaultTeam.goal);
console.log("Roster:", JSON.stringify(defaultTeam.roster(), null, 2));

module.exports = { defaultTeam };
