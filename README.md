# Lean system services section

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Native JavaScript ESM tools for reading Lean source and workspaces, Lake metadata,
declaration catalogs, Blueprint claim graphs, and Verso exposition links, and
for rendering Lean metaprograms. Proof projects and mathematical applications
live with their subjects; this section owns the proof-assistant integration.

Generic TeX parsing is imported from
`@red-cup-engineering/tex-engineering-services-section`. Mathematical graph
readings are imported from `@lenticule-science/metrologic`.

Run `npm test` to exercise workspace reading, Blueprint linting, and generated
Lean source. Runtime exports load from `src/` without a compilation step.

Lean reference notes remain under `content/`.

## Memory ceiling on this machine

`deploy/lean.slice` puts every Lean and Lake process under one ceiling (4 GB soft, 5 GB hard, no swap), so a build is killed inside its own scope instead of taking the machine and every session on it (2026-09-27). `deploy/lean` and `deploy/lake` replace elan's proxies in `~/.elan/bin` (symlinks) and run the real tool in that slice with `LEAN_NUM_THREADS=4`; the unit is linked into `~/.config/systemd/user/`. `elan self update` restores the plain proxies, so re-link after updating.

MetroPlat composes this section's `lean-check` operation. All Lean execution uses
one bounded runner: one active run per node, an atomic runtime lock, a wall-clock
limit, and the deployed Lake wrapper in a named scope below `lean.slice`.
Completion and timeout both kill/check the whole scope before returning.
A successful compiler exit is necessary but not sufficient: incomplete stdout/stderr,
a scope retaining processes, source changes, or compiler diagnostics all **refuse**
success. Declaration inspection is withheld unless that final admission passes.
A locally present declaration module source is SHA-256 fingerprinted and
rechecked; modules imported only from dependencies are not falsely reported
as locally fingerprinted.
Request and result records are appended to the `lean-checks` journal feed.

Pass a named Lake `project` and optional `timeoutMs` with one typed action:

- `mode: "build"` (default), optionally `targets: ["Module.Name"]`: a targeted or
  whole-project Lake build.
- `mode: "file", file: "Module/Name.lean"`: check an edited source inside the
  project. The result retains its SHA-256 and refuses success if the source
  changed during checking. Escaping paths and symlinks are refused.
- `mode: "declaration", module: "Module.Name", declaration: "Namespace.name"`:
  rebuild and import that module in the same bounded job, then ask Lean for the declaration's actual axioms and
  direct constant dependencies. The generated query and raw compiler output
  remain in the receipt; no inference model estimates these properties.

Declaration inspection rebuilds its module before reading the compiled environment;
a failed build never yields an inspection of an older compiled proof. Inspection reports compiler
facts; it does not accept a proof or waive the scientific Axiom Law, work-order,
or spine-lineage receiving conditions. Whole-library census and law instruments
remain in `obsmetrologia-theorem-audit-service`.

Lean/Lake command claims through directory `write` are retired and explicitly
refused. Use `lean-check`; arbitrary command and shell-argument inputs are not
compiler actions. Workspace read and content projection remain available.

## External proof-target preflight (branch candidate)

For an external proof challenge, the existing **declaration** check may carry an
optional `proofTarget`. This is a caller-attributed source snapshot, not a new
bounty registry or an assertion that the publisher approved the task:

- `platform`: exact https task URL; `targetId`: publisher's task identifier;
  `taskDigest`: SHA-256 of the externally acquired task record. The publisher,
  the task digest's acquisition and the caller's authority are **not**
  authenticated by this service.
- `challenge: {path, digest}`: in-project relative POSIX `.lean` source path
  and SHA-256 of its exact bytes; `toolchain`: exact text of the pinned
  `lean-toolchain`; `manifestDigest`: SHA-256 of `lake-manifest.json`.
- `sourceDigest`: SHA-256 content fingerprint of the producer-selected local Lean
  source tree and proof configuration, obtained from the public
  `./check/proof-target` export's `snapshotLeanSources(projectRoot)`.
  Its deterministic digest covers in-project `.lean` files, pinned Lean/Lake
  configuration, Comparator JSON, and formalization metadata; it is mandatory
  for external proof preflight. The checker recomputes it on both sides of
  execution and refuses a mismatched or changing source revision. This is a
  bounded local-source fingerprint, **not** an immutable Git commit or proof
  that externally imported Lean packages, caches, or generated code are fixed.
- `permittedAxioms`: a caller-supplied list of permitted transitive kernel
  axiom names, independently populated from the particular venue's current rules.
  `sorryAx` is never permissible. This is intentionally **not** the
  Obsmetrologia-specific Axiom Law, which remains with Proof Work Orders.

The input schema allows this option only on `mode: "declaration"` checks.
Before a Lean run, the existing bounded worker refuses missing, changed, unpinned or
escaping challenge/toolchain/manifest files; after the run it checks the exact
bytes again and compares Lean's actual `collectAxioms` report with the declared
policy. A mismatch refuses success and withholds the admitted declaration
inspection. The result's `proofTarget.status` is `preflight-passed` or
`refused`, with exact findings and a list of unverified obligations.

**Not established by preflight:** the claimed bounty's authenticity, full
workspace/import immutability, challenge/solution equivalence under the venue's
Comparator, forbidden-import or transitive dependency rules, mathematical
novelty, third-party acceptance, submission rights, or actual payment. A real
delivery therefore still requires the publisher's independent checker, human
review where applicable, and the original Opportunity Services commercial
receiving. Source tests are not proof that a MetroPlat host has installed and
executed this branch. Existing Science Proof Work Orders and Blueprint/Verso
receipts are preserved; no duplicate proof workflow is created.

Original receivers: [Proof Science #2](https://github.com/lenticule-science/proof-science-services-section/issues/2),
[Lean service qualification #14](https://github.com/red-cup-engineering/computer-code-engineering-services-section/issues/14),
[Opportunity Work #35](https://github.com/561-group/561-group-opportunity-services-section/issues/35),
and [Obsmetrologia CI incident #84](https://github.com/lenticule-science/obsmetrologia-science-services-section/issues/84).

## Exact external acceptance remains downstream

**Conjectures.io**, under its published [submission bundle contract](https://github.com/conjectures-io/conjectures-validator/blob/main/docs/SUBMISSION_BUNDLE.md), accepts a bounded two-entry ZIP (`submission.json`, `Main.lean`); the manifest binds a **task-bundle** digest, exact proof bytes, task ID, and the authenticated identity profile. Its official `python3 -m verifier bundle scan` and `bundle verify` stages, with the task's pinned environment and policy, are required before any authorized paid attempt. A normal declaration-mode Lean check is **not** that upstream verification. Original AI conversation records, eligibility and reward review are separate obligations in [published submission terms](https://github.com/conjectures-io/conjectures-validator/blob/main/docs/SUBMISSION_TERMS.md). Do not regenerate chat logs or package them into the two-entry ZIP.

**Palomar**, under its [current submission standard](https://github.com/PalomarRegistry/PalomarPolicy/blob/main/CONTRIBUTING.md), requires a fully pinned public Git commit, formalization.yaml, Challenge/Solution and Comparator configuration. The actual Comparator statement match, replay by Lean and a separately implemented kernel, strict Challenge dependency policy, and independent review remain unverified by this local preflight. The existing Obsmetrologia Blueprint/Verso work and axiom law remain authoritative for subject mathematics; do not silently treat an external venue's axiom allowlist as equivalent to the internal law.

The engineering handoff from proof-producing Science to the original Opportunity Work therefore preserves: *exact problem and task commitment → authoritative mathematical claim and source genealogy → source-pinned proof candidate → local compiler/axiom evidence → actual venue-specific independent verifier result → permitted submission/review → separately observed payout*. A `preflight-passed` result establishes only the bounded part of that chain.

## Proof construction and locally verified bounty candidates

The existing `lean-prove` MetroPlat project operation now has two *proof-producing*
paths, not another theorem registry. For internal mathematics it accepts one
exact `declaration` in a source-owned `.lean` file with one provisional
`by sorry` hole, plus existing Blueprint predecessor lemmas and optional
authorized `proofs/*.tactic` argument files. It **first compiler-inspects the
original declaration** to confirm the selected theorem really depends on that
hole, then tries source-authored derivations and native Lean tactics. The
original statement is never edited; a valid result is saved privately under
`.lake/proof-candidates/`. Incomplete searches retain real goal diagnostics
in `.lake/proof-runs/` and may resume by `resumeFrom`. The common Work journal
holds digests and status, not unpublished arguments.

For a **Conjectures.io** task, operators supply two *separately installed*
source checkouts (neither contains a credential, wallet nor signing key):

- `CONJECTURES_TASKS_ROOT`: the original versioned task repository containing
  `versions/<task-id>/`, `allowlist.json`, and `task-versions.json`;
- `CONJECTURES_VALIDATOR_ROOT`: the publisher's real local verifier, with
  its own already-pinned Lean, Mathlib, Comparator, kernel, production sandbox,
  and task build cache.

Pass the existing `lean-prove` operation `project`, relative
`taskDirectory` (`versions/<task-id>`), and an authorized computation budget.
Optionally provide source-owned `proposalFiles` as actual complete candidate
derivations. The task loader admits the **publisher's** active registry version,
uses its `task_bundle_sha256` (not our manifest hash) and the matching
`build_provenance_sha256`, and retains the exact Challenge plus trusted
SolutionHeader/Footer.

Rather than compiling a purported solution under whichever local Lake project
is convenient, this path invokes the *official* command, without signing or
payment:

```text
python3 -m verifier verify --task <original-task-dir> \
  --submission <private-generated-Main.lean> \
  --expected-task-sha256 <publisher-task-bundle-sha256> \
  --expected-build-provenance <published-build-provenance-sha256>
```

Each candidate runs under the original shared Lean worker admission lock and
an explicit overall time budget. The publisher's verifier independently checks
the exact statement, source dependencies, permitted axioms, Comparator and Lean
kernel inside its production sandbox. **Only** a complete official local report
with `accepted: true`, `reason_code: VERIFIED`, the exact task commitment,
`checks.same_statement`, `checks.axioms_permitted`,
`checks.lean_kernel_passed`, and `checks.production_sandbox` true
can produce `venue-verified-locally`. Toolchain mismatch, missing verifier,
unavailable sandbox, or broken imports yield `blocked`, not an invented
mathematical refutation. An unsuccessful proof produces only an honest
`unresolved` result with its real compiler feedback.

The complete `Main.lean`, source-authored proof lineage and official verifier
report are retained under the operator-owned `.lake/` project paths, never
published in the shared proof-attempt journal. An authorized consumer can
retrieve these artifacts and use the **original Conjectures miner** to build
its exact two-entry submission bundle, only once it has independent account,
AI-chat-log, payment and disclosure authorization. **Local verification does
not spend a credit, submit a bounty, prove novelty, secure eligibility, pass
human review or establish settlement.** The live validator can still reject
or be closed to a locally listed task. Production installation/receiving
remains unverified until an actual Coesite-hosted worker performs this call.

The mathematically sound way to forget distinct proof histories is separately
researched in [ProofSearchQuotient Science PR #19](https://github.com/lenticule-science/computer-science-obsmetrology-science-services-section/pull/19);
that draft is not a checked theorem until an independent Lean host executes it.
[SignCraft's source-replayed quotient audit](https://github.com/red-cup-engineering/signcraft/pull/17)
is likewise not a substitute for a full external statement proof.
