# Reference receiver

This is a runnable, in-memory implementation of the Lumen Sync destination
contract. It validates the published schemas, preserves live revisions, stages
daily imports until commit, rejects conflicting replays, and keeps live and
daily data separate.

It is intentionally a reference implementation, not a production database.
Restarting it loses all data. A production receiver should persist transactions
and perform each start, upload, and commit operation atomically.

After `@lumen-build/sync` is published:

```sh
cd examples/receiver
bun install
export RECEIVER_BEARER_TOKEN="local-development-token"
bun run start
```

The server listens on `http://127.0.0.1:8787` by default. Override the port with
`PORT`. Configure the CLI separately:

```sh
export LUMEN_BEARER_TOKEN="$RECEIVER_BEARER_TOKEN"
lumen-sync config init \
  --collector http://127.0.0.1:4318 \
  --destination http://127.0.0.1:8787 \
  --auth bearer
```

Run the conformance test from the repository root after building the package:

```sh
bun run example:check
```
