# 0001. Record architecture decisions

- Status: Accepted
- Date: 2026-10-21

## Context

eNCode starts from the Forge prototype and grows into a product built by several parallel
workstreams (core, router, parity and safety, IDE surfaces, gateway, UI). Decisions about
security boundaries and package seams are easy to lose in chat history and pull request
threads, and a later change that quietly reverses one can reopen a fixed vulnerability.

## Decision

Significant decisions are recorded in `docs/adr/` as numbered Markdown files using the
template in [README.md](README.md). A decision is significant when it changes a trust
boundary, a package seam, a persisted format, the approval model, or the toolchain.

A pull request that makes such a decision adds or supersedes a record in the same change.
Accepted records are not edited beyond typo fixes; a new record supersedes them and both
link to each other.

## Consequences

- Reviewers can check a change against the records it touches.
- The threat model ([docs/security/threat-model.md](../security/threat-model.md)) links
  mitigations to the record that introduced them.
- Writing a record costs a few minutes per decision.
