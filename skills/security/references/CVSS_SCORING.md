# CVSS-Anchored Scoring

Maps the `/security-review` engine's severity (HIGH/MEDIUM/LOW) to **CVSS v3.1 base score bands** and skua's P0/P1/P2 tiers, so findings are comparable across runs. Full spec: https://www.first.org/cvss/v3-1/specification-document

## Score bands

| Tier | CVSS band | Meaning | Typical action window |
|---|---|---|---|
| **P0** | 7.0–10.0 (High / Critical) | Actively exploitable; immediate risk | within days |
| **P1** | 4.0–6.9 (Medium) | Exploitable under conditions; latent risk | within weeks |
| **P2** | 0.1–3.9 (Low / Info) | Best-practice / defense-in-depth | next sprint or queue |

These bands are the official CVSS v3.1 qualitative ratings (excluding "None" = 0.0). The skill uses them to:

1. Map the engine's HIGH/MEDIUM/LOW severity onto skua's P0/P1/P2 tiers (HIGH→P0, MEDIUM→P1, LOW→P2).
2. Stamp a `severity` field on every emitted finding for consistency across runs.
3. Order the merged report (P0 → P1 → P2).

## Stamping rules

For every finding from the engine:

1. Map the engine's HIGH/MEDIUM/LOW to the P0/P1/P2 band and stamp it as `severity`.
2. If the engine supplied a `cvss` vector: map its base score to the band and prefer that as the canonical `severity`.
3. If no CVSS vector (the common case): use the mapped band from step 1.
4. NEVER fabricate a CVSS vector. Leave the `cvss` field blank if the engine didn't supply one.

## Severity reconciliation (post-dedup)

When two findings merge into one entry (same CWE + resource), they may carry different severities. Take the higher one, and emit an informational note: "severity mismatch on `<finding-id>`: HIGH vs MEDIUM — using P0". The mismatch is itself useful signal; surface it.

## CVSS vector reference (for future enrichment)

When the engine emits a CVSS vector directly, the skill can use it to build the base score:

Format: `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`

- **AV** (Attack Vector): N=Network, A=Adjacent, L=Local, P=Physical
- **AC** (Attack Complexity): L=Low, H=High
- **PR** (Privileges Required): N=None, L=Low, H=High
- **UI** (User Interaction): N=None, R=Required
- **S** (Scope): U=Unchanged, C=Changed
- **C/I/A** (Confidentiality/Integrity/Availability): N=None, L=Low, H=High

Worked example — a privilege escalation where any authenticated user can write a trust-bearing field (e.g. an entitlement flag) to their own record, bypassing a server-side check:
- Vector: `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H` → base score 8.8 (High → **P0**)
- Justification: network-attackable, low complexity (any authed user can self-elevate), low privs required (must be authed), no user interaction, unchanged scope, all CIA impacts high (gated capabilities become freely accessible)

Calculator: https://www.first.org/cvss/calculator/3.1

## What this file does NOT do

- Compute CVSS scores. The engine supplies them or the skill leaves the field blank.
- Override the engine's severity without justification. The mismatch surfaces; the user decides.
- Score findings outside the host repo's threat model (the calibration is tuned to the repo, not a generic enterprise baseline).
