# Synthetic corpus

There are no documents in this directory on purpose. The synthetic corpus is
generated on the fly from this project's own renderer
(`src/server/samples/corpus.ts`, using the layouts in
`src/server/samples/layouts.ts`), so it can never drift from the code.

**It is a regression signal only.** Every document in it was produced by our
own code, from our own idea of what messy documents look like. A good score
here says nothing about accuracy on real subcontractor documents.

- `gate.json`: the regression thresholds `pnpm eval:extraction` enforces on
  this corpus (exit code 1 when breached; also run by `pnpm test`).
- To look at the generated files and their truth files:
  `pnpm eval:extraction --set synthetic --dump-synthetic samples/out/eval-synthetic`
  (`samples/out` is git-ignored).

See `docs/extraction-evaluation.md`.
