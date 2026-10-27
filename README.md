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

## WIT accounting from the original producer

`{ "project": "/path/to/obsmetrologia-science-services-section", "mode": "wit-ledger" }`
rebuilds `Obsmetrologia` and runs `lake env lean --run scripts/WitLedger.lean`
through the same bounded worker. This executes the snapshotted original source
directly; a differently configured Lake executable target cannot impersonate it.
The project must provide its original `scripts/WitLedger.lean`, committed
`scripts/wit-ledger.txt`, Lean toolchain, and `Obsmetrologia` library target. The operation never
passes `--pay` or rewrites the committed ledger.

A successful comparison returns `witLedger.entries`, with the original producer's
`own` and `carried` values, plus its totals and SHA-256 identities for the producer,
ledger and local Lean source/configuration snapshot. Changed local inputs, missing
or repeated success records, inconsistent totals and malformed entries refuse
the result. Root agent metadata directories (`.agents`, `.claude`, `.codex`) are
outside the claimed Lean input snapshot, including their skill projection links.
Source, producer and configuration symlinks elsewhere remain refused.
Imported package bytes are outside that local snapshot and remain
the selected project's dependency responsibility. The native worker's scope,
output-completeness and deadline requirements remain in force.

The mathematical authority stays with `WitLedger.lean`: `own` counts occurrences
of its classified identification instruments in a declaration's value; `carried`
sums owned occurrences over its library dependency closure with each declaration
counted once. Reusing a declaration can carry a wit without owning a new one.
These source-relative counts do not establish a minimum proof cost, physical
mass, or the count of quotient classes merged. Entries with zero carried wits
are omitted by the original producer; an absent entry is not a declaration
existence check.

To qualify the native producer/reader composition on an isolated fixture, run
`LEAN_TEST_LAKE=/absolute/path/to/lake WIT_LEDGER_SOURCE=/absolute/path/to/scripts/WitLedger.lean node --test test/wit-ledger-native.test.mjs`.
This checks actual Lean compilation, reuse/multiplicity and unpaid ledger drift.
It does not claim the deployed `lean.slice` worker has been received.

Lean/Lake command claims through directory `write` are retired and explicitly
refused. Use `lean-check`; arbitrary command and shell-argument inputs are not
compiler actions. Workspace read and content projection remain available.

