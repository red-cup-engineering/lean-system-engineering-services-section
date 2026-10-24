import { randomUUID } from "node:crypto";
import { put } from "@red-cup-engineering/semiotic-eavt-services-section/store";
import { operation } from "@red-cup-engineering/computer-system-engine/rpc/operation";
import { planLeanCheck } from "./check/plan.mjs";
import { runLeanCheck } from "./check/run.mjs";
import { planLeanProof, runLeanProofSearch } from "./check/prove.mjs";
import { leanProofSearchRequestContract, leanProofSearchResultContract } from "./check/prove-schema.mjs";
import { leanCheckRequestContract, leanCheckResultContract } from "./check/schema.mjs";

export const leanCheckFeed = "lean-checks";
export const leanProofFeed = "lean-proofs";

function append(dataRoot, value, context, feed = leanCheckFeed) {
    const record = JSON.parse(JSON.stringify(value));
    const at = record.ended ?? record.requestedAt;
    put(dataRoot, feed, { ...record, at });
    return record;
}

export function leanCheckOperations({ dataRoot }) {
    return Object.freeze([operation({
        verb: "lean-check", inputFormat: "json", outputFormat: "json",
        domain: leanCheckRequestContract, codomain: leanCheckResultContract, locus: "project",
        writes: [leanCheckFeed],
        effects: { class: "external", replay: "coordinated", coordination: "coordination-required", deterministic: "unmeasured", totality: "partial" },
        summary: "Run a bounded Lake build, Lean file check, or declaration inspection in lean.slice with durable compiler evidence.",
        description: "Domain: { project, mode?: build|file|declaration, timeoutMs?: integer }. Build accepts targets?: string[]; file requires file: project-relative .lean path; declaration requires qualified module and declaration names and may carry proofTarget: { platform, targetId, taskDigest, challenge:{path,digest}, toolchain, manifestDigest, sourceDigest, permittedAxioms }. The optional challenge/toolchain/manifest SHA-256 pin and collected axiom policy preflight fail closed, but are NOT an external challenge Comparator, publisher authentication, independent proof receipt, or award. No arbitrary command or args. Only one bounded check runs per node; concurrency is refused with runningId.",
        run: async (input, _args, context) => {
            const plan = planLeanCheck({ ...(input ?? {}), id: randomUUID() });
            const requestedAt = new Date().toISOString();
            append(dataRoot, { kind: "metroplat.lean.check-request", id: plan.id, state: "requested", requestedAt, request: plan, requestedBy: context?.invocation?.subject ?? null }, context);
            try {
                const result = await runLeanCheck(plan);
                return append(dataRoot, result.ended === undefined ? { ...result, ended: new Date().toISOString() } : result, context);
            } catch (error) {
                const result = { kind: "metroplat.lean.check-result", id: plan.id, state: "failed", project: plan.project, targets: plan.targets, ended: new Date().toISOString(), errors: [{ message: error instanceof Error ? error.message : String(error) }] };
                append(dataRoot, result, context);
                return result;
            }
        },
    }), operation({
        verb: "lean-prove", inputFormat: "json", outputFormat: "json",
        domain: leanProofSearchRequestContract, codomain: leanProofSearchResultContract,
        locus: "project", writes: [leanProofFeed],
        effects: { class: "external", replay: "coordinated", coordination: "coordination-required", deterministic: "unmeasured", totality: "partial" },
        summary: "Construct actual Lean proof candidates from one unresolved theorem and its Blueprint predecessor lemmas, using the bounded compiler.",
        description: "Provide a project, exact qualified target declaration and one .lean file with exactly one by-sorry hole. Optionally name an original Blueprint claim whose mapped declaration must match this target, qualified Lean predecessor lemmas, and an original externally pinned proofTarget using exactly the lean-check task schema. Candidate success requires actual compiler output, #print axioms, and source/axiom-policy consistency with that target when provided. The service compiles generated proof programs against the unchanged theorem using the installed lean-check executor, returns the first compiled source or the real failed compiler diagnostics. Never declares independent Comparator acceptance, imported axiom validity or a paid bounty.",
        run: async (input, _args, context) => {
            const id = randomUUID();
            const requestedAt = new Date().toISOString();
            append(dataRoot, {kind:"metroplat.lean.proof-search-request",id,state:"requested",
                requestedAt,request:input,requestedBy:context?.invocation?.subject ?? null},context,leanProofFeed);
            try {
                const plan = planLeanProof({...(input ?? {}),id});
                const result = await runLeanProofSearch(plan);
                return append(dataRoot,result,context,leanProofFeed);
            } catch (error) {
                return append(dataRoot,{
                    kind:"metroplat.lean.proof-search-result",id,state:"failed",
                    sourceDigest:"unavailable",attempts:[],venueAccepted:false,
                    started:requestedAt,ended:new Date().toISOString(),
                    note:error instanceof Error ? error.message : String(error),
                },context,leanProofFeed);
            }
        },
    })]);
}
