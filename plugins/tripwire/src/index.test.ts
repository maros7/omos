import { describe, expect, test } from "bun:test"
import { evaluate, hardMessage, newState, TripwirePlugin, type SessionState } from "./index"
import { DEFAULTS, type TripwireConfig } from "./config"

/** Build a minimal config: DEFAULTS with specific budget overrides. */
function cfgWith(budgets: Partial<TripwireConfig["budgets"]>): TripwireConfig {
  return { ...DEFAULTS, budgets: { ...DEFAULTS.budgets, ...budgets } }
}

/** Session state with the given metric values (defaults to 0 for the rest). */
function stateWith(values: Partial<SessionState>): SessionState {
  return { ...newState(), ...values }
}

describe("evaluate", () => {
  test("returns no breaches when under all limits", () => {
    const cfg = cfgWith({ cost: { warn: 5, hard: 10 } })
    const s = stateWith({ cost: 3 })
    const { hard, warns } = evaluate(cfg, s)
    expect(hard).toEqual([])
    expect(warns).toEqual([])
  })

  test("returns a warn (not hard) when between warn and hard", () => {
    const cfg = cfgWith({ cost: { warn: 5, hard: 10 } })
    const s = stateWith({ cost: 7 })
    const { hard, warns } = evaluate(cfg, s)
    expect(hard).toEqual([])
    expect(warns).toHaveLength(1)
    expect(warns[0].metric).toBe("cost")
    expect(warns[0].message).toContain("cost")
    expect(warns[0].message).toContain("WARN")
  })

  test("single hard breach: message names exactly that metric (unchanged semantics)", () => {
    const cfg = cfgWith({ cost: { hard: 10 } })
    const s = stateWith({ cost: 12 })
    const { hard, warns } = evaluate(cfg, s)
    expect(hard).toHaveLength(1)
    expect(hard[0]).toEqual({ metric: "cost", v: 12, limit: 10 })
    expect(warns).toEqual([])
  })

  test("multiple hard breaches: ALL breached metrics are reported, in metrics-array order", () => {
    // Both cost and steps cross their hard limit on the same step.
    const cfg = cfgWith({
      cost: { hard: 10 },
      steps: { hard: 100 },
    })
    const s = stateWith({ cost: 15, steps: 130 })
    const { hard } = evaluate(cfg, s)
    expect(hard).toHaveLength(2)
    expect(hard.map((h) => h.metric)).toEqual(["cost", "steps"])
    expect(hard[0]).toEqual({ metric: "cost", v: 15, limit: 10 })
    expect(hard[1]).toEqual({ metric: "steps", v: 130, limit: 100 })
  })

  test("single-breach hardMessage is the verbatim template (regression guard)", () => {
    const cfg = cfgWith({ cost: { hard: 10 } })
    const s = stateWith({ cost: 12 })
    const { hard } = evaluate(cfg, s)
    // EXACT verbatim rendering of cfg.messages.hard for one breach — must not drift.
    expect(hardMessage(cfg, hard)).toBe(
      "TRIPWIRE HARD: cost hit 12 (limit 10). Stop now — split the session or delegate the remaining work.",
    )
  })

  test("multi-breach hardMessage renders EACH metric's OWN value/limit (not the first's)", () => {
    // Two breaches with DIFFERENT value/limit pairs so any misattribution shows up.
    // (cost 15/10 vs steps 130/100 — the numbers are deliberately distinct.)
    const cfg = cfgWith({
      cost: { hard: 10 },
      steps: { hard: 100 },
    })
    const s = stateWith({ cost: 15, steps: 130 })
    const { hard } = evaluate(cfg, s)
    expect(hard.map((h) => h.metric)).toEqual(["cost", "steps"])
    const msg = hardMessage(cfg, hard)
    // Each metric carries its OWN value and limit.
    expect(msg).toContain("cost at $15/$10")
    expect(msg).toContain("steps at 130/100")
    expect(msg).toContain("HARD")
    expect(msg).toContain("Stop now")
    // Regression guards: the OLD code rendered "cost, steps hit 15 (limit 10)",
    // attributing the first breach's numbers to every named metric. None of
    // those misattributions may appear.
    expect(msg).not.toContain("hit 15 (limit 10)")
    expect(msg).not.toContain("steps at $15")
    expect(msg).not.toContain("cost at 130")
  })

  test("three hard breaches are all reported, each with its own value/limit", () => {
    const cfg = cfgWith({
      cost: { hard: 10 },
      steps: { hard: 100 },
      edits: { hard: 40 },
    })
    const s = stateWith({ cost: 11, steps: 101, edits: 41 })
    const { hard } = evaluate(cfg, s)
    expect(hard.map((h) => h.metric)).toEqual(["cost", "steps", "edits"])
    const msg = hardMessage(cfg, hard)
    expect(msg).toContain("cost at $11/$10")
    expect(msg).toContain("steps at 101/100")
    expect(msg).toContain("edits at 41/40")
  })

  test("reads metric uses maxReads, not the reads Map size", () => {
    const cfg = cfgWith({ reads: { hard: 5 } })
    const s = stateWith({ maxReads: 6, reads: new Map([["a", 6], ["b", 1]]) })
    const { hard } = evaluate(cfg, s)
    expect(hard).toHaveLength(1)
    expect(hard[0].metric).toBe("reads")
    expect(hard[0].v).toBe(6)
  })
})

/**
 * Test-only view of the plugin's Hooks return: we only drive `event`, and we
 * widen its argument type so tests can synthesize the custom
 * `session.next.step.ended` event the SDK does not (yet) type. The runtime
 * shape is identical; this is purely a static-type widening for test ergonomics.
 */
type TestHooks = {
  event: (input: {
    event: {
      type?: string
      properties?: {
        sessionID?: string
        info?: { id?: string }
        cost?: number
        file?: string
      }
    }
  }) => Promise<void>
}

/**
 * Minimal client shape TripwirePlugin actually touches in tests: just
 * `session.abort`. Building it under this alias lets us pass it to
 * TripwirePlugin without an `as any` on the full PluginInput.
 */
type TestClient = { session: { abort: (req: { path: { id: string } }) => Promise<void> } }

/**
 * Build the plugin and return its hooks as a TestHooks view. The single
 * eslint-disable below narrows the SDK's Hooks (which types `event` against
 * the closed Event union) to our test-only TestHooks shape — without it, the
 * custom `session.next.step.ended` test events would not typecheck.
 */
async function buildPlugin(client: TestClient): Promise<TestHooks> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test-only narrowing of Hooks to TestHooks (widened event-arg type); the runtime hooks object satisfies TestHooks structurally, but the SDK's Hooks types event against the closed Event union which can't describe our custom test events.
  return (await TripwirePlugin(
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test-only partial PluginInput (the plugin only reads `client` and `directory` at runtime; PluginInput has many more fields the orchestrator populates in production). `as never` was too aggressive; `unknown` bridge with the real param type tracks the signature.
    { client, directory: "/tmp/tripwire-test-nonexistent" } as unknown as Parameters<typeof TripwirePlugin>[0],
    { budgets: { cost: { hard: 10 } }, onHard: "abort", log: { enabled: false } },
  )) as TestHooks
}

describe("TripwirePlugin session eviction", () => {
  /**
   * Drives the plugin via its returned `event` hook with a mock client, and
   * asserts that a `session.deleted` event evicts the session's accumulated
   * state. We observe eviction indirectly: after eviction, re-crossing the
   * hard limit triggers a SECOND abort (because s.aborted was reset).
   */
  test("session.deleted evicts session state (abort fires again after re-crossing)", async () => {
    const aborted: string[] = []
    const hooks = await buildPlugin({
      session: {
        abort: (req) => {
          aborted.push(req.path.id)
          return Promise.resolve()
        },
      },
    })

    // 1. Push cost past the hard limit -> first abort.
    await hooks.event({
      event: { type: "session.next.step.ended", properties: { sessionID: "s1", cost: 15 } },
    })
    expect(aborted).toEqual(["s1"])

    // 2. A second step does NOT re-abort (s.aborted latch is set).
    await hooks.event({
      event: { type: "session.next.step.ended", properties: { sessionID: "s1", cost: 1 } },
    })
    expect(aborted).toEqual(["s1"])

    // 3. Emit session.deleted — should evict s1's state.
    await hooks.event({
      event: {
        type: "session.deleted",
        properties: { sessionID: "s1", info: { id: "s1" } },
      },
    })

    // 4. A new step past the hard limit MUST abort again — proves state was reset.
    await hooks.event({
      event: { type: "session.next.step.ended", properties: { sessionID: "s1", cost: 15 } },
    })
    expect(aborted).toEqual(["s1", "s1"])
  })

  test("session.deleted accepts the v1 shape (info.id only)", async () => {
    const aborted: string[] = []
    const hooks = await buildPlugin({
      session: {
        abort: (req) => {
          aborted.push(req.path.id)
          return Promise.resolve()
        },
      },
    })

    await hooks.event({
      event: { type: "session.next.step.ended", properties: { sessionID: "s2", cost: 15 } },
    })
    expect(aborted).toEqual(["s2"])

    // v1 SDK shape: no top-level sessionID, id lives under info.
    await hooks.event({
      event: { type: "session.deleted", properties: { info: { id: "s2" } } },
    })

    await hooks.event({
      event: { type: "session.next.step.ended", properties: { sessionID: "s2", cost: 15 } },
    })
    expect(aborted).toEqual(["s2", "s2"])
  })

  test("unrelated events do not trigger eviction or abort", async () => {
    const aborted: string[] = []
    const hooks = await buildPlugin({
      session: {
        abort: (req) => {
          aborted.push(req.path.id)
          return Promise.resolve()
        },
      },
    })

    await hooks.event({
      event: { type: "session.next.step.ended", properties: { sessionID: "s3", cost: 15 } },
    })
    expect(aborted).toEqual(["s3"])

    // An unrelated event type must not evict.
    await hooks.event({ event: { type: "file.edited", properties: { file: "/x" } } })

    await hooks.event({
      event: { type: "session.next.step.ended", properties: { sessionID: "s3", cost: 1 } },
    })
    // Still only one abort — s3 was NOT evicted, so the latch held.
    expect(aborted).toEqual(["s3"])
  })
})
