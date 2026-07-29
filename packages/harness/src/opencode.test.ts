import { expect, it, vi } from "vitest"

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

it("posts content-free usage to the normalized Lumen logs endpoint", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(undefined, { status: 204 }))
  try {
    const plugin = await LumenSync({
      environment: { LUMEN_COLLECTOR_OTLP_ENDPOINT: "https://collector.lumen.build///" },
    })
    await plugin.event?.({
      event: {
        properties: {
          info: {
            id: "network-message",
            modelID: "model-mocked",
            prompt: "must not be exported",
            providerID: "provider-mocked",
            response: "also must not be exported",
            role: "assistant",
            text: "nor this content",
            time: { completed: Date.parse("2026-07-29T12:00:00.000Z") },
            tokens: { input: 10, output: 4 },
          },
        },
        type: "message.updated",
      },
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(
      "https://collector.lumen.build/v1/logs",
      expect.objectContaining({
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    )
    const body = fetchMock.mock.calls[0]?.[1]?.body
    expect(typeof body).toBe("string")
    expect(body).toContain("network-message")
    expect(body).not.toContain("must not be exported")
    expect(body).not.toContain("also must not be exported")
    expect(body).not.toContain("nor this content")
  } finally {
    fetchMock.mockRestore()
  }
})

it("rejects when the Lumen logs endpoint returns a non-success response", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(undefined, { status: 503 }))
    .mockResolvedValueOnce(new Response(undefined, { status: 204 }))
  try {
    const plugin = await LumenSync({
      environment: { LUMEN_COLLECTOR_OTLP_ENDPOINT: "https://collector.lumen.build" },
    })
    const event = {
      properties: {
        info: {
          id: "rejected-message",
          role: "assistant",
          tokens: { input: 1, output: 1 },
        },
      },
      type: "message.updated",
    }
    await expect(plugin.event?.({ event })).rejects.toThrow(
      "Lumen Sync collector rejected OpenCode usage (503)",
    )
    await expect(plugin.event?.({ event })).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[1]?.body).toContain("rejected-message")
  } finally {
    fetchMock.mockRestore()
  }
})

it("retains step model identity when retrying a failed export", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValueOnce(new Error("mocked network failure"))
    .mockResolvedValueOnce(new Response(undefined, { status: 204 }))
  try {
    const plugin = await LumenSync({
      environment: { LUMEN_COLLECTOR_OTLP_ENDPOINT: "https://collector.lumen.build" },
    })
    await plugin.event?.({
      event: {
        properties: {
          assistantMessageID: "retry-step",
          model: { modelID: "retry-model", providerID: "retry-provider" },
        },
        type: "session.next.step.started",
      },
    })
    const event = {
      properties: {
        assistantMessageID: "retry-step",
        tokens: { input: 1, output: 1 },
      },
      type: "session.next.step.ended",
    }
    await expect(plugin.event?.({ event })).rejects.toThrow("mocked network failure")
    await expect(plugin.event?.({ event })).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[1]?.body).toContain("retry-model")
    expect(fetchMock.mock.calls[1]?.[1]?.body).toContain("retry-provider")
  } finally {
    fetchMock.mockRestore()
  }
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
