import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

// Deliberate allowlist: an empty npmrc alone cannot override inherited npm_*.
export function createSmokeEnvironment(root, source = process.env) {
  const home = join(root, "home");
  const agent = join(root, "agent");
  const temporary = join(root, "tmp");
  for (const path of [home, agent, temporary, join(root, "npm-cache")]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const userconfig = join(root, "npmrc");
  const globalconfig = join(root, "npmrc-global");
  writeFileSync(userconfig, "", { mode: 0o600 });
  writeFileSync(globalconfig, "", { mode: 0o600 });
  const env = {
    PATH: source.PATH || [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter),
    LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"),
    TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig,
    npm_config_cache: join(root, "npm-cache"),
    PI_CODING_AGENT_DIR: agent, NEXT_TELEMETRY_DISABLED: "1",
    HISTFILE: process.platform === "win32" ? "NUL" : "/dev/null",
    SHELL: process.platform === "win32" ? (source.ComSpec || "cmd.exe") : "/bin/sh",
  };
  if (source.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = source.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      if (source[key]) env[key] = source[key];
    }
  }
  return env;
}
