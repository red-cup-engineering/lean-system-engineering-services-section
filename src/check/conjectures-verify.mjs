/**
 * Run the PUBLISHER'S own local Conjectures verification pipeline.
 *
 * This is NOT a second verifier. It invokes the installed official
 * python3 -m verifier verify, binding its exact task commitment, environment
 * and build provenance. There is no wallet, credit use, remote submission,
 * reward decision or sandbox downgrade.
 */
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath, readFile } from "node:fs/promises";

const sha = bytes => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const maxOutputBytes = 4 * 1024 * 1024;

function appendBounded(chunks, chunk, count) {
  const allowed = Math.max(0, maxOutputBytes - count);
  if (allowed) chunks.push(Buffer.from(chunk).subarray(0,allowed));
  return count + chunk.length;
}

export async function verifyConjecturesCandidate({
  task, submissionPath, validatorRoot, timeoutMs = 1_800_000,
}) {
  if (!validatorRoot)
    throw new TypeError("Conjectures official validator is not installed on this worker");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1_800_000)
    throw new TypeError("Conjectures local verification requires a bounded worker budget");
  const root = await realpath(validatorRoot);
  const mainFile = await realpath(submissionPath);
  for (const [file,expectedSize] of [
    [path.join(root,"verifier","__main__.py"), 131072],
    [path.join(root,"pins.lock.json"), 524288],
    [mainFile, 31457280],
  ]) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > expectedSize)
      throw new TypeError("Conjectures trusted verifier/input file is missing or unsafe");
  }
  const proofDigest = sha(await readFile(mainFile));
  if (!/^sha256:[a-f0-9]{64}$/u.test(task.taskBundleDigest) ||
      !/^sha256:[a-f0-9]{64}$/u.test(task.buildProvenanceDigest))
    throw new TypeError("Conjectures publisher task/build commitment is missing");
  const args = [
    "-m","verifier","verify",
    "--task",path.dirname(task.challengePath),
    "--submission",mainFile,
    "--expected-task-sha256",task.taskBundleDigest,
    "--expected-build-provenance",task.buildProvenanceDigest,
  ];
  const started = new Date().toISOString();
  const child = spawn("python3",args,{
    cwd:root,env:{...process.env},detached:true,
    stdio:["ignore","pipe","pipe"],
  });
  const stdout=[],stderr=[];
  let outBytes=0,errBytes=0,timeout=false;
  child.stdout.on("data",chunk => {outBytes=appendBounded(stdout,chunk,outBytes)});
  child.stderr.on("data",chunk => {errBytes=appendBounded(stderr,chunk,errBytes)});
  const result = await new Promise(resolve => {
    let settled=false;
    const finish=(code,signal,error)=>{
      if (settled) return;
      settled=true;
      clearTimeout(deadline);
      resolve({code,signal,error});
    };
    const deadline=setTimeout(() => {
      timeout=true;
      // Detached process group includes children spawned by the official
      // verifier. Do not leave a timed-out compiler after advancing Work.
      try { if(child.pid)process.kill(-child.pid,"SIGKILL"); }
      catch(error){if(error?.code!=="ESRCH")timeout=true}
    },timeoutMs);
    child.once("close",(code,signal)=>finish(code,signal,null));
    child.once("error",error=>finish(null,null,error));
  });
  const output=Buffer.concat(stdout).toString("utf8");
  const diagnostic=Buffer.concat(stderr).toString("utf8");
  let report=null;
  try { report=JSON.parse(output) } catch { /* no claim from partial output */ }
  const checks=report?.checks ?? {};
  // The verifier must have read the SAME candidate we will later retain.
  // A compiler report from a different file or a mid-run file mutation is
  // not economic proof evidence.
  let sourceChanged=true;
  try { sourceChanged=sha(await readFile(mainFile))!==proofDigest; }
  catch { sourceChanged=true }
  const complete=report?.accepted===true && result.code===0 &&
    report.reason_code==="VERIFIED" &&
    report.task_id===task.taskId &&
    report.task_mode===task.taskMode &&
    report.source_theorem===task.sourceTheorem &&
    report.repository_commit===task.publisherSourceRevision &&
    report.task_bundle_sha256===task.taskBundleDigest &&
    report.submission_sha256===proofDigest &&
    checks.task_commitment_valid===true &&
    checks.same_statement===true &&
    checks.axioms_permitted===true &&
    checks.lean_kernel_passed===true &&
    checks.production_sandbox===true &&
    report.sandbox_mode==="landrun+seccomp" &&
    !sourceChanged && !timeout &&
    outBytes<=maxOutputBytes && errBytes<=maxOutputBytes;
  const identityMismatch=report?.accepted===true && !complete;
  const reason=identityMismatch ? "VERIFIER_REPORT_IDENTITY_MISMATCH" :
    report?.reason_code ?? (timeout?"TIMEOUT":
    result.error ? "VERIFIER_EXECUTION_UNAVAILABLE" :
      outBytes>maxOutputBytes ? "VERIFIER_OUTPUT_EXCEEDED" : "VERIFIER_REPORT_UNAVAILABLE");
  // CLI exit 2 is a configuration/host/pin failure, NOT a mathematical
  // rejection. Exit 1 represents an unsuccessful verification attempt.
  const status=complete ? "verified-locally" :
    identityMismatch || sourceChanged || report===null ||
    outBytes>maxOutputBytes || errBytes>maxOutputBytes ||
    timeout || result.code===2 || result.error ?
      "blocked" : "rejected";
  const reportText=report===null ? null : JSON.stringify(report);
  return Object.freeze({
    kind:"metroplat.lean.conjectures-local-verification",
    status,reasonCode:reason,started,ended:new Date().toISOString(),
    taskId:task.taskId,taskBundleDigest:task.taskBundleDigest,
    proofDigest,
    reportDigest:reportText===null ? null : sha(Buffer.from(reportText,"utf8")),
    // Only the authorized caller sees the report; the shared Work journal
    // will receive the digest and status, never the complete solution.
    report, diagnostic:diagnostic.slice(-5000),
    verifiedBy:"conjectures-official-local-verifier",
    independentExternalAcceptance:false,
  });
}
