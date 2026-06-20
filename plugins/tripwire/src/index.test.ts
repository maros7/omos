import { describe, expect, test } from "bun:test"
import { evaluate, newState, TripwirePlugin, type SessionState } from "./index"
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

  test("the rendered abort message names BOTH breached metrics, joined by comma", () => {
    // This is the regression guard: previously only "cost" would appear.
    const cfg = cfgWith({
      cost: { hard: 10 },
      steps: { hard: 100 },
    })
    const s = stateWith({ cost: 15, steps: 130 })
    const { hard } = evaluate(cfg, s)
    // Mirror hardMessage() inline so we don't need to export it; the contract
    // under test is that all names are interpolatable into the message.
    const names = hard.map((h) => h.metric).join(", ")
    const rendered = cfg.messages.hard
      .replace("{metric}", names)
      .replace("{value}", String(hard[0].v))
      .replace("{limit}", String(hard[0].limit))
    expect(rendered).toContain("cost, steps")
    expect(rendered).toContain("HARD")
  })

  test("three hard breaches are all reported", () => {
    const cfg = cfgWith({
      cost: { hard: 10 },
      steps: { hard: 100 },
      edits: { hard: 40 },
    })
    const s = stateWith({ cost: 11, steps: 101, edits: 41 })
    const { hard } = evaluate(cfg, s)
    expect(hard.map((h) => h.metric)).toEqual(["cost", "steps", "edits"])
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

describe("TripwirePlugin session eviction", () => {
  /**
   * Drives the plugin via its returned `event` hook with a mock client, and
   * asserts that a `session.deleted` event evicts the session's accumulated
   * state. We observe eviction indirectly: after eviction, re-crossing the
   * hard limit triggers a SECOND abort (because s.aborted was reset).
   */
  test("session.deleted evicts session state (abort fires again after re-crossing)", async () => {
    const aborted: string[] = []
    const client = {
      session: {
        abort: async (req: { path: { id: string } }) => {
          aborted.push(req.path.id)
        },
      },
    }
    const hooks = (await TripwirePlugin(
      { client: client as any, directory: "/tmp/tripwire-test-nonexistent" } as any,
      { budgets: { cost: { hard: 10 } }, onHard: "abort", log: { enabled: false } },
    )) as any

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
    const client = { session: { abort: async (req: { path: { id: string } }) => aborted.push(req.path.id) } }
    const hooks = (await TripwirePlugin(
      { client: client as any, directory: "/tmp/tripwire-test-nonexistent" } as any,
      { budgets: { cost: { hard: 10 } }, onHard: "abort", log: { enabled: false } },
    )) as any

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
    const client = { session: { abort: async (req: { path: { id: string } }) => aborted.push(req.path.id) } }
    const hooks = (await TripwirePlugin(
      { client: client as any, directory: "/tmp/tripwire-test-nonexistent" } as any,
      { budgets: { cost: { hard: 10 } }, onHard: "abort", log: { enabled: false } },
    )) as any

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
