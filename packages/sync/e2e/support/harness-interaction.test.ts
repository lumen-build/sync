import { expect, it } from "vitest"

import { measureHarnessInteraction } from "./harness-interaction"

it("accounts for user, system, and tool text in deterministic fixture usage", () => {
  const interaction = measureHarnessInteraction(
    {
      messages: [
        { content: "Follow the project rules.", role: "system" },
        { content: "LUMEN_E2E_TEST_CANARY", role: "user" },
      ],
      model: "model-mocked",
      tools: [
        {
          description: "Find a project.",
          name: "find_project",
          parameters: {
            properties: { query: { type: "string" } },
            type: "object",
          },
          type: "function",
        },
      ],
    },
    "LUMEN_E2E_TEST_CANARY",
    "Mocked answer.",
  )

  expect(interaction).toEqual({
    proof: {
      canaryOccurrences: 1,
      inputCharacters: 93,
      inputTokenUnits: 14,
      messageRoles: ["system", "user"],
      overheadCharacters: 72,
      overheadTokenUnits: 13,
      systemCharacters: 25,
      systemMessages: 1,
      systemTokenUnits: 5,
      toolDefinitions: 1,
    },
    usage: {
      input: 14,
      output: 3,
    },
  })
})
