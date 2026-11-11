# Vendored pi-routing-policies runtime

Upstream: https://github.com/radioflyer28/pi-routing-policies

Commit: `8840fb89dd7d3f53079f2230937c55c6132ec2ef`

These unmodified JavaScript and declaration files were generated from that commit with `tsc -p tsconfig.build.json`. Only the side-effect-free core and selector runtime are included; Pi extension registration, UI, advisor, and subagent integrations are not vendored.

The upstream project is unpublished and its Git checkout does not contain build artifacts. Vendoring keeps Rexpi installs self-contained instead of requiring a post-install build. The upstream Apache 2.0 license is preserved in `LICENSE`.

Compatibility evidence: the upstream core, decision-receipt, selector-stream, classifier, and LLM tests passed against Pi 1.5.0 (37 tests) before these files were copied.
