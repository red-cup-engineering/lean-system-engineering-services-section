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

/**
 * The authenticated RPC caller may receive a complete proof candidate. The
 * shared EAVT journal must not reproduce unpublished bounty proof bytes,
 * generated tactic programs, unsolved goals, chat transcripts, or source paths.
 * It keeps only the evidence needed to resume qualified original Work.
 */
function appendProofEvidence(dataRoot, result, context) {
    const item = {
        kind:"metroplat.lean.proof-search-evidence",
        id:result.id,state:result.state,
        sourceDigest:result.sourceDigest ?? null,
        candidateDigest:result.candidateDigest ?? null,
        attemptCount:result.attempts?.length ?? 0,
        taskId:result.task?.taskId ?? null,
        taskBundleDigest:result.task?.taskBundleDigest ?? null,
        verifierReportDigest:result.verifierReportDigest ?? null,
        verifiedLocally:result.verifiedLocally ?? false,
        venueAccepted:false,
        ended:result.ended ?? new Date().toISOString(),
    };
    append(dataRoot,item,context,leanProofFeed);
    return result;
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
        description: "Provide either (a) a pinned Lean project, exact qualified target declaration and one original by-sorry .lean file, with optional Blueprint predecessor lemmas and proofTarget, or (b) an existing Conjectures v2 taskDirectory inside the pinned Lean project holding its Challenge, header/footer, manifest and Comparator. Source-owned mathematical offices may supply up to sixteen project-local proofs/*.tactic proposalFiles with complete derivations; these run before fallback search tactics, and returned proofs retain their source proposal identities. The source-owned theorem route uses the existing bounded Lean worker. For a Conjectures task the service invokes the installed official Conjectures validator under its own exact task/build pins and production Comparator/kernel sandbox, consuming the generated Main.lean as a private candidate. Local verification is not live submission, paid acceptance or an award. Source theorem identity and permitted task axioms are preserved. Neither local compilation nor a receipt replaces the platform Comparator or proves prize acceptance.",
        run: async (input, _args, context) => {
            const id = randomUUID();
            const requestedAt = new Date().toISOString();
            append(dataRoot, {kind:"metroplat.lean.proof-search-request",id,state:"requested",
                requestedAt,request:{mode:input?.taskDirectory ? "conjectures" : "source",
                    proposalCount:Array.isArray(input?.proposalFiles) ? input.proposalFiles.length : 0},
                requestedBy:context?.invocation?.subject ?? null},context,leanProofFeed);
            try {
                const plan = planLeanProof({...(input ?? {}),id});
                const result = await runLeanProofSearch(plan, {
                    taskRoot:process.env.CONJECTURES_TASKS_ROOT || undefined,
                    validatorRoot:process.env.CONJECTURES_VALIDATOR_ROOT || undefined,
                });
                return appendProofEvidence(dataRoot,result,context);
            } catch (error) {
                return appendProofEvidence(dataRoot,{
                    kind:"metroplat.lean.proof-search-result",id,state:"failed",
                    sourceDigest:"unavailable",attempts:[],venueAccepted:false,
                    started:requestedAt,ended:new Date().toISOString(),
                    note:error instanceof Error ? error.message : String(error),
                },context);
            }
        },
    })]);
}
