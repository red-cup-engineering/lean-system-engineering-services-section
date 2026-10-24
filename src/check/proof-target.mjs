/**
 * Fail-closed local preflight for an externally supplied Lean proof target.
 * No claim of venue authentication, independent comparison or prize acceptance.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, realpath, readdir, stat } from "node:fs/promises";

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const leanName = /^[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*$/u;
const unchecked = Object.freeze([
  "publisher-task-authenticity",
  "challenge-solution-comparator",
  "forbidden-import-and-transitive-dependency-policy",
  "external-import-and-build-cache-reproducibility",
  "immutable-worktree-and-runtime-isolation",
  "mathematical-novelty-and-external-review",
  "submission-authorization-and-payout",
]);
function reject(field, reason) { throw new TypeError("lean-check proofTarget: " + field + " " + reason); }
function label(value, field) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || /[\u0000-\u001f]/u.test(value))
    reject(field, "must be single-line nonempty text");
  return value;
}
function digest(value, field) {
  if (typeof value !== "string" || !digestPattern.test(value)) reject(field, "must be sha256:<64 lowercase hex>");
  return value;
}
function fields(value, expected, where) {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(where, "must be an object");
  for (const key of Object.keys(value)) if (!expected.includes(key)) reject(where + "." + key, "is not permitted");
  for (const key of expected) if (!Object.hasOwn(value, key)) reject(where + "." + key, "is required");
}
export function validateProofTarget(value) {
  fields(value, ["platform","targetId","taskDigest","challenge","toolchain","manifestDigest","permittedAxioms"], "target");
  const platform = label(value.platform, "platform");
  let url;
  try { url = new URL(platform); } catch { reject("platform", "must be an https URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) reject("platform", "must be an https URL without credentials or fragment");
  const targetId = label(value.targetId, "targetId");
  const taskDigest = digest(value.taskDigest, "taskDigest");
  fields(value.challenge, ["path","digest"], "challenge");
  const challengePath = label(value.challenge.path, "challenge.path");
  if (!challengePath.endsWith(".lean") || challengePath.startsWith("/") ||
      challengePath.includes("\\") || challengePath.split("/").some(x => !x || x === "." || x === ".."))
    reject("challenge.path", "must be a relative traversal-free POSIX .lean path");
  const challenge = Object.freeze({path:challengePath, digest:digest(value.challenge.digest,"challenge.digest")});
  const toolchain = label(value.toolchain, "toolchain");
  const manifestDigest = digest(value.manifestDigest, "manifestDigest");
  if (!Array.isArray(value.permittedAxioms) || value.permittedAxioms.some(a => typeof a !== "string" || !leanName.test(a)))
    reject("permittedAxioms", "must contain Lean constant names");
  if (new Set(value.permittedAxioms).size !== value.permittedAxioms.length)
    reject("permittedAxioms", "must not repeat axioms");
  if (value.permittedAxioms.some(a => a === "sorryAx" || a.endsWith(".sorryAx")))
    reject("permittedAxioms", "cannot authorize sorryAx");
  return Object.freeze({platform,targetId,taskDigest,challenge,toolchain,manifestDigest,
    permittedAxioms:Object.freeze([...value.permittedAxioms])});
}

/**
 * A bounded content snapshot of in-project Lean sources and proof configuration.
 * This is NOT the entire import closure: external packages and .olean artifacts
 * remain separate verifier obligations. File names and hashes determine the
 * digest, independent of directory traversal order or checkout location.
 */
const omittedTrees = new Set([".git", ".lake", "node_modules", ".cache", ".venv", "dist", "build"]);
const maxSourceFiles = 20_000;
const maxSourceBytes = 256 * 1024 * 1024;
function proofSource(pathname) {
  const name = path.posix.basename(pathname);
  return name.endsWith(".lean") || name === "lean-toolchain" ||
    name === "lakefile.toml" || name === "lake-manifest.json" ||
    name === "formalization.yaml" || name === "formalization.yml" ||
    /^comparator(?:[.-][^/]*)?\.json$/u.test(name);
}
export async function snapshotLeanSources(root) {
  const files = [];
  let totalBytes = 0;
  async function visit(dir, prefix = "") {
    const entries = (await readdir(dir, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.isDirectory() && omittedTrees.has(entry.name)) continue;
      const relative = prefix ? prefix + "/" + entry.name : entry.name;
      const full = path.join(dir, entry.name);
      // A symlinked source tree is neither in this snapshot nor safely excluded.
      if (entry.isSymbolicLink()) {
        if (proofSource(relative) || (await stat(full).catch(() => null))?.isDirectory())
          throw new Error("local-source-symlink:" + relative);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(full, relative);
        continue;
      }
      if (!entry.isFile() || !proofSource(relative)) continue;
      if (files.length >= maxSourceFiles) throw new Error("local-source-file-limit");
      const info = await stat(full);
      if (info.size > maxSourceBytes - totalBytes)
        throw new Error("local-source-byte-limit");
      const bytes = await readFile(full);
      totalBytes += bytes.length;
      files.push({ path: relative, bytes: bytes.length,
        digest: createHash("sha256").update(bytes).digest("hex") });
    }
  }
  await visit(root);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const hash = createHash("sha256");
  for (const file of files)
    hash.update(file.path + "\0" + file.bytes + "\0" + file.digest + "\n");
  return Object.freeze({ digest: "sha256:" + hash.digest("hex"), count: files.length,
    bytes: totalBytes });
}

async function readPinned(root, relative) {
  try {
    const resolved = await realpath(path.join(root, relative));
    const delta = path.relative(root, resolved);
    if (delta === ".." || delta.startsWith(".." + path.sep) || path.isAbsolute(delta))
      return {path:relative,code:"source-outside-project"};
    const bytes = await readFile(resolved);
    return {path:relative,digest:"sha256:" + createHash("sha256").update(bytes).digest("hex"),
      ...(relative === "lean-toolchain" ? {toolchain:bytes.toString("utf8").trim()} : {})};
  } catch (error) {
    return {path:relative,code:error?.code === "ENOENT" ? "source-missing" : "source-unreadable"};
  }
}
/** Re-read actual on-disk bytes before and after running the existing checker. */
export async function observeProofTarget(project, binding) {
  const target = validateProofTarget(binding);
  const root = await realpath(project);
  const files = await Promise.all([
    readPinned(root,target.challenge.path),
    readPinned(root,"lean-toolchain"),
    readPinned(root,"lake-manifest.json"),
  ]);
  const expected = [target.challenge.digest,null,target.manifestDigest];
  let localSources;
  let localSourceError;
  try { localSources = await snapshotLeanSources(root); }
  catch (error) { localSourceError = error instanceof Error ? error.message : "local-source-snapshot-error"; }
  const findings = [];
  if (localSourceError !== undefined) findings.push({code:"local-source-snapshot-unavailable",reason:localSourceError});
  for (let i=0; i<files.length; i+=1) {
    if (files[i].code) findings.push({code:files[i].code,path:files[i].path});
    else if (expected[i] && files[i].digest !== expected[i]) findings.push({code:"digest-mismatch",path:files[i].path});
  }
  if (files[1].toolchain !== undefined && files[1].toolchain !== target.toolchain)
    findings.push({code:"toolchain-mismatch",path:"lean-toolchain"});
  return Object.freeze({matched:findings.length===0,findings:Object.freeze(findings),
    files:Object.freeze(files.map(file=>Object.freeze(file))),
    ...(localSources === undefined ? {} : { localSources })});
}
/** A compiler axiom census is not the venue's independent challenge comparator. */
export function judgeProofTarget(binding, before, after, inspection) {
  const target = validateProofTarget(binding);
  const findings = [...(before?.findings ?? [{code:"initial-observation-missing"}]),
                    ...(after?.findings ?? [{code:"final-observation-missing"}])];
  if (before?.matched && after?.matched)
    for (let i=0; i<before.files.length; i+=1)
      if (before.files[i]?.digest !== after.files[i]?.digest)
        findings.push({code:"source-changed",path:before.files[i].path});
  if (!before?.localSources || !after?.localSources)
    findings.push({code:"local-source-snapshot-missing"});
  else if (before.localSources.digest !== after.localSources.digest)
    findings.push({code:"local-source-tree-changed",before:before.localSources.digest,after:after.localSources.digest});
  if (!inspection || !Array.isArray(inspection.axioms))
    findings.push({code:"axiom-inspection-missing"});
  else {
    const denied = inspection.axioms.filter(a => a === "sorryAx" || a.endsWith(".sorryAx") || !target.permittedAxioms.includes(a));
    if (denied.length) findings.push({code:"axiom-not-permitted",axioms:[...new Set(denied)].sort()});
  }
  return Object.freeze({kind:"metroplat.lean.proof-target-preflight",
    status:findings.length ? "refused" : "preflight-passed",
    platform:target.platform,targetId:target.targetId,taskDigest:target.taskDigest,
    challenge:target.challenge,toolchain:target.toolchain,manifestDigest:target.manifestDigest,
    permittedAxioms:target.permittedAxioms,
    ...(before?.localSources ? {localSources:before.localSources} : {}),
    findings:Object.freeze(findings),unchecked});
}
