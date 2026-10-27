import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { planLeanCheck } from "../src/check/plan.mjs";
import { observeWitLedger, readWitLedgerInspection } from "../src/check/wit-ledger.mjs";

const totals = "# Totals: 3 declaration(s) carry wits; 3 wit(s) paid at 2 site(s) in the library (Quot.sound 3).";
const success = "witledger: OK — 3 declaration(s), 13 constant(s) in their closure, measured in 0.1 s; every wit is witnessed in scripts/wit-ledger.txt.";
const text = totals + "\nObsmetrologia.identification 1 1\nObsmetrologia.reuse 0 1\nObsmetrologia.twoSites 2 2\n";
const observed = { producer: { path: "scripts/WitLedger.lean", digest: "sha256:producer" },
    ledger: { path: "scripts/wit-ledger.txt", digest: "sha256:ledger" }, toolchain: "leanprover/lean4:v4.31.0",
    localSources: { digest: "sha256:local", count: 5 }, ledgerText: text };

test("WIT action admits only the original read-only producer command", () => {
    const input = { id: "wits-1", project: "/tmp/science", mode: "wit-ledger" };
    assert.deepEqual(planLeanCheck(input).args, ["env", "lean", "--run", "scripts/WitLedger.lean"]);
    assert.deepEqual(planLeanCheck(input).buildTargets, ["Obsmetrologia"]);
    for (const extra of [{ args: ["--pay"] }, { targets: ["witledger"] }, { file: "evil.lean" }, { declaration: "X" }])
        assert.throws(() => planLeanCheck({ ...input, ...extra }), /not a wit-ledger input/);
});

test("receive original own/carried counts, preserving reuse and multiplicity", () => {
    const result = readWitLedgerInspection(success + "\n" + totals + "\n", observed);
    assert.deepEqual(result.entries, [
        { declaration: "Obsmetrologia.identification", own: 1, carried: 1 },
        { declaration: "Obsmetrologia.reuse", own: 0, carried: 1 },
        { declaration: "Obsmetrologia.twoSites", own: 2, carried: 2 },
    ]);
    assert.equal(result.paid, 3);
    assert.equal(result.sites, 2);
    assert.equal(result.producer, observed.producer);
});

test("no report from debt, payment, repeated records, or disagreement", () => {
    for (const output of ["", "witledger: paid — wrote 3 line(s)", "witledger: 1 unwitting change(s)",
        `${success}\n${success}\n${totals}`, `${success}\n${totals}\n${totals}`])
        assert.throws(() => readWitLedgerInspection(output, observed));
    assert.throws(() => readWitLedgerInspection(`${success}\n${totals}`, { ...observed, ledgerText: text.replace("paid at 2", "paid at 3") }), /disagree/);
});

test("corrupt ledger cannot acquire a successful measurement", () => {
    for (const ledgerText of [
        text + "Obsmetrologia.reuse 0 1\n",
        text.replace("identification 1 1", "identification 2 1"),
        text.replace("reuse 0 1", "reuse 0 0"),
        text.replace("reuse 0 1", "reuse 0 4"),
        text.replace("twoSites 2 2", "twoSites 9007199254740993 9007199254740993"),
        text.replace("twoSites 2 2", "twoSites 1 2"),
        text.replace("twoSites 2 2", "malformed"),
    ]) assert.throws(() => readWitLedgerInspection(`${success}\n${totals}`, { ...observed, ledgerText }));
});

test("local input observation binds producer, ledger, imports and toolchain", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wit-observe-"));
    try {
        await mkdir(path.join(root, "scripts"));
        await writeFile(path.join(root, "scripts/WitLedger.lean"), "import Obsmetrologia\n");
        await writeFile(path.join(root, "scripts/wit-ledger.txt"), text);
        await writeFile(path.join(root, "lean-toolchain"), "leanprover/lean4:v4.31.0\n");
        await writeFile(path.join(root, "Obsmetrologia.lean"), "namespace Obsmetrologia\nend Obsmetrologia\n");
        const before = await observeWitLedger(root);
        assert.equal(before.localSources.count, 4);
        assert.match(before.producer.digest, /^sha256:[0-9a-f]{64}$/u);
        assert.deepEqual(await observeWitLedger(root), before);
        await writeFile(path.join(root, "Obsmetrologia.lean"), "namespace Obsmetrologia\ntheorem added : True := .intro\nend Obsmetrologia\n");
        assert.notEqual((await observeWitLedger(root)).localSources.digest, before.localSources.digest);
        await symlink("Obsmetrologia.lean", path.join(root, "Alias.lean"));
        await assert.rejects(observeWitLedger(root), /symlink/);
        await rm(path.join(root, "Alias.lean"));
        await rm(path.join(root, "scripts/WitLedger.lean"));
        await assert.rejects(observeWitLedger(root), /requires scripts\/WitLedger/);
    } finally { await rm(root, { recursive: true, force: true }); }
});
