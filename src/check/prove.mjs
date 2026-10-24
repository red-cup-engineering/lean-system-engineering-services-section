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
  if (typeof input?.declaration !== "string" || !qualified.test(input.declaration))
    throw new TypeError("lean-prove: target declaration must be an exact qualified Lean name");
  if (typeof input?.project !== "string" || !input.project.trim() ||
      typeof file !== "string" || !file.endsWith(".lean") || path.isAbsolute(file) ||
      file.startsWith("-") || file.includes("\\") ||
      file.split("/").some(p => !p || p === "." || p === ".."))
    throw new TypeError("lean-prove: existing in-project .lean source required");
  const id = input.id ?? randomUUID();
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,60}$/u.test(id))
    throw new TypeError("lean-prove: invalid work id");
  if (input.blueprintLabel !== undefined &&
      (typeof input.blueprintLabel !== "string" ||
       !/^[a-z]+:[a-z0-9-]+$/u.test(input.blueprintLabel)))
    throw new TypeError("lean-prove: blueprintLabel must be an exact source claim label");
  for (const key of Object.keys(input))
    if (!["project", "file", "id", "declaration", "maxAttempts", "timeoutMs", "blueprintLabel", "hints", "proofTarget"].includes(key))
      throw new TypeError("lean-prove: unexpected field " + key);
  return Object.freeze({
    kind: "metroplat.lean.proof-search-plan", id, project: path.resolve(input.project), file,
    declaration:input.declaration,
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
  const programs = [];
  // Earned Blueprint predecessor lemmas get compiler attention before generic
  // tactics. The number of available candidate programs is bounded by the
  // original work's explicit attempt budget.
  for (const name of names) {
    programs.push("exact " + name, "simpa using " + name,
      "apply " + name + " <;> assumption",
      "apply " + name + " <;> simp");
  }
  if (names.length)
    programs.push("simp [" + names.join(", ") + "]",
      "simp_all [" + names.join(", ") + "]");
  programs.push("rfl", "assumption", "trivial", "simp", "simp_all",
    "decide", "omega", "aesop", "exact?", "constructor <;> assumption",
    "constructor <;> simp", "intro h\nexact h",
    "simp_all\nall_goals omega", "simp\nall_goals aesop");
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

function diagnostic(result) {
  const texts = [...(result?.errors ?? []), ...(result?.compilerErrors ?? [])]
    .map(x => typeof x === "string" ? x : x.message ?? JSON.stringify(x)).filter(Boolean);
  return (texts.length ? texts.join("\n") : String(result?.stderr ?? result?.stdout ?? "")).slice(-2500);
}

/**
 * Search, without modifying the original. Each alternative invokes the actual
 * existing lean-check/Lake executor, which enforces one concurrent node scope,
 * memory and time limits. The worker is never simulated by this service.
 */
export async function runLeanProofSearch(plan, {check = runLeanCheck, workspaceRead = readLeanWorkspaceCore} = {}) {
  const root = await realpath(plan.project);
  const sourcePath = await realpath(path.join(root, plan.file));
  const rel = path.relative(root, sourcePath);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel))
    throw new TypeError("lean-prove: source escapes project");
  const originalBytes = await readFile(sourcePath);
  if (originalBytes.length > 131072) throw new TypeError("lean-prove: source too large");
  const original = originalBytes.toString("utf8");
  if ([...original.matchAll(hole)].length !== 1)
    throw new TypeError("lean-prove: original source lacks unique proof hole");
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
      // The admitted source remains exactly the candidate: only the private
      // scratch adds Lean’s native transitive axiom query for the target name.
      await writeFile(scratch, candidate + "\n#print axioms " + plan.declaration + "\n", {mode:0o600});
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
        if (hash(await readFile(sourcePath)) !== hash(originalBytes))
          throw new Error("lean-prove: theorem changed during successful search");
        return Object.freeze({
          kind: "metroplat.lean.proof-search-result", id:plan.id,
          state:"candidate-compiled", project:root, file:plan.file,
          declaration:plan.declaration, axioms, axiomReadout:readout.slice(-2500),
          ...(targetVerdict === undefined ? {} : {proofTarget:targetVerdict}),
          sourceDigest:hash(originalBytes), candidateDigest:hash(candidate),
          proofProgram:program, candidateSource:candidate, hints:Object.freeze(hints),
          attempts:Object.freeze(attempts), started, ended:new Date().toISOString(),
          venueAccepted:false,
          note:"Lean compiled this exact candidate. Axiom audit, exact external Comparator and mathematical correspondence remain distinct.",
        });
      }
      if (result?.state === "refused" || result?.state === "timed-out" ||
          targetVerdict?.status === "refused") break;
    }
    return Object.freeze({
      kind:"metroplat.lean.proof-search-result", id:plan.id, state:"unresolved",
      project:root, file:plan.file, declaration:plan.declaration,
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
