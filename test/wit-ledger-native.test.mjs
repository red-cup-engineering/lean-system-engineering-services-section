import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, copyFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { planLeanCheck } from "../src/check/plan.mjs";
import { observeWitLedger, readWitLedgerInspection } from "../src/check/wit-ledger.mjs";

const lake = process.env.LEAN_TEST_LAKE;
const producer = process.env.WIT_LEDGER_SOURCE;

test("original Lean producer: reuse, multiplicity, and unpaid drift", {
    skip: !lake || !producer ? "Set LEAN_TEST_LAKE and WIT_LEDGER_SOURCE to the original pinned providers" : false,
    timeout: 120000,
}, async () => {
    assert.ok(path.isAbsolute(lake));
    assert.ok(path.isAbsolute(producer));
    const root = await mkdtemp(path.join(os.tmpdir(), "wit-native-"));
    const run = args => spawnSync(lake, args, { cwd: root, encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, LEAN_NUM_THREADS: "2" } });
    try {
        await mkdir(path.join(root, "scripts"));
        await copyFile(producer, path.join(root, "scripts/WitLedger.lean"));
        await writeFile(path.join(root, "lean-toolchain"), "leanprover/lean4:v4.31.0\n");
        await writeFile(path.join(root, "lakefile.toml"), 'name = "wit_fixture"\nversion = "0.0.0"\ndefaultTargets = ["Obsmetrologia"]\n\n[[lean_lib]]\nname = "Obsmetrologia"\n\n[[lean_exe]]\nname = "witledger"\nroot = "scripts.WitLedger"\n');
        await writeFile(path.join(root, "Obsmetrologia.lean"), `import Std
namespace Obsmetrologia
theorem identification (r : Nat → Nat → Prop) (a b : Nat) (h : r a b) :
  Quot.mk r a = Quot.mk r b := Quot.sound h
theorem reuse (r : Nat → Nat → Prop) (a b : Nat) (h : r a b) :
  Quot.mk r a = Quot.mk r b := identification r a b h
theorem twoSites (r : Nat → Nat → Prop) (a b c : Nat) (h : r a b) (k : r b c) :
  Quot.mk r a = Quot.mk r c := Eq.trans (Quot.sound h) (Quot.sound k)
end Obsmetrologia
`);
        // Payment is confined to this newly created test fixture. The action
        // under test never receives this option or changes a real project ledger.
        const paid = run(["exe", "witledger", "--pay"]);
        assert.equal(paid.status, 0, paid.stdout + paid.stderr);
        // A Lake executable alias is not the producer's identity. A misbound
        // alias can print arbitrary output while the original source is present.
        const config = await readFile(path.join(root, "lakefile.toml"), "utf8");
        await writeFile(path.join(root, "lakefile.toml"), config.replace('root = "scripts.WitLedger"', 'root = "Counterfeit"'));
        await writeFile(path.join(root, "Counterfeit.lean"), 'def main : IO Unit := IO.println "counterfeit WIT producer"\n');
        const alias = run(["exe", "witledger"]);
        assert.equal(alias.status, 0, alias.stdout + alias.stderr);
        assert.match(alias.stdout, /counterfeit WIT producer/);
        const before = await observeWitLedger(root);
        const plan = planLeanCheck({ id: "native-wits", project: root, mode: "wit-ledger" });
        const runWorker = () => spawnSync(process.execPath, [fileURLToPath(new URL("../src/check/wit-ledger-worker.mjs", import.meta.url)), lake],
            { cwd: root, encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LEAN_NUM_THREADS: "2" } });
        const checked = runWorker();
        assert.equal(checked.status, 0, checked.stdout + checked.stderr);
        assert.equal((await observeWitLedger(root)).localSources.digest, before.localSources.digest);
        const result = readWitLedgerInspection(checked.stdout, before);
        assert.deepEqual(result.entries.map(({ declaration, own, carried }) => [declaration, own, carried]), [
            ["Obsmetrologia.identification", 1, 1], ["Obsmetrologia.reuse", 0, 1], ["Obsmetrologia.twoSites", 2, 2],
        ]);
        const changed = (await readFile(path.join(root, "scripts/wit-ledger.txt"), "utf8")).replace("Obsmetrologia.reuse 0 1", "Obsmetrologia.reuse 0 2");
        await writeFile(path.join(root, "scripts/wit-ledger.txt"), changed);
        const refused = runWorker();
        assert.equal(refused.status, 1, refused.stdout + refused.stderr);
        assert.match(refused.stderr, /unwitting change/);
        assert.throws(() => readWitLedgerInspection(refused.stdout, before));
        assert.equal(await readFile(path.join(root, "scripts/wit-ledger.txt"), "utf8"), changed, "audit must not pay drift");
    } finally { await rm(root, { recursive: true, force: true }); }
});

