/** Bounded Lean topic reading, relocated unchanged from the FeltOS host consumer. */
import path from "node:path";
import { leanWorkspaceTopicReadContract } from "../schema.mjs";
import { decodeLeanLakefileToml } from "../codec/lakefile.mjs";
import { decodeLeanModule } from "../codec/module.mjs";
import { leanDeclarationCatalog } from "../view.mjs";
import { collectLeanSources, sourceReferenceFiles } from "./service.mjs";
import { leanWorkspaceRootModuleFromLakefile } from "./index.mjs";
import { decodeBlueprintTexPlate } from "../blueprint/codec.mjs";
import { blueprintClaimGraph } from "../blueprint/view.mjs";
import { decodeVersoTexPlate } from "../verso/codec.mjs";
import { versoExpositionWeldReport } from "../verso/view.mjs";

function readOptional(root, relativePath, options) {
  const source = path.join(root, relativePath);
  if (!options.pathExists(source)) return undefined;
  return options.readFileUtf8(source);
}

function readFirstExisting(root, relativePaths, options) {
  for (const relativePath of relativePaths) {
    const text = readOptional(root, relativePath, options);
    if (text !== undefined) return Object.freeze({ path: relativePath, text });
  }
  return undefined;
}

/** Read a workspace's `lakefile.toml`, if present. `readLeanWorkspaceTopic`'s
 *  bounded/filtered read cannot reuse `readLeanWorkspaceCore`'s own internal
 *  lakefile read, so it keeps this tiny host read locally; the Lake TOML
 *  decoding itself stays the package's `decodeLeanLakefileToml`. */
function lakefileFromRoot(root, options) {
  const lakefileToml = readFirstExisting(root, ["lakefile.toml"], options);
  if (lakefileToml !== undefined) return decodeLeanLakefileToml(lakefileToml.text);
  return undefined;
}

function textMentionsTerm(text, terms) {
  const lowered = text.toLocaleLowerCase();
  return terms.some((term) => lowered.includes(term.toLocaleLowerCase()));
}

function topicSearchTerms(terms, aliases) {
  const expanded = terms.flatMap((term) => {
    const aliasTerms = aliases?.[term] ?? [];
    return [term, ...aliasTerms];
  });
  return [...new Set(expanded.map((term) => term.trim()).filter((term) => term !== ""))].sort();
}

function topicReferences(
  root,
  file,
  text,
  terms,
  maxReferencesPerFile,
) {
  const out = [];
  const relative = path.relative(root, file).replace(/\\/gu, "/");
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lowered = line.toLocaleLowerCase();
    for (const term of terms) {
      if (!lowered.includes(term.toLocaleLowerCase())) continue;
      out.push(Object.freeze({
        path: relative,
        line: index + 1,
        term,
        snippet: line.trim().slice(0, 240),
      }));
      if (out.length >= maxReferencesPerFile) return Object.freeze(out);
    }
  }
  return Object.freeze(out);
}

/** Read a bounded Lean project slice around selected terms, modules, and documents. */
export function readLeanWorkspaceTopic(root, options) {
  const absoluteRoot = path.resolve(root);
  const terms = [...new Set(options.terms.map((term) => term.trim()).filter((term) => term !== ""))].sort();
  if (terms.length === 0) throw new TypeError("readLeanWorkspaceTopic: at least one term is required");
  const searchTerms = topicSearchTerms(terms, options.aliases);
  const maxReferencesPerFile = options.maxReferencesPerFile ?? 12;
  const lakefile = lakefileFromRoot(absoluteRoot, options);
  const rootModule = options.rootModule ?? leanWorkspaceRootModuleFromLakefile(lakefile, path.basename(absoluteRoot));
  const moduleSources = collectLeanSources(absoluteRoot, lakefile, options)
    .filter((source) => textMentionsTerm(`${source.module}\n${source.text}`, searchTerms));
  const modules = Object.freeze(moduleSources.map((source) => decodeLeanModule(source.text, source.module, source.path)));
  const referenceFiles = sourceReferenceFiles(absoluteRoot, {
    ...options,
    referenceRoots: options.referenceRoots ?? Object.freeze(["docs/blueprint", "docs/verso", "dev/content/notes"]),
    referenceExtensions: options.referenceExtensions ?? Object.freeze([".lean", ".tex", ".md"]),
  });
  const matchingReferenceFiles = referenceFiles.flatMap((file) => {
    const text = options.readFileUtf8(file);
    return textMentionsTerm(text, searchTerms) ? [Object.freeze({ file, text })] : [];
  });
  const references = Object.freeze(matchingReferenceFiles.flatMap(({ file, text }) =>
    topicReferences(absoluteRoot, file, text, searchTerms, maxReferencesPerFile)));
  const blueprintPlates = matchingReferenceFiles
    .filter(({ file }) => path.relative(absoluteRoot, file).replace(/\\/gu, "/").startsWith("docs/blueprint/"))
    .map(({ file, text }) => decodeBlueprintTexPlate(text, path.relative(absoluteRoot, file).replace(/\\/gu, "/")));
  const versoPlates = matchingReferenceFiles
    .filter(({ file }) => path.relative(absoluteRoot, file).replace(/\\/gu, "/").startsWith("docs/verso/"))
    .map(({ file, text }) => decodeVersoTexPlate(text, path.relative(absoluteRoot, file).replace(/\\/gu, "/")));
  const declarationCatalog = leanDeclarationCatalog(modules);
  const blueprint = blueprintPlates.length === 0 ? undefined : blueprintClaimGraph(blueprintPlates);
  const verso = versoPlates.length === 0 ? undefined : versoExpositionWeldReport(versoPlates, {
    leanDeclarations: declarationCatalog,
    ...(blueprint === undefined ? {} : { blueprint }),
  });
  return leanWorkspaceTopicReadContract.assert(Object.freeze({
    kind: "metroplat.lean.workspace-topic-read",
    root: absoluteRoot,
    rootModule,
    terms,
    searchTerms,
    moduleSources,
    modules,
    references,
    ...(blueprint === undefined ? {} : { blueprintClaimGraph: blueprint }),
    ...(verso === undefined ? {} : { versoExpositionWeldReport: verso }),
    evidence: Object.freeze([
      `lean-modules:${modules.length}`,
      `references:${references.length}`,
      `blueprint-plates:${blueprintPlates.length}`,
      `verso-plates:${versoPlates.length}`,
    ]),
    mediaType: "application/vnd.metroplat.lean.workspace-topic-read+json",
  }), "Lean workspace topic read");
}
