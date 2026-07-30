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

it("waits for the completed OpenCode message before deduplicating its usage", () => {
  const state = makeOpenCodeUsageState()
  const incomplete = {
    properties: {
      info: {
        id: "message-progressive",
        modelID: "model-mocked",
        providerID: "provider-mocked",
        role: "assistant",
        time: { created: Date.parse("2026-07-29T12:00:00.000Z") },
        tokens: { input: 0, output: 0 },
      },
    },
    type: "message.updated",
  }
  const completed = {
    properties: {
      info: {
        ...incomplete.properties.info,
        time: {
          completed: Date.parse("2026-07-29T12:00:01.000Z"),
          created: Date.parse("2026-07-29T12:00:00.000Z"),
        },
        tokens: { input: 31, output: 13 },
      },
    },
    type: "message.updated",
  }

  expect(usageFromOpenCodeEvent(incomplete, state)).toEqual([])
  expect(usageFromOpenCodeEvent(completed, state)).toMatchObject([
    {
      id: "message-progressive",
      input: 31,
      output: 13,
    },
  ])
  expect(usageFromOpenCodeEvent(completed, state)).toEqual([])
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
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(undefined, { status: 204 }))
  const plugin = await LumenSync({
    environment: {
      LUMEN_COLLECTOR_OTLP_ENDPOINT: "https://collector.lumen.build///",
    },
    fetch: fetchMock,
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
  const [url, init] = fetchMock.mock.calls[0]!
  expect(String(url)).toBe("https://collector.lumen.build/v1/logs")
  expect(init?.method).toBe("POST")
  expect(new Headers(init?.headers).get("content-type")).toBe("application/json")
  const body = init?.body
  const bodyText = typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array)
  expect(bodyText).toContain("network-message")
  expect(bodyText).not.toContain("must not be exported")
  expect(bodyText).not.toContain("also must not be exported")
  expect(bodyText).not.toContain("nor this content")
})

it("rejects when the Lumen logs endpoint returns a non-success response", async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(undefined, { status: 503 }))
    .mockResolvedValueOnce(new Response(undefined, { status: 204 }))
  const plugin = await LumenSync({
    environment: {
      LUMEN_COLLECTOR_OTLP_ENDPOINT: "https://collector.lumen.build",
    },
    fetch: fetchMock,
  })
  const event = {
    properties: {
      info: {
        id: "rejected-message",
        role: "assistant",
        time: { completed: Date.parse("2026-07-29T12:00:00.000Z") },
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
  expect(new TextDecoder().decode(fetchMock.mock.calls[1]?.[1]?.body as Uint8Array)).toContain(
    "rejected-message",
  )
})

it("retains step model identity when retrying a failed export", async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("mocked network failure"))
    .mockResolvedValueOnce(new Response(undefined, { status: 204 }))
  const plugin = await LumenSync({
    environment: {
      LUMEN_COLLECTOR_OTLP_ENDPOINT: "https://collector.lumen.build",
    },
    fetch: fetchMock,
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
  const retriedBody = new TextDecoder().decode(fetchMock.mock.calls[1]?.[1]?.body as Uint8Array)
  expect(retriedBody).toContain("retry-model")
  expect(retriedBody).toContain("retry-provider")
})

it("bounds a stalled collector export and releases the event for retry", async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(() => new Promise<Response>(() => undefined))
    .mockResolvedValueOnce(new Response(undefined, { status: 204 }))
  const plugin = await LumenSync({
    environment: {
      LUMEN_COLLECTOR_OTLP_ENDPOINT: "https://collector.lumen.build",
    },
    fetch: fetchMock,
    timeoutMillis: 10,
  })
  const event = {
    properties: {
      info: {
        id: "stalled-message",
        role: "assistant",
        time: { completed: Date.parse("2026-07-29T12:00:00.000Z") },
        tokens: { input: 8, output: 3 },
      },
    },
    type: "message.updated",
  }

  await expect(plugin.event?.({ event })).rejects.toThrow(
    "Lumen Sync collector timed out after 10ms",
  )
  await expect(plugin.event?.({ event })).resolves.toBeUndefined()
  expect(fetchMock).toHaveBeenCalledTimes(2)
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
            time: { completed: Date.parse("2026-07-29T12:00:00.000Z") },
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
