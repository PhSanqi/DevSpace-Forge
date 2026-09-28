const output = {
  args: process.argv.slice(2),
  configDir: process.env.DEVSPACE_CONFIG_DIR || null,
  subagents: process.env.DEVSPACE_SUBAGENTS || null,
  toolMode: process.env.DEVSPACE_TOOL_MODE || null,
};

console.log(JSON.stringify(output));
