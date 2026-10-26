import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, rm, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { state, root, assertPrivateState, saveJson } from "./runtime.mjs";
import { readRecovery } from "./pilot-supervisor.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { serviceProgramArguments } from "./configuration.mjs";

process.umask(0o077);
if (process.platform !== "darwin") throw new Error("This service installer targets macOS launchd");
if (process.versions.node.split(".")[0] !== "22") throw new Error("Run the installer with Node 22");
assertPrivateState(state);
const command = process.argv[2];
if (!["install", "start", "stop", "status", "resume", "uninstall"].includes(command))
  throw new Error("Use install, start, stop, status, resume or uninstall");
const label = "com.newwestern.mudfut-pilot";
const domain = `gui/${process.getuid()}`;
const target = `${domain}/${label}`;
const plist = join(homedir(), "Library", "LaunchAgents", label + ".plist");
const launchctl = (args) =>
  execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const loaded = () => {
  try {
    launchctl(["print", target]);
    return true;
  } catch {
    return false;
  }
};
async function stopService() {
  if (!loaded()) return;
  let pid;
  try {
    pid = JSON.parse(await readFile(join(state, "supervisor-process.json"), "utf8")).pid;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  launchctl(["bootout", target]);
  // Do not reset the budget while the old supervisor can still write it.
  const deadline = Date.now() + 30000;
  while (pid) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline)
      throw new Error("Supervisor has not stopped; inspect before resuming");
    await delay(100);
  }
}
const xml = (s) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
if (command === "install") {
  // Validate private configuration exists before registering persistent startup.
  for (const name of ["pilot.json", "postgres.json", "discord-token"])
    await readFile(join(state, name));
  if (loaded()) throw new Error("Stop the existing service before reinstalling it");
  await mkdir(dirname(plist), { recursive: true });
  const log = join(state, "supervisor.log");
  const handle = await open(log, "a", 0o600);
  await handle.close();
  await writeFile(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${serviceProgramArguments(process.execPath, root)
      .map((argument) => `<string>${xml(argument)}</string>`)
      .join("")}</array>
<key>WorkingDirectory</key><string>${xml(resolve(root, "../.."))}</string>
<key>EnvironmentVariables</key><dict><key>MUDFUT_STATE_DIR</key><string>${xml(state)}</string><key>MUDFUT_AUTH_MODE</key><string>letta</string><key>PATH</key><string>${xml(dirname(process.execPath))}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer><key>ExitTimeOut</key><integer>25</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>\n`,
    { mode: 0o600 },
  );
  launchctl(["bootstrap", domain, plist]);
} else if (command === "start") {
  if (!loaded()) launchctl(["bootstrap", domain, plist]);
  else launchctl(["kickstart", target]);
} else if (command === "stop" || command === "uninstall") {
  await stopService();
  if (command === "uninstall") await rm(plist, { force: true });
} else if (command === "resume") {
  await stopService();
  // Explicit operator action resets the latched retry budget; pending work stays.
  const previous = await readRecovery(state);
  await saveJson(join(state, `recovery-resume-${Date.now()}.json`), previous);
  await saveJson(join(state, "pilot-recovery.json"), { failures: [], held: false, running: false });
  launchctl(["bootstrap", domain, plist]);
}
console.log(
  JSON.stringify(
    {
      service: target,
      loaded: loaded(),
      recovery: await readRecovery(state),
      stateDirectory: state,
    },
    null,
    2,
  ),
);
