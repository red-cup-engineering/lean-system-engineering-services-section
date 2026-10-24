/**
 * Construct Lean proof candidates from an unchanged source theorem.
 * Source-owned Blueprint uses arcs supply lemma names; Lean/Lake actually
 * checks each generated candidate using the existing bounded runner.
 *
 * This produces proof text or the first unsolved goals, never a fake verdict.
 */
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, realpath, unlink, writeFile, rmdir } from "node:fs/promises";
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
    if (!["project", "file", "taskDirectory", "id", "declaration", "maxAttempts", "timeoutMs", "blueprintLabel", "hints", "proofTarget"].includes(key))
      throw new TypeError("lean-prove: unexpected field " + key);
  return Object.freeze({
    kind: "metroplat.lean.proof-search-plan", id, project: path.resolve(input.project),
    ...(isTask ? { taskDirectory, declaration:"Bounty.target" } :
      { file, declaration:input.declaration }),
    maxAttempts: bounded(input.maxAttempts ?? 16, "maxAttempts", 1, 64),
    timeoutMs: bounded(input.timeoutMs ?? 60_000, "timeoutMs", 1000, 180_000),
    hints: Object.freeze(qualifiedHints(input.hints ?? [])),
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

function taskIdentity(task) {
  return Object.freeze({
    taskId:task.taskId, taskMode:task.taskMode, sourceTheorem:task.sourceTheorem,
    challengeDigest:task.challengeDigest, manifestDigest:task.manifestDigest,
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
  const rel = path.relative(root, sourcePath);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel))
    throw new TypeError("lean-prove: source escapes project");
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
  const programs = [...proofPrograms(hints)];
  const queued = new Set(programs);
  const folder = path.join(root, ".lake", "proof-search");
  const file = "ProofSearch_" + plan.id.replaceAll("-", "_") + ".lean";
  const scratch = path.join(folder, file);
  const scratchRelative = ".lake/proof-search/" + file;
  await mkdir(folder, { recursive: true });
  const attempts = [], started = new Date().toISOString();
  try {
    for (let index = 0; index < programs.length && index < plan.maxAttempts; index += 1) {
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
        timeoutMs: plan.timeoutMs,
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
        const suggestion = suggestedExactProof(readout);
        // Canonicalize a search tactic (exact?) into the concrete proof that
        // Lean actually suggested. Never trust an info message without replay.
        if (suggestion && suggestion !== program && attempts.length < plan.maxAttempts) {
          const simplified = replaceProofHole(original, suggestion);
          const rendered = task === undefined ? simplified :
            renderConjecturesCandidate(task, simplified).compilerSource;
          await writeFile(scratch, rendered + "\n#print axioms " + plan.declaration + "\n",
            {mode:0o600});
          const replay = await check(planCheck);
          const replayOutput = String(replay?.stdout ?? "") + "\n" + String(replay?.stderr ?? "");
          const replayAxioms = replay?.state === "succeeded" ?
            readPrintedAxioms(replayOutput, plan.declaration) : null;
          const simplerValid = replay?.state === "succeeded" && replayAxioms !== null &&
            !replayAxioms.includes("sorryAx") &&
            (task === undefined || replayAxioms.every(a => task.allowedAxioms.includes(a)));
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
          }
        }
        if (hash(await readFile(sourcePath)) !== hash(originalBytes))
          throw new Error("lean-prove: original theorem changed during proof construction");
        if (task !== undefined) {
          const currentTask = await readConjecturesTask(root, plan.taskDirectory, {taskRoot});
          if (currentTask.manifestDigest !== task.manifestDigest ||
              currentTask.challengeDigest !== task.challengeDigest)
            throw new Error("lean-prove: original Conjectures task changed during proof construction");
        }
        return Object.freeze({
          kind: "metroplat.lean.proof-search-result", id:plan.id,
          state:"candidate-compiled", project:root,
          file:task === undefined ? plan.file : plan.taskDirectory + "/Main.lean",
          declaration:plan.declaration, axioms:selectedAxioms,
          axiomReadout:selectedReadout.slice(-2500),
          ...(task === undefined ? {} : {task:taskIdentity(task),mainLean:selectedSource}),
          ...(targetVerdict === undefined ? {} : {proofTarget:targetVerdict}),
          sourceDigest:hash(originalBytes),candidateDigest:hash(selectedSource),
          proofProgram:selectedProgram,
          proofTerm:"by\n  " + selectedProgram.split("\n").join("\n  "),
          candidateSource:selectedSource,hints:Object.freeze(hints),
          attempts:Object.freeze(attempts),started,ended:new Date().toISOString(),
          venueAccepted:false,
          note:"The original theorem was compiled by Lean. Fixed suggestions are replayed before selection; external Comparator acceptance remains separate.",
        });
      }
      if (result?.state === "refused" || result?.state === "timed-out" ||
          targetVerdict?.status === "refused") break;
    }
    return Object.freeze({
      kind:"metroplat.lean.proof-search-result", id:plan.id, state:"unresolved",
      project:root, file:task === undefined ? plan.file : plan.taskDirectory + "/Main.lean",
      declaration:plan.declaration,
      ...(task === undefined ? {} : {task:taskIdentity(task)}),
      sourceDigest:hash(originalBytes),
      hints:Object.freeze(hints), attempts:Object.freeze(attempts),
      frontier:Object.freeze(attempts.filter(a => a.openGoals?.length)
        .sort((a,b) => a.openGoals.length - b.openGoals.length).slice(0, 3)
        .map(a => Object.freeze({program:a.program,openGoals:a.openGoals}))),
      started, ended:new Date().toISOString(), venueAccepted:false,
      note:"Real compiler attempts did not close the theorem; unsolved Lean goals are the research frontier.",
    });
  } finally {
    await unlink(scratch).catch(e => {if(e?.code!=="ENOENT")throw e;});
    await rmdir(folder).catch(e => {if(!["ENOENT","ENOTEMPTY"].includes(e?.code))throw e;});
  }
}
