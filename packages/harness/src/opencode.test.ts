import { expect, it } from "vitest"

import { LumenSync, makeOpenCodeUsageState, toOtlpLogs, usageFromOpenCodeEvent } from "./opencode"

it("maps usage-only OpenCode events without prompt or response content", () => {
  const state = makeOpenCodeUsageState()
  const usage = usageFromOpenCodeEvent(
    {
      properties: {
        info: {
          cost: 0.02,
          id: "message-mocked",
          modelID: "model-mocked",
          providerID: "provider-mocked",
          role: "assistant",
          text: "must not be exported",
          time: { completed: Date.parse("2026-07-29T12:00:00.000Z") },
          tokens: {
            cache: { read: 3, write: 2 },
            input: 10,
            output: 4,
            reasoning: 1,
          },
        },
      },
      type: "message.updated",
    },
    state,
  )
  const body = JSON.stringify(toOtlpLogs(usage))

  expect(body).toContain("message-mocked")
  expect(body).toContain("model-mocked")
  expect(body).not.toContain("must not be exported")
  expect(usageFromOpenCodeEvent({ properties: {}, type: "message.updated" }, state)).toEqual([])
})

it("correlates the current step-started and step-ended events", () => {
  const state = makeOpenCodeUsageState()
  usageFromOpenCodeEvent(
    {
      properties: {
        assistantMessageID: "step-mocked",
        model: { modelID: "model-mocked", providerID: "provider-mocked" },
      },
      type: "session.next.step.started",
    },
    state,
  )
  const usage = usageFromOpenCodeEvent(
    {
      properties: {
        assistantMessageID: "step-mocked",
        cost: 0.01,
        tokens: { input: 5, output: 2, reasoning: 1 },
      },
      type: "session.next.step.ended",
    },
    state,
  )

  expect(usage).toMatchObject([
    {
      id: "step-mocked",
      input: 5,
      model: "model-mocked",
      output: 2,
      provider: "provider-mocked",
    },
  ])
})

it("does not install a network hook unless an endpoint is explicit", async () => {
  await expect(LumenSync({ environment: {} })).resolves.toEqual({})
})

it("bounds incomplete and completed OpenCode event state", () => {
  const state = makeOpenCodeUsageState(2)
  for (const id of ["one", "two", "three"]) {
    usageFromOpenCodeEvent(
      {
        properties: {
          assistantMessageID: id,
          model: { modelID: "mocked", providerID: "mocked" },
        },
        type: "session.next.step.started",
      },
      state,
    )
  }
  expect([...state.pendingModels.keys()]).toEqual(["two", "three"])

  for (const id of ["one", "two", "three"]) {
    usageFromOpenCodeEvent(
      {
        properties: {
          info: {
            id,
            role: "assistant",
            tokens: { input: 1, output: 1 },
          },
        },
        type: "message.updated",
      },
      state,
    )
  }
  expect([...state.emitted]).toEqual(["two", "three"])
})
