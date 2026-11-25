// Resolve both extension and test imports to the same Pi/TUI installation.
import { registerHooks, createRequire } from "node:module";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function packageRoot(): string {
  try { return fileURLToPath(new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent"))); }
  catch { return join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent"); }
}
const root = process.env.PI_PACKAGE_DIR ?? packageRoot();
const require = createRequire(join(root, "package.json"));
const tuiUrl = pathToFileURL(require.resolve("@earendil-works/pi-tui")).href;
const agentUrl = pathToFileURL(join(root, "dist", "index.js")).href;
const packagesUrl = pathToFileURL(join(root, "..")).href + "/";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.startsWith(packagesUrl)) {
      if (specifier === "@earendil-works/pi-tui") return { url: tuiUrl, shortCircuit: true };
      if (specifier === "@earendil-works/pi-coding-agent") return { url: agentUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
