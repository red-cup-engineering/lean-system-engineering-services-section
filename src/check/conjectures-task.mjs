/**
 * Consume a published Conjectures task's exact Challenge/solution frame as a
 * proof-construction target. This is a producer, not a new verifier or market.
 *
 * The task files are read from a caller-selected local checkout. Their hashes
 * and identities must agree internally, but publication/current eligibility
 * must still be established by the platform's own allowlist and verifier.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const HASHED_FILES = Object.freeze([
  "Challenge.lean", "SolutionHeader.lean.txt", "SolutionFooter.lean.txt",
  "comparator-config.json", "source-metadata.json", "task-version.json",
]);
const sha = bytes => "sha256:" + createHash("sha256").update(bytes).digest("hex");

function validRelative(input) {
  if (typeof input !== "string" || !input || input.startsWith("/") ||
      input.includes("\\") || path.isAbsolute(input) ||
      input.split("/").some(part => part === "" || part === "." || part === ".."))
    throw new TypeError("lean-prove: taskDirectory must be a project-relative task bundle");
  return input;
}
async function regular(directory, name, maxBytes = name === "task-version.json" ? 524288 : 131072) {
  const file = path.join(directory, name);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes)
    throw new TypeError("lean-prove: task member is not a bounded regular file: " + name);
  return readFile(file);
}
function json(bytes, name) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new TypeError("lean-prove: invalid " + name); }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("lean-prove: invalid task object " + name);
  return value;
}

/**
 * A Conjectures v2 task describes precisely one theorem. Its ordinary
 * Main.lean contains ONLY the declaration between official header/footer.
 * Retaining those bytes makes the emitted problem exactly the published
 * Challenge, rather than an invented weaker theorem or substitute notation.
 */
export async function readConjecturesTask(project, taskDirectory, {taskRoot} = {}) {
  // An installed task checkout is authoritative for task bytes; the Lean
  // workspace may be elsewhere. The operator, not a user-supplied RPC path,
  // selects this root through the existing CONJECTURES_TASKS_ROOT binding.
  const root = await realpath(taskRoot ?? project);
  const relative = validRelative(taskDirectory);
  const dir = await realpath(path.join(root, relative));
  const delta = path.relative(root, dir);
  if (!delta || delta === ".." || delta.startsWith(".." + path.sep) || path.isAbsolute(delta))
    throw new TypeError("lean-prove: task bundle escapes the Lean project");
  const [rawManifest, ...data] = await Promise.all([
    regular(dir, "manifest.json"), ...HASHED_FILES.map(name => regular(dir, name)),
  ]);
  const manifest = json(rawManifest, "manifest.json");
  const members = Object.fromEntries(HASHED_FILES.map((name, index) => [name, data[index]]));
  const trusted = manifest.trusted_file_hashes;
  if (!trusted || typeof trusted !== "object" || Array.isArray(trusted))
    throw new TypeError("lean-prove: task has no published member commitments");
  for (const name of HASHED_FILES) {
    if (!SHA256.test(trusted[name] ?? "") || trusted[name] !== sha(members[name]))
      throw new TypeError("lean-prove: changed task member " + name);
  }
  if (manifest.adapter_version !== 2 || manifest.classification !== "DIRECT_PROP" ||
      manifest.production_eligible !== true || manifest.target_theorem !== "Bounty.target" ||
      !["formalized", "counterexample"].includes(manifest.task_mode) ||
      typeof manifest.task_id !== "string" || manifest.task_id !== path.basename(dir) ||
      !Array.isArray(manifest.theorem_names) || manifest.theorem_names.length !== 1 ||
      manifest.theorem_names[0] !== "Bounty.target")
    throw new TypeError("lean-prove: unsupported Conjectures task or unpublished target");
  const config = json(members["comparator-config.json"], "comparator-config.json");
  if (config.challenge_module !== "Challenge" || config.solution_module !== "Solution" ||
      !Array.isArray(config.theorem_names) || config.theorem_names.length !== 1 ||
      config.theorem_names[0] !== "Bounty.target")
    throw new TypeError("lean-prove: task Comparator does not target the original theorem");
  const challenge = members["Challenge.lean"].toString("utf8");
  const header = members["SolutionHeader.lean.txt"].toString("utf8");
  const footer = members["SolutionFooter.lean.txt"].toString("utf8");
  if (!challenge.startsWith(header) || !challenge.endsWith(footer) ||
      challenge.length <= header.length + footer.length)
    throw new TypeError("lean-prove: challenge is not between its trusted solution frame");
  const main = challenge.slice(header.length, challenge.length - footer.length);
  if ((main.match(/:=\s*by\s+sorry\b/gu) ?? []).length !== 1 ||
      !/\btheorem\s+target\s*:/u.test(main) ||
      !main.includes(JSON.stringify(manifest.source_theorem)))
    throw new TypeError("lean-prove: published target's proof hole or theorem identity differs");
  const allowed = manifest.permitted_axioms;
  if (!Array.isArray(allowed) || !allowed.every(a => typeof a === "string") ||
      allowed.includes("sorryAx"))
    throw new TypeError("lean-prove: invalid published axiom policy");
  if (!Number.isSafeInteger(manifest.max_submission_bytes) || manifest.max_submission_bytes < 1)
    throw new TypeError("lean-prove: task has no submission size limit");
  const version = json(members["task-version.json"], "task-version.json");
  if (version.dependency_identity_sha256 !== manifest.dependency_identity_sha256 ||
      version.environment_identity_sha256 !== manifest.environment_identity_sha256)
    throw new TypeError("lean-prove: task version identity differs from its manifest");

  // A manifest hash is NOT the Conjectures payment/submission identity.
  // Read the publisher's original task allowlist and append-only version
  // registry at this exact installed checkout. Neither is generated by us.
  const [listBytes,registryBytes] = await Promise.all([
    regular(root,"allowlist.json",2*1024*1024),
    regular(root,"task-versions.json",16*1024*1024),
  ]);
  const allowlist = json(listBytes,"allowlist.json");
  const registry = json(registryBytes,"task-versions.json");
  if (!Array.isArray(allowlist.allowed_task_bundles) ||
      !Array.isArray(registry.versions))
    throw new TypeError("lean-prove: Conjectures publisher task index is unavailable");
  const allowedRows = allowlist.allowed_task_bundles.filter(row => row.task_id === manifest.task_id);
  const versions = registry.versions.filter(row => row.task_id === manifest.task_id);
  if (allowedRows.length !== 1 || versions.length !== 1)
    throw new TypeError("lean-prove: task is not uniquely admitted in the original publisher index");
  const published = allowedRows[0], admitted = versions[0];
  if (!SHA256.test(published.task_bundle_sha256 ?? "") ||
      published.task_bundle_sha256 !== admitted.task_bundle_sha256 ||
      admitted.state !== "active" || admitted.location !== relative ||
      admitted.mode !== manifest.task_mode || published.mode !== manifest.task_mode ||
      published.source_path !== manifest.source_path ||
      !Array.isArray(published.theorems) ||
      published.theorems.length !== 1 ||
      published.theorems[0] !== manifest.source_theorem ||
      !Array.isArray(admitted.theorems) ||
      admitted.theorems[0] !== manifest.source_theorem ||
      admitted.environment_identity_sha256 !== manifest.environment_identity_sha256 ||
      admitted.dependency_identity_sha256 !== manifest.dependency_identity_sha256 ||
      admitted.reward_target_id !== published.reward_target_id)
    throw new TypeError("lean-prove: task version differs from the published active task commitment");
  return Object.freeze({
    kind:"metroplat.lean.conjectures-task", taskId:manifest.task_id,
    taskMode:manifest.task_mode, sourceTheorem:manifest.source_theorem,
    targetDeclaration:manifest.target_theorem, challengePath:path.join(dir,"Challenge.lean"),
    challengeDigest:sha(members["Challenge.lean"]), manifestDigest:sha(rawManifest),
    taskBundleDigest:published.task_bundle_sha256,
    rewardTargetId:published.reward_target_id,
    publisherSourceRevision:allowlist.repository_commit,
    publisherAuditDate:allowlist.audit_date_utc,
    // This certifies only the local task-index snapshot, NOT live eligibility,
    // account possession, current validator health or payment entitlement.
    publisherIndexState:"active-in-local-publisher-snapshot",
    dependencyIdentity:manifest.dependency_identity_sha256,
    environmentIdentity:manifest.environment_identity_sha256,
    allowedAxioms:Object.freeze([...allowed]),
    forbiddenDependencies:Object.freeze([...(manifest.forbidden_dependencies ?? [])]),
    maxSubmissionBytes:manifest.max_submission_bytes,
    header, footer, main, originalChallenge:challenge,
  });
}

/** Convert only the generated declaration, not its imports, into Main.lean. */
export function renderConjecturesCandidate(task, proofBody) {
  if (typeof proofBody !== "string" || !proofBody.includes("theorem target"))
    throw new TypeError("lean-prove: candidate is not a target theorem declaration");
  if (Buffer.byteLength(proofBody) > task.maxSubmissionBytes)
    throw new RangeError("lean-prove: generated Main.lean exceeds the original task limit");
  return Object.freeze({
    mainLean:proofBody,
    compilerSource:task.header + proofBody + task.footer,
    mainDigest:sha(Buffer.from(proofBody,"utf8")),
    taskId:task.taskId,taskBundleDigest:task.taskBundleDigest,
  });
}
