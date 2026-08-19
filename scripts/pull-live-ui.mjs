/**
 * Downloads the deployed front end so it can be inspected locally.
 *
 *   node scripts/pull-live-ui.mjs
 *
 * Prompts for the app passphrase, signs in the same way a browser does, and
 * saves the app shell plus every asset it references into tmp/live-ui/.
 * The passphrase is read with echo off, never written to disk, and never
 * included in the saved output.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const ORIGIN = process.env.MACROFLOW_ORIGIN || "https://macro.montagnertudor.org";
const OUT = path.resolve("tmp/live-ui");

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (char) => {
      if (["\n", "\r", "\u0004"].includes(String(char))) return;
      readline.moveCursor(process.stdout, -1000, 0);
      readline.clearLine(process.stdout, 1);
      process.stdout.write(`${question}${"*".repeat(rl.line.length)}`);
    };
    process.stdin.on("data", onData);
    rl.question(question, (answer) => {
      process.stdin.removeListener("data", onData);
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

const save = (name, body) => {
  const file = path.join(OUT, name.replace(/^\/+/, "").replace(/[?#].*$/, ""));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return `${path.relative(process.cwd(), file)} (${(body.length / 1024).toFixed(1)} kB)`;
};

const passphrase = await askHidden("Macroflow passphrase: ");
if (!passphrase) { console.error("No passphrase entered."); process.exit(1); }

const login = await fetch(`${ORIGIN}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ password: passphrase }),
  redirect: "manual"
});
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
if (!cookie.startsWith("mf_session=")) {
  console.error(`Sign-in failed (HTTP ${login.status}). Check the passphrase, or wait out a lockout.`);
  process.exit(1);
}
console.log("Signed in.\n");

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const get = (url) => fetch(url, { headers: { cookie } });

const shell = await get(`${ORIGIN}/`);
const html = await shell.text();
console.log(" ", save("index.html", html));

// Every same-origin asset the shell pulls in, plus the fixed paths a PWA uses.
const referenced = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
const extras = ["/sw.js", "/service-worker.js", "/manifest.json", "/manifest.webmanifest", "/registerSW.js"];
for (const url of [...new Set([...referenced, ...extras])]) {
  const response = await get(`${ORIGIN}${url}`);
  if (!response.ok) { if (!extras.includes(url)) console.log(`  ${url} -> HTTP ${response.status}`); continue; }
  console.log(" ", save(url, Buffer.from(await response.arrayBuffer())));
}

// The API shapes reveal which features the deployed backend actually exposes.
for (const [name, url] of [["settings", "/api/settings"], ["dashboard", "/api/dashboard"]]) {
  const response = await get(`${ORIGIN}${url}`);
  if (response.ok) console.log(" ", save(`api-${name}.json`, await response.text()));
}

console.log(`\nSaved to ${path.relative(process.cwd(), OUT)}`);
