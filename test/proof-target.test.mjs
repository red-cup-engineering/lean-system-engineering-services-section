import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { validateProofTarget, observeProofTarget, judgeProofTarget, snapshotLeanSources } from "../src/check/proof-target.mjs";
import { planLeanCheck } from "../src/check/plan.mjs";

const hash = text => "sha256:" + createHash("sha256").update(text).digest("hex");
const challenge = "theorem witness : True := by trivial\n";
const toolchain = "leanprover/lean4:v4.31.0";
const target = () => ({
  platform:"https://proof.example.invalid/bounty/42", targetId:"challenge-42",
  taskDigest:hash("recorded task"), challenge:{path:"Challenge.lean",digest:hash(challenge)},
  toolchain,manifestDigest:hash("manifest\n"),
  sourceDigest:"sha256:94a40d801eab5a6ee054fabe3e2eeadc5562f18e06bdbb351f82f62b7430cf04",
  permittedAxioms:["Quot.sound"],
});
async function workspace(fn) {
  const root=await mkdtemp(path.join(tmpdir(),"lean-target-"));
  try {
    await writeFile(path.join(root,"Challenge.lean"),challenge);
    await writeFile(path.join(root,"lean-toolchain"),toolchain+"\n");
    await writeFile(path.join(root,"lake-manifest.json"),"manifest\n");
    return await fn(root);
  } finally { await rm(root,{recursive:true,force:true}); }
}
test("reject malformed and forged target claims before execution", () => {
  assert.throws(()=>validateProofTarget({...target(),extra:true}),/not permitted/);
  assert.throws(()=>validateProofTarget({...target(),taskDigest:"wrong"}),/sha256/);
  assert.throws(()=>validateProofTarget({...target(),sourceDigest:"wrong"}),/sha256/);
  assert.throws(()=>validateProofTarget(Object.fromEntries(Object.entries(target()).filter(([key])=>key!=="sourceDigest"))),/sourceDigest/);
  assert.throws(()=>validateProofTarget({...target(),platform:"http://invalid.test"}),/https/);
  assert.throws(()=>validateProofTarget({...target(),challenge:{path:"../escape.lean",digest:hash("x")}}),/challenge.path/);
  assert.throws(()=>validateProofTarget({...target(),challenge:{path:"Escape\\file.lean",digest:hash("x")}}),/challenge.path/);
  assert.throws(()=>validateProofTarget({...target(),permittedAxioms:["Quot.sound","Quot.sound"]}),/repeat/);
  assert.throws(()=>validateProofTarget({...target(),permittedAxioms:["sorryAx"]}),/sorryAx/);
  assert.equal(validateProofTarget(target()).targetId,"challenge-42");
});
test("typed declaration check allows target pin, build and file modes refuse it", () => {
  const input={id:"proof1",project:"/tmp/lean-proofs",mode:"declaration",
    module:"Solution",declaration:"Solution.witness",proofTarget:target()};
  const plan=planLeanCheck(input);
  assert.equal(plan.proofTarget.challenge.path,"Challenge.lean");
  assert.equal(plan.mode,"declaration");
  assert.throws(()=>planLeanCheck({...input,mode:"build"}),/not a build input/);
  assert.throws(()=>planLeanCheck({...input,mode:"file",file:"Solution.lean"}),/not a file input/);
  assert.throws(()=>planLeanCheck({...input,proofTarget:{...target(),taskDigest:"not-a-digest"}}),/sha256/);
});
test("correct on-disk bytes and allowed transitive axioms yield only preflight", async () => workspace(async root => {
  const observed=await observeProofTarget(root,target());
  assert.equal(observed.matched,true);
  const verdict=judgeProofTarget(target(),observed,observed,{axioms:["Quot.sound"]});
  assert.equal(verdict.status,"preflight-passed");
  assert.deepEqual(verdict.findings,[]);
  assert.ok(verdict.unchecked.includes("challenge-solution-comparator"));
  assert.ok(verdict.unchecked.includes("submission-authorization-and-payout"));
}));
test("changed challenge/toolchain/manifest never produce preflight pass", async () => workspace(async root => {
  const initial=await observeProofTarget(root,target());
  await writeFile(path.join(root,"Challenge.lean"),"theorem witness : False := by trivial\n");
  const changed=await observeProofTarget(root,target());
  const judged=judgeProofTarget(target(),initial,changed,{axioms:[]});
  assert.equal(judged.status,"refused");
  assert.ok(judged.findings.some(f=>f.code==="digest-mismatch"));
  await writeFile(path.join(root,"lean-toolchain"),"leanprover/lean4:v4.30.0\n");
  const wrongToolchain=await observeProofTarget(root,target());
  assert.ok(wrongToolchain.findings.some(f=>f.code==="toolchain-mismatch"));
  await writeFile(path.join(root,"lake-manifest.json"),"different\n");
  const wrongManifest=await observeProofTarget(root,target());
  assert.ok(wrongManifest.findings.some(f=>f.path==="lake-manifest.json"&&f.code==="digest-mismatch"));
}));
test("missing and escaping input source refuse", async () => workspace(async root => {
  const external=await mkdtemp(path.join(tmpdir(),"lean-external-"));
  try {
    await rm(path.join(root,"Challenge.lean"));
    await writeFile(path.join(external,"Outside.lean"),challenge);
    await symlink(path.join(external,"Outside.lean"),path.join(root,"Challenge.lean"));
    const escaped=await observeProofTarget(root,target());
    assert.ok(escaped.findings.some(f=>f.code==="source-outside-project"));
    await rm(path.join(root,"lake-manifest.json"));
    const missing=await observeProofTarget(root,target());
    assert.ok(missing.findings.some(f=>f.path==="lake-manifest.json"&&f.code==="source-missing"));
  } finally { await rm(external,{recursive:true,force:true}); }
}));
test("sorry, disallowed axiom and absent kernel inspection always refuse", async () => workspace(async root => {
  const observation=await observeProofTarget(root,target());
  for (const inspection of [undefined,{axioms:["sorryAx"]},{axioms:["Classical.choice"]}]) {
    const result=judgeProofTarget(target(),observation,observation,inspection);
    assert.equal(result.status,"refused");
  }
}));

test("a changed imported Lean dependency invalidates external proof preflight", async () => workspace(async root => {
  await writeFile(path.join(root,"Helper.lean"),"theorem supporting : True := by trivial\n");
  const pinned={...target(),sourceDigest:(await snapshotLeanSources(root)).digest};
  const before=await observeProofTarget(root,pinned);
  assert.equal(before.matched,true);
  await writeFile(path.join(root,"Helper.lean"),"axiom supporting : False\n");
  const after=await observeProofTarget(root,pinned);
  assert.equal(after.matched,false); // The original three pins are unchanged, but source digest is now checked.
  const result=judgeProofTarget(pinned,before,after,{axioms:[]});
  assert.equal(result.status,"refused");
  assert.ok(result.findings.some(f=>f.code==="local-source-tree-changed"));
  assert.notEqual(before.localSources.digest,after.localSources.digest);
}));
test("added Lean modules and comparator configuration cannot escape source snapshot", async () => workspace(async root => {
  const before=await observeProofTarget(root,target());
  await writeFile(path.join(root,"New.lean"),"axiom injection : False\n");
  await writeFile(path.join(root,"comparator.json"),'{"enable_nanoda":false}\n');
  const after=await observeProofTarget(root,target());
  assert.equal(judgeProofTarget(target(),before,after,{axioms:[]}).status,"refused");
  assert.equal(after.localSources.count,before.localSources.count+2);
}));
test("local source scan is location-independent and deterministic", async () => workspace(async root => {
  const snapshot=await snapshotLeanSources(root);
  const snapshotAgain=await snapshotLeanSources(root);
  assert.deepEqual(snapshot,snapshotAgain);
  await writeFile(path.join(root,"Notes.txt"),"not an admitted Lean source\n");
  assert.equal((await snapshotLeanSources(root)).digest,snapshot.digest);
  await writeFile(path.join(root,"Solution.lean"),"theorem witness : True := by trivial\n");
  assert.notEqual((await snapshotLeanSources(root)).digest,snapshot.digest);
}));
test("symlinked local Lean modules make proof source snapshot fail closed", async () => workspace(async root => {
  const external=await mkdtemp(path.join(tmpdir(),"lean-external-"));
  try {
    await writeFile(path.join(external,"Foreign.lean"),"axiom forged : False\n");
    await symlink(path.join(external,"Foreign.lean"),path.join(root,"Alien.lean"));
    const observation=await observeProofTarget(root,target());
    assert.equal(observation.matched,false);
    assert.ok(observation.findings.some(f=>f.code==="local-source-snapshot-unavailable"));
    assert.equal(judgeProofTarget(target(),observation,observation,{axioms:[]}).status,"refused");
  } finally { await rm(external,{recursive:true,force:true}); }
}));

test("a valid task cannot be bound to a different source revision", async () => workspace(async root => {
  const observed=await observeProofTarget(root,{...target(),sourceDigest:hash("different revision")});
  assert.equal(observed.matched,false);
  assert.ok(observed.findings.some(f=>f.code==="local-source-digest-mismatch"));
}));
