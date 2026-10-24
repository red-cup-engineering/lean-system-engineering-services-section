import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { validateProofTarget, observeProofTarget, judgeProofTarget } from "../src/check/proof-target.mjs";
import { planLeanCheck } from "../src/check/plan.mjs";

const hash = text => "sha256:" + createHash("sha256").update(text).digest("hex");
const challenge = "theorem witness : True := by trivial\n";
const toolchain = "leanprover/lean4:v4.31.0";
const target = () => ({
  platform:"https://proof.example.invalid/bounty/42", targetId:"challenge-42",
  taskDigest:hash("recorded task"), challenge:{path:"Challenge.lean",digest:hash(challenge)},
  toolchain,manifestDigest:hash("manifest\n"),permittedAxioms:["Quot.sound"],
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
