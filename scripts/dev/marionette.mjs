// Minimal Marionette client for driving the dev Thunderbird instance.
import net from "node:net";
import { readFile, writeFile } from "node:fs/promises";

const PORT = Number(process.env.MARIONETTE_PORT || 2829);
// In ms; Marionette's own default is 30 s.
const SCRIPT_TIMEOUT = Number(process.env.MARIONETTE_SCRIPT_TIMEOUT || 60000);

class Client {
  constructor() {
    this.id = 0;
    this.buffer = "";
    this.waiting = new Map();
    this.greeting = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.connect(PORT, "127.0.0.1");
      this.socket.setEncoding("utf8");
      this.socket.on("error", reject);
      this.socket.on("data", chunk => {
        this.buffer += chunk;
        for (;;) {
          const colon = this.buffer.indexOf(":");
          if (colon < 0) return;
          const len = Number(this.buffer.slice(0, colon));
          // Length is in bytes; compare via Buffer.
          const rest = Buffer.from(this.buffer.slice(colon + 1), "utf8");
          if (rest.length < len) return;
          const body = rest.subarray(0, len).toString("utf8");
          this.buffer = rest.subarray(len).toString("utf8");
          const msg = JSON.parse(body);
          if (!this.greeting) {
            this.greeting = msg;
            resolve();
            continue;
          }
          const [, id, error, result] = msg;
          const waiter = this.waiting.get(id);
          this.waiting.delete(id);
          if (error) waiter?.reject(new Error(`${error.error}: ${error.message}\n${error.stacktrace || ""}`));
          else waiter?.resolve(result);
        }
      });
    });
  }

  send(name, params = {}) {
    const id = ++this.id;
    const body = JSON.stringify([0, id, name, params]);
    this.socket.write(`${Buffer.byteLength(body)}:${body}`);
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
  }
}

const client = new Client();
await client.connect();
await client.send("WebDriver:NewSession", { capabilities: {} });
await client.send("Marionette:SetContext", { value: "chrome" });
await client.send("WebDriver:SetTimeouts", { script: SCRIPT_TIMEOUT });

const [mode, arg] = process.argv.slice(2);
try {
  if (mode === "--install") {
    const result = await client.send("Addon:Install", { path: arg, temporary: true });
    console.log("installed", result.value);
  } else if (mode === "--install-xpi" || mode === "--quit") {
    const script =
      mode === "--quit"
        ? `Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit); return "quitting";`
        : `const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
           const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
           const install = await AddonManager.getInstallForFile(new FileUtils.File(${JSON.stringify(arg)}));
           const postponed = new Promise(resolve => install.addListener({ onInstallPostponed: () => resolve(true) }));
           const installed = install.install();
           // A running Officebird keeps updates for the next start (runtime.onUpdateAvailable);
           // a dev build goes in right away, as runtime.reload() would do it.
           if (await Promise.race([installed.then(() => false), postponed])) {
             const upgrade = WebExtensionPolicy.getByID(install.addon.id)?.extension?.upgrade;
             if (!upgrade) {
               throw new Error("install postponed without an upgrade to resume");
             }
             upgrade.install();
             await installed;
           }
           const addon = await AddonManager.getAddonByID(install.addon.id);
           return { id: addon.id, version: addon.version, active: addon.isActive, error: install.error || null };`;
    const result = await client
      .send("WebDriver:ExecuteAsyncScript", {
        script: `const __done = arguments[arguments.length - 1];
          (async () => { ${script} })().then(v => __done(v), e => __done({ __error: String(e) }));`,
        args: [],
        scriptTimeout: 60000,
        newSandbox: true,
      })
      .catch(e => ({ value: mode === "--quit" ? "quitting" : { __error: String(e) } }));
    console.log(JSON.stringify(result.value));
  } else if (mode === "--click") {
    const [x, y] = process.argv.slice(3).map(Number);
    await client.send("WebDriver:PerformActions", {
      actions: [{
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", x, y, origin: "viewport" },
          { type: "pointerDown", button: 0 },
          { type: "pointerUp", button: 0 },
        ],
      }],
    });
    await client.send("WebDriver:ReleaseActions");
    console.log("clicked", x, y);
  } else if (mode === "--screenshot") {
    const result = await client.send("WebDriver:TakeScreenshot", {});
    await writeFile(arg, Buffer.from(result.value, "base64"));
    console.log("saved", arg);
  } else {
    const content = mode === "--content";
    if (content) {
      await client.send("Marionette:SetContext", { value: "content" });
    }
    const source = await readFile(content ? arg : mode, "utf8");
    const result = await client.send("WebDriver:ExecuteAsyncScript", {
      script: `const __done = arguments[arguments.length - 1];
        (async () => { ${source} })().then(v => __done(v), e => __done({ __error: String(e) + "\\n" + e.stack }));`,
      args: [],
      scriptTimeout: 60000,
      newSandbox: true,
    });
    console.log(JSON.stringify(result.value, null, 2));
  }
} finally {
  await client.send("WebDriver:DeleteSession").catch(() => {});
  client.socket.end();
}
