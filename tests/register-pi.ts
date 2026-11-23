// Use the host's TUI implementation without installing duplicate runtime packages.
import { registerHooks, createRequire } from "node:module";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.PI_PACKAGE_DIR ?? join(execSync("npm root -g", {
  encoding: "utf8",
}).trim(), "@earendil-works", "pi-coding-agent");
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
