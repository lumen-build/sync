# Releasing

`@lumen-build/sync` is the only public package. Internal workspace packages are
bundled into it and must not be published separately.

The workflow follows
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and uses
Node 24 with npm 11.5.1 or newer.

## One-time bootstrap

The package must exist on npm before its trusted publisher can be configured.
For the first release only:

1. Merge a green PR to `main`.
2. From that exact commit, run:

   ```sh
   bun install --frozen-lockfile
   bun run check
   bun run package:check
   npm publish ./packages/sync --access public
   ```

3. On npmjs.com, configure the trusted publisher for:
   - package: `@lumen-build/sync`
   - organization: `lumen-build`
   - repository: `sync`
   - workflow filename: `release.yml`
   - allowed action: `npm publish`
4. Restrict traditional publish-token access after the trusted publisher has
   completed one successful release.

The first publish requires maintainer authentication and npm 2FA. Never add an
npm automation token to the repository.

## Subsequent releases

1. Update `packages/sync/package.json` and the receiver example dependency to
   the same version in a pull request.
2. Run `bun install` if the lockfile changes.
3. Merge only after every CI job passes.
4. Tag the merge commit with the package version:

   ```sh
   git tag v0.1.1
   git push origin v0.1.1
   ```

The release workflow checks that the tag and package version match, repeats the
full verification and packed-artifact checks, and publishes through npm trusted
publishing. GitHub Actions receives only the short-lived OIDC permission; no
long-lived npm token is used. npm generates provenance automatically for a
public package published from a public repository through trusted publishing.

After the workflow completes, verify the registry artifact:

```sh
npm view @lumen-build/sync version
temporary_directory="$(mktemp -d)"
cd "$temporary_directory"
bun init -y
bun add @lumen-build/sync
bunx lumen-sync --help
```

Do not reuse the example `temporary_directory` variable for broad or recursive
cleanup. Remove only the exact directory you created.

## Failed releases

Published npm versions are immutable. Fix the cause, increment the version, and
create a new tag. Do not move or recreate an already published tag.
