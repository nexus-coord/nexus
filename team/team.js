const { roles } = require("./roles");

// A Team groups agents together around a shared goal.
// Members reference role definitions and can be extended with instance-specific config.

class Team {
  constructor(name, goal) {
    this.name = name;
    this.goal = goal;
    this.members = {};
  }

  addMember(id, roleKey, overrides = {}) {
    if (!roles[roleKey]) throw new Error(`Unknown role: ${roleKey}`);
    this.members[id] = { ...roles[roleKey], id, ...overrides };
    return this;
  }

  removeMember(id) {
    delete this.members[id];
    return this;
  }

  roster() {
    return Object.values(this.members).map(({ id, name, description }) => ({
      id,
      name,
      description,
    }));
  }
}

module.exports = { Team };
