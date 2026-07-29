import { Context, Crypto, Duration, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export type ServicePlatform = "darwin" | "linux" | "win32"

export interface ServiceHost {
  readonly appData?: string
  readonly configHome?: string
  readonly home: string
  readonly platform: ServicePlatform
  readonly userId?: number
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

export type ServiceStatus = "absent" | "exact" | "modified"

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

const joinHost = (platform: ServicePlatform, ...parts: ReadonlyArray<string>): string => {
  const separator = platform === "win32" ? "\\" : "/"
  return parts
    .filter((part) => part.length > 0)
    .map((part, index) =>
      index === 0
        ? part.replace(new RegExp(`${separator === "\\" ? "\\\\" : separator}+$`, "u"), "")
        : part.replace(
            new RegExp(
              `^${separator === "\\" ? "\\\\" : separator}+|${separator === "\\" ? "\\\\" : separator}+$`,
              "gu",
            ),
            "",
          ),
    )
    .join(separator)
}

const configRoot = (host: ServiceHost): string =>
  host.configHome ??
  (host.platform === "win32"
    ? (host.appData ?? joinHost(host.platform, host.home, "AppData", "Roaming"))
    : joinHost(host.platform, host.home, ".config"))

const stateRoot = (host: ServiceHost): string =>
  joinHost(host.platform, configRoot(host), "lumen-build", "sync")

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
    stderr: joinHost(host.platform, stateRoot(host), "collector.stderr.log"),
    stdout: joinHost(host.platform, stateRoot(host), "collector.stdout.log"),
  }
  const artifactPath = joinHost(
    host.platform,
    host.home,
    "Library",
    "LaunchAgents",
    `${label}.plist`,
  )
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
    "    <string>run</string>",
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
        args: ["bootstrap", `gui/${host.userId ?? 0}`, artifactPath],
        executable: "/bin/launchctl",
      },
    ],
    logs,
    uninstall: [
      {
        args: ["bootout", `gui/${host.userId ?? 0}`, artifactPath],
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
  const artifactPath = joinHost(host.platform, configRoot(host), "systemd", "user", serviceName)
  const logs = {
    stderr: "journalctl --user --unit lumen-sync.service",
    stdout: "journalctl --user --unit lumen-sync.service",
  }
  const commandArguments = [executablePath, "collector", "run", "--config", configPath]
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
  const artifactPath = joinHost(host.platform, root, "lumen-sync-task.xml")
  const logs = {
    stderr: joinHost(host.platform, root, "collector.stderr.log"),
    stdout: joinHost(host.platform, root, "collector.stdout.log"),
  }
  const commandArguments = ["collector", "run", "--config", configPath]
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
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(path))) return undefined
    return {
      contents: yield* fs.readFileString(path),
      mode: (yield* fs.stat(path)).mode & 0o777,
    }
  }).pipe(Effect.mapError((cause) => lifecycleError("read service definition", cause)))

const writeArtifact = (path: string, contents: string, mode: number) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const temporary = `${path}.${yield* crypto.randomUUIDv4}.tmp`
    yield* fs.makeDirectory(pathService.dirname(path), {
      recursive: true,
      mode: 0o700,
    })
    yield* fs
      .writeFileString(temporary, contents, { flag: "wx", mode })
      .pipe(
        Effect.andThen(fs.rename(temporary, path)),
        Effect.andThen(fs.chmod(path, mode)),
        Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
      )
  }).pipe(Effect.mapError((cause) => lifecycleError("write service definition", cause)))

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
        ? FileSystem.FileSystem.pipe(
            Effect.flatMap((fs) => fs.remove(definition.artifact.path, { force: true })),
            Effect.mapError(() => error),
          )
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
  const fs = yield* FileSystem.FileSystem
  yield* fs
    .remove(definition.artifact.path, { force: true })
    .pipe(Effect.mapError((cause) => lifecycleError("remove service definition", cause)))
  yield* runCommands(afterRemoval)
})

export const inspectService = Effect.fn("ServiceLifecycle.inspect")(function* (
  definition: ServiceDefinition,
) {
  const artifact = yield* readArtifact(definition.artifact.path)
  if (artifact === undefined) return "absent" as const
  return artifact.contents === definition.artifact.contents
    ? ("exact" as const)
    : ("modified" as const)
})

const collectText = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (output, chunk) => output + chunk,
    ),
  )

const SERVICE_COMMAND_TIMEOUT = Duration.seconds(30)

export const liveServiceCommandRunnerLayer: Layer.Layer<
  ServiceCommandRunner,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  ServiceCommandRunner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return ServiceCommandRunner.of({
      run: Effect.fn("ServiceCommandRunner.live")(function* ({ args, executable }) {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make(executable, args, {
                stderr: "pipe",
                stdout: "pipe",
              }),
            )
            const result = yield* Effect.all(
              {
                exitCode: child.exitCode,
                stderr: collectText(child.stderr),
                stdout: collectText(child.stdout),
              },
              { concurrency: "unbounded" },
            ).pipe(
              Effect.timeoutOrElse({
                duration: SERVICE_COMMAND_TIMEOUT,
                orElse: () =>
                  Effect.fail(
                    new ServiceLifecycleError({
                      operation: `run ${executable}`,
                      reason: "timed out after 30 seconds",
                    }),
                  ),
              }),
            )
            return { ...result, exitCode: Number(result.exitCode) }
          }),
        ).pipe(
          Effect.mapError((cause) =>
            cause instanceof ServiceLifecycleError
              ? cause
              : lifecycleError(`run ${executable}`, cause),
          ),
        )
      }),
    })
  }),
)
