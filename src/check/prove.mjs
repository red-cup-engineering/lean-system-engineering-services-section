/**
 * Construct Lean proof candidates from an unchanged source theorem.
 * Source-owned Blueprint uses arcs supply lemma names; Lean/Lake actually
 * checks each generated candidate using the existing bounded runner.
 *
 * This produces proof text or the first unsolved goals, never a fake verdict.
 */
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, realpath, lstat, unlink, writeFile, rmdir } from "node:fs/promises";
import { planLeanCheck } from "./plan.mjs";
import { runLeanCheck } from "./run.mjs";
import { validateProofTarget, observeProofTarget, judgeProofTarget } from "./proof-target.mjs";
import { readLeanWorkspaceCore } from "../workspace/service.mjs";
import { readConjecturesTask, renderConjecturesCandidate } from "./conjectures-task.mjs";

const qualified = /^[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*$/u;
const hole = /:=\s*by\s+sorry\b/gu;
const hash = x => "sha256:" + createHash("sha256").update(x).digest("hex");
function bounded(value, field, lower, upper) {
  if (!Number.isSafeInteger(value) || value < lower || value > upper)
    throw new TypeError("lean-prove: invalid " + field);
  return value;
}
/**
 * The mathematical office can author arbitrary complex tactics as source
 * files under proofs/. This is NOT public untrusted task input: the files
 * must be materialized by the same authorized maker as the Lean workspace.
 * Published Conjectures task data never supplies these tactic sources.
 */
function candidatePaths(paths) {
  if (!Array.isArray(paths) || paths.length > 16 ||
      paths.some(p => typeof p !== "string" || !p.startsWith("proofs/") ||
        !(p.endsWith(".tactic") || p.endsWith(".leanproof")) ||
        p.includes("\\") || path.isAbsolute(p) ||
        p.split("/").some(part => !part || part === "." || part === "..")))
    throw new TypeError("lean-prove: proposalFiles must be at most 16 authored proofs/*.tactic paths");
  return Object.freeze([...new Set(paths)]);
}
async function readProofProposals(root, paths) {
  return Promise.all(paths.map(async proposalPath => {
    const filename = path.join(root, proposalPath);
    const info = await lstat(filename);
    const real = await realpath(filename);
    const delta = path.relative(root, real);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 131072 ||
        delta === ".." || delta.startsWith(".." + path.sep) ||
        path.isAbsolute(delta))
      throw new TypeError("lean-prove: non-admitted proposal source " + proposalPath);
    const bytes = await readFile(real);
    const proof = bytes.toString("utf8").replace(/^by\s*\r?\n/u,"").trim();
    if (!proof || proof.includes("\0"))
      throw new TypeError("lean-prove: empty or invalid mathematical proposal " + proposalPath);
    return Object.freeze({path:proposalPath,digest:hash(bytes),program:proof});
  }));
}

function qualifiedHints(hints) {
  if (!Array.isArray(hints) || hints.length > 32 ||
      hints.some(n => typeof n !== "string" || !qualified.test(n)))
    throw new TypeError("lean-prove: hints must be at most 32 qualified Lean names");
  return [...new Set(hints)];
}
export function planLeanProof(input) {
  const file = input?.file;
  const taskDirectory = input?.taskDirectory;
  const isTask = taskDirectory !== undefined;
  if (typeof input?.project !== "string" || !input.project.trim())
    throw new TypeError("lean-prove: a pinned Lean project is required");
  if (isTask) {
    if (typeof taskDirectory !== "string" || !taskDirectory ||
        taskDirectory.startsWith("/") || path.isAbsolute(taskDirectory) ||
        taskDirectory.includes("\\") ||
        taskDirectory.split("/").some(part => !part || part === "." || part === "..") ||
        file !== undefined || input.declaration !== undefined ||
        input.blueprintLabel !== undefined || input.proofTarget !== undefined)
      throw new TypeError("lean-prove: choose either an original theorem or a Conjectures task bundle");
  } else if (typeof input?.declaration !== "string" || !qualified.test(input.declaration) ||
      typeof file !== "string" || !file.endsWith(".lean") || path.isAbsolute(file) ||
      file.startsWith("-") || file.includes("\\") ||
      file.split("/").some(p => !p || p === "." || p === ".."))
    throw new TypeError("lean-prove: existing in-project theorem source and declaration required");
  const id = input.id ?? randomUUID();
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,60}$/u.test(id))
    throw new TypeError("lean-prove: invalid work id");
  if (input.blueprintLabel !== undefined &&
      (typeof input.blueprintLabel !== "string" ||
       !/^[a-z]+:[a-z0-9-]+$/u.test(input.blueprintLabel)))
    throw new TypeError("lean-prove: blueprintLabel must be an exact source claim label");
  for (const key of Object.keys(input))
    if (!["project", "file", "taskDirectory", "id", "resumeFrom", "declaration", "maxAttempts", "timeoutMs", "totalTimeoutMs", "blueprintLabel", "hints", "proposalFiles", "proofTarget"].includes(key))
      throw new TypeError("lean-prove: unexpected field " + key);
  if (input.resumeFrom !== undefined &&
      (typeof input.resumeFrom !== "string" ||
       !/^[A-Za-z0-9][A-Za-z0-9-]{0,60}$/u.test(input.resumeFrom)))
    throw new TypeError("lean-prove: resumeFrom must be a previous proof run ID");
  return Object.freeze({
    kind: "metroplat.lean.proof-search-plan", id, project: path.resolve(input.project),
    ...(input.resumeFrom === undefined ? {} : {resumeFrom:input.resumeFrom}),
    ...(isTask ? { taskDirectory, declaration:"Bounty.target" } :
      { file, declaration:input.declaration }),
    maxAttempts: bounded(input.maxAttempts ?? 16, "maxAttempts", 1, 64),
    // Preserve the original single-check bound while making total search
    // compute explicit. A hard theorem can consume a longer single attempt
    // without allowing an unbounded sequence of 30-minute retries.
    timeoutMs: bounded(input.timeoutMs ?? 60_000, "timeoutMs", 1000, 1_800_000),
    totalTimeoutMs: bounded(input.totalTimeoutMs ?? 300_000, "totalTimeoutMs", 1000, 1_800_000),
    hints: Object.freeze(qualifiedHints(input.hints ?? [])),
    proposalFiles: candidatePaths(input.proposalFiles ?? []),
    ...(input.blueprintLabel === undefined ? {} : {blueprintLabel:input.blueprintLabel}),
    ...(input.proofTarget === undefined ? {} : {proofTarget:validateProofTarget(input.proofTarget)}),
  });
}

/**
 * Use the actual Blueprint uses edges to retrieve the predecessor claim's
 * Lean declarations; filter against the same project's declaration catalog.
 * Never interpret the mathematical prose as a proof or a tactic.
 */
export function proofHintsFromBlueprint(workspace, label, targetDeclaration) {
  const graph = workspace?.texWorkspaceRead?.blueprintClaimGraph;
  const node = graph?.nodes?.find(n => n.id === label);
  if (!node) throw new Error("lean-prove: missing original Blueprint claim " + label);
  if (targetDeclaration !== undefined && !node.leanDeclarations.includes(targetDeclaration))
    throw new Error("lean-prove: target declaration is not the Blueprint claim " + label);
  const known = new Set(workspace.declarationCatalog.entries.map(e => e.name));
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const self = new Set(node.leanDeclarations);
  return Object.freeze([...new Set(graph.edges.filter(e => e.from === label)
    .flatMap(e => byId.get(e.to)?.leanDeclarations ?? [])
    .filter(n => known.has(n) && qualified.test(n) && !self.has(n)))].sort());
}

/** Tactics and lemma applications. These are real proof attempts, not model scores. */
export function proofPrograms(hints = []) {
  const names = qualifiedHints(hints);
  const fromBlueprint = [];
  for (const name of names) {
    fromBlueprint.push("exact " + name, "simpa using " + name,
      "apply " + name + " <;> assumption",
      "apply " + name + " <;> simp");
  }
  if (names.length)
    fromBlueprint.push("simp [" + names.join(", ") + "]",
      "simp_all [" + names.join(", ") + "]");
  const generic = [
    "rfl", "assumption", "trivial", "simp_all", "simp",
    "decide", "exact?", "omega", "aesop",
    "constructor <;> assumption", "constructor <;> simp",
    "intro h\nexact h", "simp_all\nall_goals omega",
    "simp\nall_goals aesop",
  ];
  // Ask Lean's OWN tactic backtracking to select a proof in one bounded
  // compiler invocation. A failed branch rolls back its goal state. This
  // amortizes Lake/toolchain startup across many alternative derivations.
  // Subsequent candidate scripts remain available for finer goal diagnosis.
  const solve = candidates => "solve\n" +
    candidates.map(tactic => "| " + tactic.split("\n").join("\n  ")).join("\n");
  const programs = [];
  if (fromBlueprint.length) programs.push(solve([...fromBlueprint, ...generic]));
  programs.push(solve(generic));
  programs.push(...fromBlueprint, ...generic);
  return Object.freeze([...new Set(programs)]);
}

/** Change ONLY the proof body; reject ambiguous holes rather than changing a statement. */
export function replaceProofHole(source, program) {
  if (typeof source !== "string" || Buffer.byteLength(source) > 131072)
    throw new TypeError("lean-prove: source exceeds 128KiB");
  const matches = [...source.matchAll(hole)];
  if (matches.length !== 1)
    throw new TypeError("lean-prove: exactly one by-sorry proof hole required");
  if (typeof program !== "string" || !program.trim()) throw new TypeError("lean-prove: empty program");
  return source.slice(0, matches[0].index) + ":= by\n  " +
    program.split("\n").join("\n  ") +
    source.slice(matches[0].index + matches[0][0].length);
}
/**
 * Only the Lean compiler may supply the next goals. A diagnostic is never
 * interpreted as a theorem result. This compact read retains actual contexts.
 */
export function remainingLeanGoals(message) {
  const text = String(message ?? "");
  const pos = text.lastIndexOf("unsolved goals");
  if (pos < 0) return Object.freeze([]);
  const tail = text.slice(pos + "unsolved goals".length, pos + 9000);
  return Object.freeze(tail.split(/(?=\n(?:case\s+\S+|⊢))/u)
    .map(s => s.trim()).filter(s => s.includes("⊢")).slice(0, 16));
}
/**
 * Read the compiler's own #print axioms output for precisely one target.
 * Unknown output syntax is not a no-axioms receipt.
 */
export function readPrintedAxioms(output, declaration) {
  const rows = String(output ?? "").split(/\r?\n/u)
    .filter(line => line.includes(declaration) &&
      (line.includes("depends on axioms:") ||
       line.includes("does not depend on any axioms")));
  if (rows.length !== 1) return null;
  if (rows[0].includes("does not depend on any axioms")) return Object.freeze([]);
  const match = /depends on axioms:\s*\[([^\]]*)\]/u.exec(rows[0]);
  if (match === null) return null;
  const names = match[1].split(",").map(x => x.trim()).filter(Boolean);
  if (names.some(x => !qualified.test(x))) return null;
  return Object.freeze([...new Set(names)].sort());
}

/**
 * A successful search tactic may tell us a smaller exact proof term. Only a
 * second REAL Lean elaboration may promote that suggestion to returned source.
 */
export function suggestedExactProof(readout) {
  const lines = String(readout ?? "").split(/\r?\n/u);
  const candidates = lines.flatMap(line => {
    const hit = /Try this:\s*((?:exact|simpa using|simp only)\s+[^\r\n]+)/u.exec(line);
    return hit === null ? [] : [hit[1].trim()];
  });
  return candidates.at(-1) ?? null;
}

function diagnostic(result) {
  const texts = [...(result?.errors ?? []), ...(result?.compilerErrors ?? [])]
    .map(x => typeof x === "string" ? x : x.message ?? JSON.stringify(x)).filter(Boolean);
  return (texts.length ? texts.join("\n") : String(result?.stderr ?? result?.stdout ?? "")).slice(-2500);
}

/**
 * Retain actual compiler feedback and source-derived proof attempts in the
 * authorized project, not the shared Work journal. Future proof researchers
 * can continue from exact failed goals instead of repeating the same blind
 * tactic search. The report is private and references the source revision.
 */
async function retainProofAttempt(root, result) {
  const folder = path.join(root, ".lake", "proof-runs");
  await mkdir(folder, {recursive:true});
  const relative = ".lake/proof-runs/" + result.id + ".json";
  await writeFile(path.join(root,relative),
    JSON.stringify({kind:"metroplat.lean.private-proof-attempt",
      id:result.id,sourceDigest:result.sourceDigest,
      candidateDigest:result.candidateDigest ?? null,
      task:result.task ?? null,originalAxioms:result.originalAxioms ?? null,
      blockerCode:result.blockerCode ?? null,
      baselineDiagnostic:result.baselineDiagnostic ?? null,
      started:result.started,ended:result.ended,
      hints:result.hints ?? [],attempts:result.attempts,
      resumedFrom:result.resumedFrom ?? null,
      frontier:result.frontier ?? [],
      candidatePath:result.candidatePath ?? null},null,2)+"\n",
    {flag:"wx",mode:0o600});
  return Object.freeze({...result,receiptPath:relative});
}

/**
 * Reuse a source-pinned private compiler history, never a user supplied
 * success claim. Failed proof programs are expensive work: when the original
 * theorem and Conjectures task are unchanged, do not blindly recompile them.
 */
async function readPreviousProofAttempt(root, runId, sourceDigest, task) {
  if (runId === undefined) return null;
  const visited = new Set();
  const attempted = new Set();
  let current = runId;
  let initialFrontier = [];
  // Follow a bounded private Work lineage: a third shift must remember what
  // the FIRST shift tried, not merely its immediately preceding predecessor.
  for (let depth = 0; current !== null; depth++) {
    if (depth >= 32 || visited.has(current) ||
        typeof current !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9-]{0,60}$/u.test(current))
      throw new TypeError("lean-prove: invalid or cyclic private proof Work history");
    visited.add(current);
    const filename = path.join(root, ".lake", "proof-runs", current + ".json");
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024)
      throw new TypeError("lean-prove: saved compiler history must be a bounded regular file");
    let prior;
    try { prior = JSON.parse(await readFile(filename, "utf8")); }
    catch { throw new TypeError("lean-prove: unreadable prior compiler history"); }
    if (prior.kind !== "metroplat.lean.private-proof-attempt" ||
        prior.id !== current || prior.sourceDigest !== sourceDigest ||
        !Array.isArray(prior.attempts) ||
        prior.attempts.some(a => typeof a.program !== "string" ||
           typeof a.state !== "string" || a.program.length > 131072) ||
        (task === undefined ? prior.task !== null :
          prior.task?.taskId !== task.taskId ||
          prior.task?.challengeDigest !== task.challengeDigest ||
          prior.task?.manifestDigest !== task.manifestDigest ||
          prior.task?.taskBundleDigest !== task.taskBundleDigest))
      throw new TypeError("lean-prove: prior proof Work belongs to a different theorem/task");
    if (depth === 0) initialFrontier = Array.isArray(prior.frontier) ? prior.frontier : [];
    for (const attempt of prior.attempts)
      if (attempt.state !== "candidate-compiled") attempted.add(attempt.program);
    current = prior.resumedFrom ?? null;
  }
  return Object.freeze({
    id:runId, priorRuns:visited.size,
    attempted:Object.freeze([...attempted]), frontier:Object.freeze(initialFrontier),
  });
}

function taskIdentity(task) {
  return Object.freeze({
    taskId:task.taskId, taskMode:task.taskMode, sourceTheorem:task.sourceTheorem,
    challengeDigest:task.challengeDigest, manifestDigest:task.manifestDigest,
    taskBundleDigest:task.taskBundleDigest,
    rewardTargetId:task.rewardTargetId,
    publisherIndexState:task.publisherIndexState,
    publisherSourceRevision:task.publisherSourceRevision,
    environmentIdentity:task.environmentIdentity,
    dependencyIdentity:task.dependencyIdentity,
  });
}

/**
 * Search, without modifying the original. Each alternative invokes the actual
 * existing lean-check/Lake executor, which enforces one concurrent node scope,
 * memory and time limits. The worker is never simulated by this service.
 */
export async function runLeanProofSearch(plan, {check = runLeanCheck, workspaceRead = readLeanWorkspaceCore, taskRoot} = {}) {
  const root = await realpath(plan.project);
  const task = plan.taskDirectory === undefined ? undefined :
    await readConjecturesTask(root, plan.taskDirectory, {taskRoot});
  const sourcePath = task === undefined ?
    await realpath(path.join(root, plan.file)) : task.challengePath;
  // A normal theorem belongs to the selected Lean project. A Conjectures
  // Challenge belongs instead to the independently mounted immutable task
  // checkout: readConjecturesTask has already bounded it to taskRoot.
  if (task === undefined) {
    const rel = path.relative(root, sourcePath);
    if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel))
      throw new TypeError("lean-prove: theorem source escapes project");
  }
  const originalBytes = await readFile(sourcePath);
  if (originalBytes.length > 131072) throw new TypeError("lean-prove: source too large");
  const original = task === undefined ? originalBytes.toString("utf8") : task.main;
  if ([...original.matchAll(hole)].length !== 1)
    throw new TypeError("lean-prove: exact target lacks unique proof hole");
  // Reuse the exact challenge/task pins already shared by the original
  // compiler-check API. Proof construction and qualification are one workflow.
  const targetBefore = plan.proofTarget === undefined ? undefined :
    await observeProofTarget(root, plan.proofTarget);
  if (targetBefore !== undefined && !targetBefore.matched)
    throw new Error("lean-prove: external proof target source commitments do not match this workspace: " +
      targetBefore.findings.map(x => x.code).join(", "));
  const fromBlueprint = plan.blueprintLabel === undefined ? [] :
    proofHintsFromBlueprint(workspaceRead(root), plan.blueprintLabel, plan.declaration);
  const hints = [...new Set([...fromBlueprint, ...plan.hints])].slice(0, 32);
  if (task !== undefined && hints.some(name => task.forbiddenDependencies.includes(name)))
    throw new TypeError("lean-prove: source theorem or forbidden task dependency is a proof hint");
  // Base strategies are read from the actual library hints. When a tactic
  // exposes genuine unsolved goals, synthesize its *continuation* next.
  const proposals = await readProofProposals(root, plan.proposalFiles ?? []);
  const byProgram = new Map();
  for (const proposal of proposals) {
    const lineage = byProgram.get(proposal.program) ?? [];
    lineage.push(Object.freeze({path:proposal.path,digest:proposal.digest}));
    byProgram.set(proposal.program, Object.freeze(lineage));
  }
  // Real source-authored mathematical strategies are tried FIRST. Generic
  // tactics follow only when the Research/Faber proposals have not proved it.
  const previous = await readPreviousProofAttempt(root, plan.resumeFrom,
    hash(originalBytes), task);
  const rejected = new Set(previous?.attempted ?? []);
  // New/edited proof proposals are prioritized, but exact failed proof
  // programs from the same source revision are not needlessly repeated.
  const programs = [...new Set([...proposals.map(p => p.program), ...proofPrograms(hints)])]
    .filter(program => !rejected.has(program));
  const queued = new Set([...programs,...rejected]);
  const folder = path.join(root, ".lake", "proof-search");
  const file = "ProofSearch_" + plan.id.replaceAll("-", "_") + ".lean";
  const scratch = path.join(folder, file);
  const scratchRelative = ".lake/proof-search/" + file;
  await mkdir(folder, { recursive: true });
  const attempts = [], started = new Date().toISOString();
  const searchStart = Date.now();
  try {
    // First ask Lean about the ORIGINAL theorem, not a plausible-looking
    // replacement. This establishes that the named declaration actually
    // depends on the exact admitted hole being discharged. Without this,
    // changing some unrelated by-sorry could be misreported as a proof of the
    // caller's (already-proved) declaration.
    const originalCompilerSource = task === undefined ? original : task.originalChallenge;
    await writeFile(scratch,
      originalCompilerSource + "\n#print axioms " + plan.declaration + "\n",
      {mode:0o600});
    const baseline = await check(planLeanCheck({
      id:("proof-" + plan.id + "-original").slice(0,80),
      project:root,mode:"file",file:scratchRelative,
      timeoutMs:Math.min(plan.timeoutMs,
        Math.max(1000,plan.totalTimeoutMs - (Date.now() - searchStart))),
    }));
    const baselineReadout = String(baseline?.stdout ?? "") + "\n" +
      String(baseline?.stderr ?? "");
    const originalAxioms = baseline?.state === "succeeded" ?
      readPrintedAxioms(baselineReadout,plan.declaration) : null;
    if (originalAxioms === null || !originalAxioms.includes("sorryAx")) {
      const blockerCode = baseline?.state !== "succeeded" ?
        "original-theorem-not-compiled" : "target-not-backed-by-admitted-hole";
      return retainProofAttempt(root,Object.freeze({
        kind:"metroplat.lean.proof-search-result",id:plan.id,state:"blocked",
        project:root,
        file:task === undefined ? plan.file : plan.taskDirectory + "/Main.lean",
        declaration:plan.declaration,
        ...(task === undefined ? {} : {task:taskIdentity(task)}),
        sourceDigest:hash(originalBytes),attempts:Object.freeze([]),
        hints:Object.freeze(hints),
        blockerCode,baselineDiagnostic:baseline?.state === "succeeded" ?
          "The target does not depend on the admitted proof hole" : diagnostic(baseline),
        started,ended:new Date().toISOString(),venueAccepted:false,
      }));
    }
    for (let index = 0; index < programs.length && index < plan.maxAttempts; index += 1) {
      const remainingMs = plan.totalTimeoutMs - (Date.now() - searchStart);
      if (remainingMs < 1000) break;
      if (hash(await readFile(sourcePath)) !== hash(originalBytes))
        throw new Error("lean-prove: source changed during search");
      const program = programs[index];
      const candidate = replaceProofHole(original, program);
      const output = task === undefined ? undefined : renderConjecturesCandidate(task, candidate);
      // Compile the original theorem declaration. For a Conjectures task,
      // only the trusted header/footer enter the scratch workspace; Main.lean
      // is the generated declaration body, without any user imports.
      const compiling = output === undefined ? candidate : output.compilerSource;
      await writeFile(scratch, compiling + "\n#print axioms " + plan.declaration + "\n", {mode:0o600});
      const planCheck = planLeanCheck({
        id: ("proof-" + plan.id + "-" + index).slice(0, 80),
        project: root, mode: "file", file: scratchRelative,
        timeoutMs: Math.min(plan.timeoutMs, remainingMs),
      });
      const result = await check(planCheck);
      const compilerSucceeded = result?.state === "succeeded";
      const readout = String(result?.stdout ?? "") + "\n" + String(result?.stderr ?? "");
      const axioms = compilerSucceeded ? readPrintedAxioms(readout, plan.declaration) : null;
      const targetAfter = compilerSucceeded && targetBefore !== undefined ?
        await observeProofTarget(root, plan.proofTarget) : undefined;
      const targetVerdict = targetAfter === undefined ? undefined :
        judgeProofTarget(plan.proofTarget, targetBefore, targetAfter,
          axioms === null ? undefined : {axioms});
      const compiled = compilerSucceeded && axioms !== null &&
        !axioms.includes("sorryAx") &&
        (task === undefined || axioms.every(name => task.allowedAxioms.includes(name))) &&
        (targetVerdict === undefined || targetVerdict.status === "preflight-passed");
      const message = compiled ? "" : (axioms === null && compilerSucceeded
        ? "Lean's target axiom readout was missing or unrecognized"
        : targetVerdict?.status === "refused"
        ? targetVerdict.findings.map(x => x.code).join(", ") : diagnostic(result));
      const goals = remainingLeanGoals(message);
      attempts.push(Object.freeze({
        index, program, state: compiled ? "candidate-compiled" : result?.state ?? "failed",
        ...(byProgram.has(program) ? {sourceProposals:byProgram.get(program)} : {}),
        ...(axioms === null ? {} : {axioms}),
        ...(targetVerdict === undefined ? {} : {proofTargetStatus:targetVerdict.status}),
        ...(compiled ? {} : {diagnostic:message,openGoals:goals}),
      }));
      // Actual compiler goal states, not source-text guesses, warrant
      // compositional follow-ups; a failed tactic without goals does not.
      if (!compiled && goals.length && programs.length < 160) {
        const additions = ["assumption", "simp", "omega", "aesop"]
          .map(tactic => program + "\nall_goals " + tactic)
          .filter(p => !queued.has(p));
        additions.forEach(p => queued.add(p));
        programs.splice(index + 1, 0, ...additions);
      }
      if (compiled) {
        let selectedProgram = program;
        let selectedSource = candidate;
        let selectedAxioms = axioms;
        let selectedReadout = readout;
        let selectedTargetVerdict = targetVerdict;
        const suggestion = suggestedExactProof(readout);
        // Canonicalize a search tactic (exact?) into the concrete proof that
        // Lean actually suggested. Never trust an info message without replay.
        if (suggestion && suggestion !== program && attempts.length < plan.maxAttempts &&
            plan.totalTimeoutMs - (Date.now() - searchStart) >= 1000) {
          const simplified = replaceProofHole(original, suggestion);
          const rendered = task === undefined ? simplified :
            renderConjecturesCandidate(task, simplified).compilerSource;
          await writeFile(scratch, rendered + "\n#print axioms " + plan.declaration + "\n",
            {mode:0o600});
          const replayPlan = planLeanCheck({
            id:("proof-" + plan.id + "-refine-" + index).slice(0,80),
            project:root,mode:"file",file:scratchRelative,
            timeoutMs:Math.min(plan.timeoutMs,
              plan.totalTimeoutMs - (Date.now() - searchStart)),
          });
          const replay = await check(replayPlan);
          const replayOutput = String(replay?.stdout ?? "") + "\n" + String(replay?.stderr ?? "");
          const replayAxioms = replay?.state === "succeeded" ?
            readPrintedAxioms(replayOutput, plan.declaration) : null;
          const replayAfter = replay?.state === "succeeded" && targetBefore !== undefined ?
            await observeProofTarget(root, plan.proofTarget) : undefined;
          const replayTargetVerdict = replayAfter === undefined ? undefined :
            judgeProofTarget(plan.proofTarget, targetBefore, replayAfter,
              replayAxioms === null ? undefined : {axioms:replayAxioms});
          const simplerValid = replay?.state === "succeeded" && replayAxioms !== null &&
            !replayAxioms.includes("sorryAx") &&
            (task === undefined || replayAxioms.every(a => task.allowedAxioms.includes(a))) &&
            (replayTargetVerdict === undefined || replayTargetVerdict.status === "preflight-passed");
          attempts.push(Object.freeze({
            index:attempts.length,program:suggestion,
            state:simplerValid ? "candidate-compiled" : (replay?.state ?? "failed"),
            ...(replayAxioms === null ? {} : {axioms:replayAxioms}),
            ...(simplerValid ? {} : {diagnostic:"Lean rejected the suggested fixed proof"}),
          }));
          if (simplerValid) {
            selectedProgram = suggestion;
            selectedSource = simplified;
            selectedAxioms = replayAxioms;
            selectedReadout = replayOutput;
            selectedTargetVerdict = replayTargetVerdict ?? targetVerdict;
          }
        }
        if (hash(await readFile(sourcePath)) !== hash(originalBytes))
          throw new Error("lean-prove: original theorem changed during proof construction");
        // Every source-authored proof consumed must remain byte-identical.
        for (const proposal of proposals) {
          if (hash(await readFile(path.join(root,proposal.path))) !== proposal.digest)
            throw new Error("lean-prove: mathematical proposal changed during proof construction");
        }
        if (task !== undefined) {
          const currentTask = await readConjecturesTask(root, plan.taskDirectory, {taskRoot});
          if (currentTask.manifestDigest !== task.manifestDigest ||
              currentTask.challengeDigest !== task.challengeDigest)
            throw new Error("lean-prove: original Conjectures task changed during proof construction");
        }
        // Preserve a successful candidate as a private, content-addressed
        // project artifact. Never write it into a public/source-control path.
        // Conjectures retains precisely the Main.lean declaration bytes;
        // ordinary mathematics retains its complete proved module.
        const candidateDigest = hash(selectedSource);
        const privateFolder = path.join(root, ".lake", "proof-candidates");
        await mkdir(privateFolder, {recursive:true});
        const candidateRelative = ".lake/proof-candidates/" +
          candidateDigest.slice("sha256:".length) +
          (task === undefined ? ".lean" : ".Main.lean");
        const privateFile = path.join(root, candidateRelative);
        try {
          await writeFile(privateFile, selectedSource, {flag:"wx",mode:0o600});
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
          const existing = await lstat(privateFile);
          if (!existing.isFile() || existing.isSymbolicLink() ||
              hash(await readFile(privateFile)) !== candidateDigest)
            throw new TypeError("lean-prove: content-addressed artifact path is not the proved file");
        }
        return retainProofAttempt(root, Object.freeze({
          kind: "metroplat.lean.proof-search-result", id:plan.id,
          state:"candidate-compiled", project:root,
          candidatePath:candidateRelative,
          file:task === undefined ? plan.file : plan.taskDirectory + "/Main.lean",
          declaration:plan.declaration, axioms:selectedAxioms,
          originalAxioms,
          axiomReadout:selectedReadout.slice(-2500),
          ...(task === undefined ? {} : {task:taskIdentity(task),mainLean:selectedSource}),
          ...(selectedTargetVerdict === undefined ? {} : {proofTarget:selectedTargetVerdict}),
          sourceDigest:hash(originalBytes),candidateDigest,
          proofProgram:selectedProgram,
          ...(byProgram.has(program) ? {sourceProposals:byProgram.get(program)} : {}),
          proofTerm:"by\n  " + selectedProgram.split("\n").join("\n  "),
          candidateSource:selectedSource,hints:Object.freeze(hints),
          ...(previous === null ? {} : {resumedFrom:previous.id}),
          attempts:Object.freeze(attempts),started,ended:new Date().toISOString(),
          venueAccepted:false,
          note:"The original theorem was compiled by Lean. Fixed suggestions are replayed before selection; external Comparator acceptance remains separate.",
        }));
      }
      if (result?.state === "refused" || result?.state === "timed-out" ||
          targetVerdict?.status === "refused") break;
    }
    return retainProofAttempt(root, Object.freeze({
      kind:"metroplat.lean.proof-search-result", id:plan.id, state:"unresolved",
      project:root, file:task === undefined ? plan.file : plan.taskDirectory + "/Main.lean",
      declaration:plan.declaration,originalAxioms,
      ...(task === undefined ? {} : {task:taskIdentity(task)}),
      sourceDigest:hash(originalBytes),
      hints:Object.freeze(hints), attempts:Object.freeze(attempts),
      ...(previous === null ? {} : {resumedFrom:previous.id}),
      frontier:Object.freeze([...attempts,...(previous?.frontier ?? []).map(entry => ({openGoals:entry.openGoals,program:entry.program}))].filter(a => a.openGoals?.length)
        .sort((a,b) => a.openGoals.length - b.openGoals.length).slice(0, 3)
        .map(a => Object.freeze({program:a.program,openGoals:a.openGoals}))),
      started, ended:new Date().toISOString(), venueAccepted:false,
      note:"Real compiler attempts did not close the theorem; unsolved Lean goals are the research frontier.",
    }));
  } finally {
    await unlink(scratch).catch(e => {if(e?.code!=="ENOENT")throw e;});
    await rmdir(folder).catch(e => {if(!["ENOENT","ENOTEMPTY"].includes(e?.code))throw e;});
  }
}
