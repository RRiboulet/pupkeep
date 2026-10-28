# P0-05 — Live model probes and budget

**Task:** P0-05. **Date:** 2026-10-28. **Status:** complete.

**Verdict:** `mimo-v2.6-flash` is a working cheap default; `deepseek-v4.1-flash`
is a working paid fallback; `beam-free` is a working free candidate. The free
OpenCode/OpenRouter catalog is unstable — `longcat-2.5-preview-free` and
`minimax-m3.1-flash-free` are retired, the OpenRouter `minimax` free variant is
retired, and `openrouter/free` was rate-limited. Do not build the product around
free models.

## Method

Live subagent probes, each asked to use the coding agent's `read` tool on
`docs/PLAN.md` lines 1–6 and reply `TOOL_OK <first heading>`. This proves the
model can make a real tool call, not just answer from memory. It is not the
app's exact Pi Durable tool schema; P1-03/P4-08 must repeat the probe with the
app's schema.

| Provider / model | Result | Usage / cost | Notes |
|---|---|---|---|
| `opencode-go/mimo-v2.6-flash` | **TOOL_OK** | 13k tok, ~$0.00091, 12s | default candidate |
| `opencode-go/beam-free` | **TOOL_OK** | 13k tok, $0, 7s | free candidate; not a guarantee |
| `opencode-go/deepseek-v4.1-flash` | **TOOL_OK** | 14k tok, ~$0.001112, 3s | paid fallback |
| `opencode-go/longcat-2.5-preview-free` | 410 ModelDeprecated | 0 tok | retired |
| `opencode-go/minimax-m3.1-flash-free` | 410 ModelDeprecated | 0 tok | retired (also failed the product review) |
| `openrouter/minimax/minimax-m3.1-flash:free` | 404 retired | 0 tok | paid variant `minimax/minimax-m3.1-flash` is $0.15/$0.60 |
| `openrouter/openrouter/free` | 429 rate-limited | 7.4k tok, 5 turns | free router; unreliable |

## Budget simulation

Prices from the Pi AI `1.4.0` catalog, USD per 1M tokens. `mimo-v2.6-flash` is
$0.14 input / $0.28 output.

| Usage | Runs/month | Input | Output | Estimated cost |
|---|---:|---:|---:|---:|
| Light | 360 (12/day) | 2.16M | 0.18M | **~$0.35** |
| Normal | 1,200 (40/day) | 14.4M | 0.96M | **~$2.28** |
| Heavy | 3,000 (100/day) | 60M | 3M | **~$9.24** |

The heavy row is close to the $10 cap; normal use is comfortably under it.
Cache reads and compaction lower the input cost; context growth and tool
results raise it. The monthly ledger remains authoritative via
`harness.usage()`.

## Decision

- **Default:** `opencode-go/mimo-v2.6-flash`.
- **Paid fallback:** `opencode-go/deepseek-v4.1-flash` (also `glm-5.3-flash` /
  `qwen3.8-flash` remain live-probe candidates).
- **Free candidate:** `opencode-go/beam-free`; never rely on it for the core
  loop.
- **Retired:** `longcat-2.5-preview-free`, `minimax-m3.1-flash-free`,
  `minimax/minimax-m3.1-flash:free`.
- **Unreliable:** `openrouter/free` (429 in the probe).
- The allowlist is built by a live tool-call probe at startup; 401/404/410 and
  rate-limited models are dropped from the picker. The catalog snapshot is not
  a promise.
- Do not use the initial `minimax` product-review run as a model availability
  signal; it failed with 410 before doing any work.

## Caveats

- The probe used a coding agent tool, not the app's TypeScript/TypeBox tool
  schema. P1-03/P4-08 must run the same probe with the real schema.
- A single probe at one time does not prove a model is always available. The
  startup probe and user-visible error are the mitigation.
- Free-model data policies and rate limits may differ; the owner chooses.
