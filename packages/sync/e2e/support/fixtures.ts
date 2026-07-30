export interface LogFixtureOptions {
  readonly eventId: string
  readonly input: number
  readonly output: number
  readonly timeUnixNano?: string
}

export const logFixture = ({
  eventId,
  input,
  output,
  timeUnixNano = "1785319200000000000",
}: LogFixtureOptions): unknown => ({
  resourceLogs: [
    {
      resource: {
        attributes: [
          {
            key: "service.name",
            value: { stringValue: "opencode-e2e" },
          },
        ],
      },
      scopeLogs: [
        {
          logRecords: [
            {
              attributes: [
                {
                  key: "gen_ai.request.model",
                  value: { stringValue: "mock-model" },
                },
                {
                  key: "gen_ai.provider.name",
                  value: { stringValue: "mock-provider" },
                },
                {
                  key: "gen_ai.usage.input_tokens",
                  value: { intValue: String(input) },
                },
                {
                  key: "gen_ai.usage.output_tokens",
                  value: { intValue: String(output) },
                },
                {
                  key: "lumen.source.event_id",
                  value: { stringValue: eventId },
                },
              ],
              eventName: "gen_ai.client.inference.operation.details",
              timeUnixNano,
            },
          ],
        },
      ],
    },
  ],
})
