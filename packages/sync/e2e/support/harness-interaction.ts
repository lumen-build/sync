export interface AimockCompletionRequest {
  readonly messages: ReadonlyArray<{
    readonly content: unknown
    readonly role: string
  }>
  readonly model: string
  readonly tools?: ReadonlyArray<unknown>
}

export interface HarnessInteractionProof {
  readonly canaryOccurrences: number
  readonly inputCharacters: number
  readonly inputTokenUnits: number
  readonly messageRoles: ReadonlyArray<string>
  readonly overheadCharacters: number
  readonly overheadTokenUnits: number
  readonly systemCharacters: number
  readonly systemMessages: number
  readonly systemTokenUnits: number
  readonly toolDefinitions: number
}

export interface HarnessInteraction {
  readonly proof: HarnessInteractionProof
  readonly usage: {
    readonly input: number
    readonly output: number
  }
}

const tokenUnits = (value: string): number =>
  value.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu)?.length ?? 0

const textLeaves = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(textLeaves)
  if (typeof value !== "object" || value === null) return []
  return Object.values(value).flatMap(textLeaves)
}

export const countOccurrences = (value: string, pattern: string): number => {
  if (pattern.length === 0) return 0
  let count = 0
  let offset = 0
  while (true) {
    const index = value.indexOf(pattern, offset)
    if (index < 0) return count
    count += 1
    offset = index + pattern.length
  }
}

const totalCharacters = (values: ReadonlyArray<string>): number =>
  values.reduce((total, value) => total + value.length, 0)

const totalTokenUnits = (values: ReadonlyArray<string>): number =>
  values.reduce((total, value) => total + tokenUnits(value), 0)

export const measureHarnessInteraction = (
  request: AimockCompletionRequest,
  canary: string,
  responseContent: string,
): HarnessInteraction => {
  const messageText = request.messages.flatMap((message) => textLeaves(message.content))
  const toolText = textLeaves(request.tools ?? [])
  const inputText = [...messageText, ...toolText]
  const systemText = request.messages
    .filter((message) => message.role === "system")
    .flatMap((message) => textLeaves(message.content))
  const canaryOccurrences = inputText.reduce(
    (total, value) => total + countOccurrences(value, canary),
    0,
  )
  const inputCharacters = totalCharacters(inputText)
  const inputTokenUnits = totalTokenUnits(inputText)
  const canaryCharacters = canary.length * canaryOccurrences
  const canaryTokenUnits = tokenUnits(canary) * canaryOccurrences

  return {
    proof: {
      canaryOccurrences,
      inputCharacters,
      inputTokenUnits,
      messageRoles: request.messages.map((message) => message.role),
      overheadCharacters: Math.max(0, inputCharacters - canaryCharacters),
      overheadTokenUnits: Math.max(0, inputTokenUnits - canaryTokenUnits),
      systemCharacters: totalCharacters(systemText),
      systemMessages: request.messages.filter((message) => message.role === "system").length,
      systemTokenUnits: totalTokenUnits(systemText),
      toolDefinitions: request.tools?.length ?? 0,
    },
    usage: {
      input: inputTokenUnits,
      output: tokenUnits(responseContent),
    },
  }
}
