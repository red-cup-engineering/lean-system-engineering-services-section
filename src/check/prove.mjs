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
    if (!["project", "file", "id", "maxAttempts", "timeoutMs", "blueprintLabel", "hints"].includes(key))
      throw new TypeError("lean-prove: unexpected field " + key);
  return Object.freeze({
    kind: "metroplat.lean.proof-search-plan", id, project: path.resolve(input.project), file,
    maxAttempts: bounded(input.maxAttempts ?? 16, "maxAttempts", 1, 64),
    timeoutMs: bounded(input.timeoutMs ?? 60_000, "timeoutMs", 1000, 180_000),
    hints: Object.freeze(qualifiedHints(input.hints ?? [])),
    ...(input.blueprintLabel === undefined ? {} : {blueprintLabel:input.blueprintLabel}),
  });
}

/**
 * Use the actual Blueprint uses edges to retrieve the predecessor claim's
 * Lean declarations; filter against the same project's declaration catalog.
 * Never interpret the mathematical prose as a proof or a tactic.
 */
export function proofHintsFromBlueprint(workspace, label) {
  const graph = workspace?.texWorkspaceRead?.blueprintClaimGraph;
  const node = graph?.nodes?.find(n => n.id === label);
  if (!node) throw new Error("lean-prove: missing original Blueprint claim " + label);
  const known = new Set(workspace.declarationCatalog.entries.map(e => e.name));
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const self = new Set(node.leanDeclarations);
  return Object.freeze([...new Set(graph.edges.filter(e => e.from === label)
    .flatMap(e => byId.get(e.to)?.leanDeclarations ?? [])
    .filter(n => known.has(n) && qualified.test(n) && !self.has(n)))].sort());
}

/** Tactics and lemma applications. These are real proof attempts, not model scores. */
export function proofPrograms(hints = []) {
  const programs = [
    "rfl", "assumption", "trivial", "decide", "simp", "simp_all",
    "omega", "aesop", "exact?", "constructor <;> assumption",
    "constructor <;> simp", "intro h\n  exact h",
    "simp_all\n  all_goals omega", "simp\n  all_goals aesop",
  ];
  const names = qualifiedHints(hints);
  for (const name of names)
    programs.unshift("exact " + name, "simpa using " + name);
  for (const name of names)
    programs.push("apply " + name + " <;> assumption", "apply " + name + " <;> simp");
  if (names.length)
    programs.push("simp [" + names.join(", ") + "]", "simp_all [" + names.join(", ") + "]");
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
  const fromBlueprint = plan.blueprintLabel === undefined ? [] :
    proofHintsFromBlueprint(workspaceRead(root), plan.blueprintLabel);
  const hints = [...new Set([...fromBlueprint, ...plan.hints])].slice(0, 32);
  const programs = proofPrograms(hints).slice(0, plan.maxAttempts);
  const folder = path.join(root, ".lake", "proof-search");
  const file = "ProofSearch_" + plan.id.replaceAll("-", "_") + ".lean";
  const scratch = path.join(folder, file);
  const scratchRelative = ".lake/proof-search/" + file;
  await mkdir(folder, { recursive: true });
  const attempts = [], started = new Date().toISOString();
  try {
    for (let index = 0; index < programs.length; index += 1) {
      if (hash(await readFile(sourcePath)) !== hash(originalBytes))
        throw new Error("lean-prove: source changed during search");
      const program = programs[index];
      const candidate = replaceProofHole(original, program);
      await writeFile(scratch, candidate, { mode: 0o600 });
      const planCheck = planLeanCheck({
        id: ("proof-" + plan.id + "-" + index).slice(0, 80),
        project: root, mode: "file", file: scratchRelative,
        timeoutMs: plan.timeoutMs,
      });
      const result = await check(planCheck);
      const compiled = result?.state === "succeeded";
      attempts.push(Object.freeze({
        index, program, state: result?.state ?? "failed",
        ...(compiled ? {} : {diagnostic:diagnostic(result)}),
      }));
      if (compiled) {
        if (hash(await readFile(sourcePath)) !== hash(originalBytes))
          throw new Error("lean-prove: theorem changed during successful search");
        return Object.freeze({
          kind: "metroplat.lean.proof-search-result", id:plan.id,
          state:"candidate-compiled", project:root, file:plan.file,
          sourceDigest:hash(originalBytes), candidateDigest:hash(candidate),
          proofProgram:program, candidateSource:candidate, hints:Object.freeze(hints),
          attempts:Object.freeze(attempts), started, ended:new Date().toISOString(),
          venueAccepted:false,
          note:"Lean compiled this exact candidate. Axiom audit, exact external Comparator and mathematical correspondence remain distinct.",
        });
      }
      if (result?.state === "refused" || result?.state === "timed-out") break;
    }
    return Object.freeze({
      kind:"metroplat.lean.proof-search-result", id:plan.id, state:"unresolved",
      project:root, file:plan.file, sourceDigest:hash(originalBytes),
      hints:Object.freeze(hints), attempts:Object.freeze(attempts),
      started, ended:new Date().toISOString(), venueAccepted:false,
      note:"Real compiler attempts did not close the theorem; diagnostics remain useful research input.",
    });
  } finally {
    await unlink(scratch).catch(e => {if(e?.code!=="ENOENT")throw e;});
    await rmdir(folder).catch(e => {if(!["ENOENT","ENOTEMPTY"].includes(e?.code))throw e;});
  }
}
