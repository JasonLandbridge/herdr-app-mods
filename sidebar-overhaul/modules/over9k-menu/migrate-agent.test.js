import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateAgent } from "./migrate-agent.js";

for (const [source, destination] of [[null, "remote"], ["remote", null], ["remote", "other"]]) {
  test(`native session migration ${source || "local"} to ${destination || "local"}`, async () => {
    const calls = [];
    let exited = false;
    let resumed = false;
    const target = { id: `${destination || "local"}/target`, machine: destination, folder: "/workspace with spaces" };
    const io = {
      sleep: async () => {},
      exec: async (cmd, args, options = {}) => {
        calls.push({ cmd, args, on: options.on || null });
        let stdout = "";
        if (cmd === "hc" && args[0] === "get") stdout = JSON.stringify({ labels: { "revive.session": "session-1", "revive.transcript": "/saved/source.jsonl" } });
        if (cmd === "hc" && args[0] === "machine") stdout = JSON.stringify({ machines: ["remote", "other"].map(name => ({ name, target: name, state: "connected", via: false })) });
        if (cmd === "hc" && args[0] === "keys") exited = true;
        if (cmd === "omp" && args[1] === "lease") stdout = JSON.stringify({ held: ((options.on || null) === source ? !exited : resumed) ? ["session-1"] : [], unknown: [] });
        if (cmd === "omp" && args[1] === "unpack") stdout = "Replaced the local copy of this session.\n/saved/destination.jsonl\nUnpacked session (session-1).\n";
        if (cmd === "herdr-app") { resumed = true; stdout = "{}"; }
        return { code: 0, stdout };
      },
    };
    await migrateAgent(source ? `${source}/t1` : "t1", target, io);
    const pack = calls.findIndex(c => c.cmd === "omp" && c.args[1] === "pack");
    const unpack = calls.findIndex(c => c.cmd === "omp" && c.args[1] === "unpack");
    const moved = calls.findIndex(c => c.cmd === "omp" && c.args[1] === "moved");
    const resume = calls.findIndex(c => c.cmd === "herdr-app");
    assert.ok(pack < unpack && unpack < moved && moved < resume);
    assert.equal(calls[pack].on, source);
    assert.equal(calls[pack].args[2], "/saved/source.jsonl");
    assert.equal(calls[unpack].on, destination);
    assert.equal(calls[moved].on, source);
    assert.deepEqual(JSON.parse(calls[resume].args[2]), { space: target.id, folder: target.folder, argv: ["omp", "--resume", "/saved/destination.jsonl"] });
    assert.equal(calls.filter(c => c.cmd === "scp").length, Number(Boolean(source)) + Number(Boolean(destination)));
  });
}

test("failed archive transfer does not mark or resume either copy", async () => {
  const calls = [];
  const io = { sleep: async () => {}, exec: async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "scp") return { code: 1, stderr: "transfer refused" };
    if (args[0] === "get") return { code: 0, stdout: JSON.stringify({ labels: { "revive.session": "session-1" } }) };
    if (args[0] === "machine") return { code: 0, stdout: JSON.stringify({ machines: [{ name: "remote", target: "remote", state: "connected" }] }) };
    return { code: 0, stdout: args[1] === "lease" ? '{"held":[],"unknown":[]}' : "" };
  } };
  await assert.rejects(migrateAgent("t1", { machine: "remote", folder: "/workspace" }, io), /transfer refused.*remain available/);
  assert.equal(calls.some(c => c[0] === "herdr-app" || c[2] === "moved"), false);
});
