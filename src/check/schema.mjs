import { schemaFrom } from "@red-cup-engineering/json-schema-services-section/contracts";
import { maximumLeanCheckTimeoutMs } from "./plan.mjs";
const text = { type: "string", minLength: 1 };
const names = { type: "array", items: text };
const common = { project: text, timeoutMs: { type: "integer", minimum: 1, maximum: maximumLeanCheckTimeoutMs } };
export const leanCheckRequestSchema = {
    $id: "lean/compiler-action-request", title: "LeanCompilerActionRequest",
    oneOf: [
        { type: "object", required: ["project"], additionalProperties: false,
          properties: { ...common, mode: { const: "build" }, targets: names } },
        { type: "object", required: ["project", "mode", "file"], additionalProperties: false,
          properties: { ...common, mode: { const: "file" }, file: text } },
        { type: "object", required: ["project", "mode", "module", "declaration"], additionalProperties: false,
          properties: { ...common, mode: { const: "declaration" }, module: text, declaration: text } },
        { type: "object", required: ["project", "mode"], additionalProperties: false,
          properties: { ...common, mode: { const: "wit-ledger" } } },
    ],
};
export const leanCheckResultSchema = {
    $id: "lean/compiler-action-result", title: "LeanCompilerActionResult",
    type: "object", required: ["kind", "id", "state"],
    properties: {
        kind: { const: "metroplat.lean.check-result" }, id: text,
        state: { enum: ["succeeded", "failed", "refused", "timed-out"] },
        inspection: { type: "object", required: ["declaration", "axioms", "dependencies"], additionalProperties: false,
            properties: { declaration: text, axioms: names, dependencies: names } },
        witLedger: { type: "object", required: ["kind", "producer", "ledger", "toolchain", "localSources", "declarations", "constants", "carrying", "paid", "sites", "entries"],
            properties: { kind: { const: "obsmetrologia.wit-ledger-inspection" },
                producer: { type: "object" }, ledger: { type: "object" }, toolchain: text,
                localSources: { type: "object" }, declarations: { type: "integer", minimum: 0 }, constants: { type: "integer", minimum: 0 },
                carrying: { type: "integer", minimum: 0 }, paid: { type: "integer", minimum: 0 }, sites: { type: "integer", minimum: 0 },
                entries: { type: "array", items: { type: "object", required: ["declaration", "own", "carried"], additionalProperties: false,
                    properties: { declaration: text, own: { type: "integer", minimum: 0 }, carried: { type: "integer", minimum: 1 } } } } } },
    },
};
export const leanCheckRequestContract = schemaFrom(leanCheckRequestSchema);
export const leanCheckResultContract = schemaFrom(leanCheckResultSchema);

