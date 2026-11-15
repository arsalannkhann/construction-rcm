# Real documents for extraction evaluation

Put real subcontractor billing documents here, each with a hand-keyed truth
file beside it. **Everything in this directory except this README is
git-ignored. Customer documents must never be committed.** Check with
`git status` before every commit; nothing under `eval/real/` other than this
file should ever appear.

```
eval/real/
  acme-electric/
    payapp-07.pdf
    payapp-07.pdf.truth.json
  river-mechanical/
    2026-10-package.pdf
    2026-10-package.pdf.truth.json
```

- A document is any `.pdf`, `.png`, `.jpg`, `.jpeg`, `.webp` or `.gif`.
- Its truth file has the same name plus `.truth.json`.
- A document without a truth file is listed and skipped, never guessed at.
- Subfolders are fine (one per subcontractor is convenient).

Run:

```bash
pnpm eval:extraction --set real --engine text
pnpm eval:extraction --set real --engine claude   # needs ANTHROPIC_API_KEY
```

How to write a truth file, how to redact, and how many documents to collect
before the numbers mean anything: `docs/extraction-evaluation.md`. Start from
`eval/truth-template.json`.
