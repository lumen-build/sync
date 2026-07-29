import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, win32 } from "node:path"

import { Context, Effect, Layer, Schema } from "effect"

export type ServicePlatform = "darwin" | "linux" | "win32"

export interface ServiceHost {
  readonly appData?: string
  readonly configHome?: string
  readonly home: string
  readonly platform: ServicePlatform
}

export interface ServiceCommand {
  readonly args: ReadonlyArray<string>
  readonly executable: string
}

export interface CommandResult {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

export interface ServiceCommandRunnerInterface {
  readonly run: (command: ServiceCommand) => Effect.Effect<CommandResult, ServiceLifecycleError>
}

export class ServiceCommandRunner extends Context.Service<
  ServiceCommandRunner,
  ServiceCommandRunnerInterface
>()("@lumen-build/sync/ServiceCommandRunner") {}

export interface ServiceDefinition {
  readonly artifact: {
    readonly contents: string
    readonly mode: number
    readonly path: string
  }
  readonly install: ReadonlyArray<ServiceCommand>
  readonly logs: {
    readonly stderr: string
    readonly stdout: string
  }
  readonly uninstall: ReadonlyArray<ServiceCommand>
}

export interface DefinitionOptions {
  readonly configPath: string
  readonly executablePath: string
  readonly host: ServiceHost
}

export class InvalidServiceDefinition extends Schema.TaggedErrorClass<InvalidServiceDefinition>()(
  "InvalidServiceDefinition",
  {
    field: Schema.String,
    reason: Schema.String,
  },
) {}

export class ServiceLifecycleError extends Schema.TaggedErrorClass<ServiceLifecycleError>()(
  "ServiceLifecycleError",
  {
    operation: Schema.String,
    reason: Schema.String,
  },
) {}

const validatePath = (
  field: string,
  value: string,
): Effect.Effect<string, InvalidServiceDefinition> =>
  value.length === 0 || value.includes("\u0000") || /[\r\n]/u.test(value)
    ? Effect.fail(
        new InvalidServiceDefinition({
          field,
          reason: "expected a non-empty path without control characters",
        }),
      )
    : Effect.succeed(value)

const configRoot = (host: ServiceHost): string =>
  host.configHome ??
  (host.platform === "win32"
    ? (host.appData ?? win32.join(host.home, "AppData", "Roaming"))
    : join(host.home, ".config"))

const stateRoot = (host: ServiceHost): string =>
  host.platform === "win32"
    ? win32.join(configRoot(host), "lumen-build", "sync")
    : join(configRoot(host), "lumen-build", "sync")

const xml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")

const plist = (value: string): string => xml(value)

const systemdArgument = (value: string): string =>
  `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("%", "%%")}"`

const windowsArgument = (value: string): string => {
  if (!/[\s"]/u.test(value)) return value
  let output = '"'
  let slashes = 0
  for (const character of value) {
    if (character === "\\") {
      slashes += 1
    } else if (character === '"') {
      output += `${"\\".repeat(slashes * 2 + 1)}"`
      slashes = 0
    } else {
      output += `${"\\".repeat(slashes)}${character}`
      slashes = 0
    }
  }
  return `${output}${"\\".repeat(slashes * 2)}"`
}

const launchdDefinition = (
  executablePath: string,
  configPath: string,
  host: ServiceHost,
): ServiceDefinition => {
  const label = "build.lumen.sync"
  const logs = {
    stderr: join(stateRoot(host), "collector.stderr.log"),
    stdout: join(stateRoot(host), "collector.stdout.log"),
  }
  const artifactPath = join(host.home, "Library", "LaunchAgents", `${label}.plist`)
  const contents = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${label}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${plist(executablePath)}</string>`,
    "    <string>collector</string>",
    "    <string>start</string>",
    "    <string>--config</string>",
    `    <string>${plist(configPath)}</string>`,
    "  </array>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>StandardErrorPath</key>",
    `  <string>${plist(logs.stderr)}</string>`,
    "  <key>StandardOutPath</key>",
    `  <string>${plist(logs.stdout)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n")

  return {
    artifact: { contents, mode: 0o600, path: artifactPath },
    install: [
      {
        args: ["bootstrap", `gui/${process.getuid?.() ?? 0}`, artifactPath],
        executable: "/bin/launchctl",
      },
    ],
    logs,
    uninstall: [
      {
        args: ["bootout", `gui/${process.getuid?.() ?? 0}`, artifactPath],
        executable: "/bin/launchctl",
      },
    ],
  }
}

const systemdDefinition = (
  executablePath: string,
  configPath: string,
  host: ServiceHost,
): ServiceDefinition => {
  const serviceName = "lumen-sync.service"
  const artifactPath = join(configRoot(host), "systemd", "user", serviceName)
  const logs = {
    stderr: "journalctl --user --unit lumen-sync.service",
    stdout: "journalctl --user --unit lumen-sync.service",
  }
  const commandArguments = [executablePath, "collector", "start", "--config", configPath]
    .map(systemdArgument)
    .join(" ")
  const contents = [
    "[Unit]",
    "Description=Lumen Sync local OTLP collector",
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=${commandArguments}`,
    "Restart=on-failure",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")

  return {
    artifact: { contents, mode: 0o600, path: artifactPath },
    install: [
      { args: ["--user", "daemon-reload"], executable: "systemctl" },
      { args: ["--user", "enable", "--now", serviceName], executable: "systemctl" },
    ],
    logs,
    uninstall: [
      { args: ["--user", "disable", "--now", serviceName], executable: "systemctl" },
      { args: ["--user", "daemon-reload"], executable: "systemctl" },
    ],
  }
}

const windowsDefinition = (
  executablePath: string,
  configPath: string,
  host: ServiceHost,
): ServiceDefinition => {
  const taskName = "Lumen Sync"
  const root = stateRoot(host)
  const artifactPath = win32.join(root, "lumen-sync-task.xml")
  const logs = {
    stderr: win32.join(root, "collector.stderr.log"),
    stdout: win32.join(root, "collector.stdout.log"),
  }
  const commandArguments = ["collector", "start", "--config", configPath]
    .map(windowsArgument)
    .join(" ")
  const contents = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>",
    '  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>',
    "  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Interval>PT2S</Interval><Count>3</Count></RestartOnFailure></Settings>",
    '  <Actions Context="Author"><Exec>',
    `    <Command>${xml(executablePath)}</Command>`,
    `    <Arguments>${xml(commandArguments)}</Arguments>`,
    "  </Exec></Actions>",
    "</Task>",
    "",
  ].join("\r\n")

  return {
    artifact: { contents, mode: 0o600, path: artifactPath },
    install: [
      {
        args: ["/Create", "/TN", taskName, "/XML", artifactPath, "/F"],
        executable: "schtasks.exe",
      },
    ],
    logs,
    uninstall: [
      {
        args: ["/Delete", "/TN", taskName, "/F"],
        executable: "schtasks.exe",
      },
    ],
  }
}

export const makeServiceDefinition = Effect.fn("ServiceDefinition.make")(function* ({
  configPath,
  executablePath,
  host,
}: DefinitionOptions) {
  const executable = yield* validatePath("executablePath", executablePath)
  const config = yield* validatePath("configPath", configPath)
  switch (host.platform) {
    case "darwin":
      return launchdDefinition(executable, config, host)
    case "linux":
      return systemdDefinition(executable, config, host)
    case "win32":
      return windowsDefinition(executable, config, host)
  }
})

const lifecycleError = (operation: string, cause: unknown): ServiceLifecycleError =>
  new ServiceLifecycleError({
    operation,
    reason: cause instanceof Error ? cause.message : String(cause),
  })

const readArtifact = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      try {
        return {
          contents: await readFile(path, "utf8"),
          mode: (await stat(path)).mode & 0o777,
        }
      } catch (cause) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        ) {
          return undefined
        }
        throw cause
      }
    },
    catch: (cause) => lifecycleError("read service definition", cause),
  })

const writeArtifact = (path: string, contents: string, mode: number) =>
  Effect.tryPromise({
    try: async () => {
      const temporary = `${path}.${crypto.randomUUID()}.tmp`
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      try {
        await writeFile(temporary, contents, { mode })
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
    },
    catch: (cause) => lifecycleError("write service definition", cause),
  })

const runCommands = Effect.fn("ServiceLifecycle.runCommands")(function* (
  commands: ReadonlyArray<ServiceCommand>,
) {
  const runner = yield* ServiceCommandRunner
  for (const command of commands) {
    const result = yield* runner.run(command)
    if (result.exitCode !== 0) {
      return yield* new ServiceLifecycleError({
        operation: `${command.executable} ${command.args.join(" ")}`,
        reason: result.stderr.trim() || `exited with code ${result.exitCode}`,
      })
    }
  }
})

export const installService = Effect.fn("ServiceLifecycle.install")(function* (
  definition: ServiceDefinition,
) {
  const previous = yield* readArtifact(definition.artifact.path)
  yield* writeArtifact(
    definition.artifact.path,
    definition.artifact.contents,
    definition.artifact.mode,
  )
  yield* runCommands(definition.install).pipe(
    Effect.catch((error) =>
      (previous === undefined
        ? Effect.tryPromise({
            try: () => rm(definition.artifact.path, { force: true }),
            catch: () => error,
          })
        : writeArtifact(definition.artifact.path, previous.contents, previous.mode)
      ).pipe(Effect.andThen(Effect.fail(error))),
    ),
  )
})

export const uninstallService = Effect.fn("ServiceLifecycle.uninstall")(function* (
  definition: ServiceDefinition,
) {
  const [stop, ...afterRemoval] = definition.uninstall
  if (stop !== undefined) yield* runCommands([stop])
  yield* Effect.tryPromise({
    try: () => rm(definition.artifact.path, { force: true }),
    catch: (cause) => lifecycleError("remove service definition", cause),
  })
  yield* runCommands(afterRemoval)
})

export const liveServiceCommandRunnerLayer: Layer.Layer<ServiceCommandRunner> = Layer.succeed(
  ServiceCommandRunner,
  ServiceCommandRunner.of({
    run: Effect.fn("ServiceCommandRunner.live")(function* ({ args, executable }) {
      const child = yield* Effect.try({
        try: () => Bun.spawn([executable, ...args], { stderr: "pipe", stdout: "pipe" }),
        catch: (cause) => lifecycleError(`start ${executable}`, cause),
      })
      const [exitCode, stderr, stdout] = yield* Effect.tryPromise({
        try: () =>
          Promise.all([
            child.exited,
            new Response(child.stderr).text(),
            new Response(child.stdout).text(),
          ]),
        catch: (cause) => lifecycleError(`run ${executable}`, cause),
      })
      return { exitCode, stderr, stdout }
    }),
  }),
)
