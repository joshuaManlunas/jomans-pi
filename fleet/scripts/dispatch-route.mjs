// Pi CLI/RPC sets PI_CODING_AGENT; Orca's managed Pi extensions guard on ORCA_PANE_KEY.
// Preserve Claude Code's path when it inherits the Pi environment.
const env = process.env;
const inOrcaPi = !env.CLAUDECODE
  && env.PI_CODING_AGENT === "true"
  && Boolean(env.ORCA_PANE_KEY);

console.log(inOrcaPi ? "orca" : "native");
