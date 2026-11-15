# Extraction evaluation

How we measure the document readers, what the numbers mean, and what they do
not mean.

> **Accuracy on real subcontractor documents is unmeasured.** Every number in
> this document comes from the synthetic corpus, which this project's own code
> generates. A synthetic score is a regression signal: it tells us whether a
> change made the reader better or worse on layouts we thought of. It says
> nothing about the documents customers will send. Do not quote it as accuracy.

## 1. The process

1. A **corpus** is a set of document files, each with a **truth file**: what is
   printed on it, keyed by a person (real corpus) or written by the generator
   (synthetic corpus).
2. `pnpm eval:extraction` runs a reader (an **engine**) over the corpus, scores
   every value against the truth, and prints a report. It never pools the
   synthetic and real corpora: each gets its own section, its own disclaimer and
   its own figures.
3. On the synthetic corpus, a **regression gate** fails the run (exit code 1)
   if the reader got worse. `pnpm test` runs the same gate.

```bash
pnpm eval:extraction --set synthetic --engine text     # the gate, as CI runs it
pnpm eval:extraction --set real --engine text          # your real documents
pnpm eval:extraction --set real --engine claude        # needs ANTHROPIC_API_KEY
pnpm eval:extraction --set all --json out.json         # both, plus machine-readable output
pnpm eval:extraction --case g703/ --verbose            # some cases, every miss listed (no gate)
pnpm eval:extraction --set synthetic --dump-synthetic samples/out/eval-synthetic   # look at the files
```

Exit codes: 0 ok, 1 the synthetic gate failed, 2 usage error, missing API key
or a broken truth file.

## 2. The truth format

One truth file per document file, beside it, named `<file name>.truth.json`
(`payapp-07.pdf` → `payapp-07.pdf.truth.json`). Start from
[`eval/truth-template.json`](../eval/truth-template.json). The schema, with a
comment on every field, is `src/server/documents/evaluation/truth.ts`; a truth
file that does not match it stops the run (exit code 2) and says where.

Conventions:

- **Money is integer cents.** `10350000` is $103,500.00. A credit is negative.
- **Dates are ISO** (`2026-10-31`).
- **Omitted means "not scored"**: leave a key out if you could not determine it.
  **`null` means "not printed"**, and the right answer for a reader is also
  nothing.
- **Key what the document says**, including the subcontractor's own mistakes.
  Never correct a figure in a truth file: the reader is judged on reading, and
  reconciliation is what catches the subcontractor's arithmetic.

What a truth file holds:

| Key | What |
|---|---|
| `documents` | The type of every page, as page ranges (`pay_application`, `continuation_sheet`, `lien_waiver`, `other`, …). |
| `payApp` | The G702 (or equivalent): identifying fields, the eleven summary amounts, `signed`, `signatureMark` (`electronic` or `ink`), `notarized`. `null` if the file has none. |
| `lines` | Every schedule-of-values row, in order. Subtotal, carried-forward and grand-total rows are not lines. |
| `lineTotals` | The printed grand-total row, column by column. |
| `waivers` | One entry per lien waiver, with its page. `exceptions` is a list of distinctive parts of each exception, or `null` for none. |
| `pageNumbering` | Every "page x of y" marking printed in the file. |
| `expect.outcome` | `processed` (default), `unreadable` or `failed`; or one per engine. |
| `expect.flags` | Conditions the reader must surface: `missing_page`, `total_conflict`, `application_number_conflict`, `second_pay_application`, `unreadable_page`. |
| `expect.abstain` | Fields where the right answer is to decline (e.g. an amount whose number format is ambiguous). `*` matches any key or index. |
| `expect.notes` | Patterns that must appear in the reader's notes. |
| `expect.knownLimitation` | A limitation this case pins, in words. Misses still count. |

## 3. Adding real documents

Real documents go in `eval/real/`, one folder per subcontractor if you like.
**Everything there except its README is git-ignored. Customer documents and
their truth files must never be committed**: a truth file is customer data too.
Run `git status` before every commit.

1. Copy the document in as received. Do not re-save, print to PDF or OCR it:
   the point is to measure what customers actually send.
2. Copy `eval/truth-template.json` beside it as `<file name>.truth.json` and
   replace every value with what the document prints. Delete keys you cannot
   determine. Key from the document, not from the app's reading of it.
3. Have a second person key the same document independently (see the pilot
   protocol below), compare, and settle each difference against the document.
4. Run `pnpm eval:extraction --set real --engine <engine>`.

A document without a truth file is listed and skipped, never guessed at.

## 4. Engines

| `--engine` | What runs | Notes |
|---|---|---|
| `text` | The text-layer reader (`src/server/documents/engine-text.ts`). | Deterministic, no network. Reads only what is in the PDF's text layer. Declines (leaves blank, or reports below the 0.75 review threshold) when it cannot be sure. Cannot read scans, photos or ink. |
| `claude` | The AI reader (`src/server/documents/engine-claude.ts`). | Needs `ANTHROPIC_API_KEY`. Without one the harness refuses and evaluates nothing; it never invents or simulates a model result. A case where the AI call failed and the text reader answered instead is left out of the scores and listed as excluded. |
| `auto` | Claude when configured, otherwise text. | What production does. |

Whatever the engine, **arithmetic is never the AI's**: totals are compared by
reconciliation in integer cents. When the file has a text layer, the AI
reader's printed grand total is checked against the text layer's, and its page
numbering and conflicts come from the text layer.

The Claude engine has **not been measured** on the synthetic corpus in this
repository (no API key in the environment where these numbers were produced).

## 5. Reading the report

The report opens with the corpus, its disclaimer, and the one number that
matters most:

- **CONFIDENTLY WRONG**: values reported wrong at confidence ≥ 0.75. Nothing
  asks a person to check these, so they are the dangerous errors. A missed
  waiver exception counts here at any confidence, because downstream a blank
  means "no exceptions". The target is zero.
- **Safe misses**: *flagged* (wrong, but below 0.75, so the review screen asks
  a person to check it) and *declined* (left blank for a person).

Then the share of printed values read exactly right, per group, and a table
per field:

| Column | Meaning |
|---|---|
| `n` | Values printed on the documents read. |
| `acc` | Share of `n` read exactly right. |
| `declined` | The reader gave no value (safe). |
| `flagged` | Wrong, below the review threshold (safe). |
| `WRONG-HIGH` | Wrong at confidence ≥ 0.75 (dangerous). |
| `blank ok` | Not printed, and correctly left empty. |
| `invented h/l` | A value reported where none is printed, at high / low confidence. |

Schedule rows are matched to the truth first; an unmatched truth row counts as
declined for every column, and a row read that is not on the sheet (a subtotal
taken for a line) counts as dangerous.

**Calibration** lists, per confidence band, how many reported values were
right. A reader is well calibrated when its high bands are right and its doubts
are concentrated below 0.75.

**Expectations not met** lists flags, notes, outcomes and abstentions the truth
asked for that the reader did not deliver. `--verbose` or `--json` lists every
miss.

## 6. The regression gate

`eval/synthetic/gate.json` holds the thresholds per engine key (today only
`text-layer`):

- `maxConfidentlyWrong`: **0**. Never raise it.
- `min`: floors for page type, G702 amounts, identifying fields, row recall,
  cells, grand totals, waivers, expected flags and outcomes, set at the
  measured values below.

The CLI applies the gate on a full synthetic run (not with `--case`), and
`tests/eval-synthetic.test.ts` applies it in `pnpm test`, alongside pinned
tests for the known limitations in section 8. When the reader improves, raise
the floors to the new measurement in the same commit. Lowering a floor needs a
reason in the commit message.

## 7. Measured synthetic results

**SYNTHETIC.** Text-layer engine, 65 generated files, 177 pages, measured on
2026-11-15 at commit `85c4572` (the reader has not changed since). The
"before" column is the same corpus at commit `0052096`, before this round of
work.

| | Before (`0052096`) | After (`85c4572`) |
|---|---:|---:|
| **Confidently wrong** | **100** | **0** |
| Wrong but flagged (safe) | 17 | 2 |
| Declined (safe) | 1230 | 570 |
| Document type, per page | 85.9% | 95.5% |
| G702 amounts, to the cent | 84.9% | 90.6% |
| G702 identifying fields | 87.8% | 93.1% |
| Schedule rows: recall / precision | 80.5% / 97.2% | 91.2% / 100% |
| Schedule cells | 78.9% | 91.1% |
| Schedule grand totals | 78.3% | 91.8% |
| Lien waiver fields | 83.3% | 95.3% |
| Expected flags raised | 4/8 | 8/8 |
| Expected notes present | 0/1 | 1/1 |
| Conflicts reported that the truth does not expect | 0 | 0 |

Calibration after: every value reported at 0.75 or above was right (6,020 of
6,020); of 285 values reported between 0.50 and 0.75, 284 were right.

The 100 confidently wrong values before, by cause, and what changed:

| Cause | Values | Now |
|---|---:|---|
| Schedule columns in a non-standard order, mapped by position | 45 | Columns are mapped by their heading words and A–J letters; when the two disagree the reader flags instead of choosing, and positional mapping is capped below the review threshold. |
| Wrapped descriptions taken for rows, or attached to the wrong row | 14 | A continuation line attaches to the nearer row by line spacing; an ambiguous one marks both rows for review. |
| European number formats read as US | 11 | Amounts in a format other than the page's are declined, with a note. |
| A second pay application in the same file merged into the first | 10 | Only the first is read; the second is reported as a conflict. |
| A dash for zero shifted the cells | 7 | A dash is a zero in its own column, matched by position. |
| Page subtotals and division headings read as rows | 6 | Subtotal, carried-forward and heading rows are skipped; a total row must look like one. |
| Item numbers read as amounts on whole-dollar schedules | 3 | Bare integers cannot start an amount column. |
| A cover letter and an invoice classified as a pay application | 2 | Classification reads titles only from the page header and needs the G702 amount block; a letter or invoice that mentions a pay application is not one. |
| Only the first of several listed waiver exceptions read | 1 | The whole exceptions section is read, up to the signature block. |
| A handwritten correction over the printed amount | 1 | Pinned limitation: the printed figure is kept at confidence 0.5 with a note. |

Each fix is a rule about the layout, not a match on generated strings.

## 8. Known limitations (pinned in tests)

All of these are safe: the reader declines or reports below the review
threshold, and reconciliation blocks approval where the amount paid could be
affected.

- **Handwritten corrections.** The text layer still carries the printed figure.
  The text reader keeps it at confidence ≤ 0.5 with the note "an image is drawn
  over the printed …". Reading the ink needs the AI reader.
- **Scans, photos, and scanned pages inside a text PDF** (251 values declined,
  1 flagged). Nothing without a text layer is read; such pages are reported as
  unreadable and must be keyed by hand.
- **European number formats** (298 declined, by design). `1.234,56` is never
  guessed at.
- **Ink signatures and unsigned forms** are reported as *unclear*, never as
  signed: a person confirms.
- **A waiver amount written only in words** is declined, with a note.
- **Non-standard G702 wording without line numbers** (9 declined) and **own
  forms** whose application date is labelled only "Date:" or whose contractor
  name appears only in the letterhead (4 declined).

## 9. How the reader's checks reach reconciliation

Besides the figures, each reading records the schedule's printed grand total,
every printed page number, conflicting printed values, and pages it could not
read (`ExtractionResult.scheduleGrandTotal`, `pageNumbering`, `conflicts`,
`unreadablePages`). Reconciliation (`src/server/recon/engine.ts`) turns them
into findings. Anything that could change the amount paid blocks approval until
a person resolves it.

| Finding | Severity | When |
|---|---|---|
| `math.grand_total` | Blocking (warning if only scheduled value, previous or balance differ) | The schedule's printed grand total differs from the integer-cent sum of the rows under review, in any column. Rows keyed by hand count; a row a reviewer adjusted counts as printed. Passes when every column ties. |
| `doc.page_missing` | Blocking | The printed page numbering has a gap that no other file in the package fills. |
| `doc.unreadable_pages` | Blocking | Pages had no text layer and could not be read. Clears when someone keys them and accepts the finding with a note. |
| `doc.conflict` | Blocking (warning for contract sum to date) | Two application numbers in one file; a second pay application in a file; two files with different application numbers; the G702 and G703 printing different totals. |

## 10. Real-world accuracy

Unmeasured. There are no real documents with truth files in this repository,
by design (they are customer data). Until a pilot has produced them, the only
honest statement is that the reader has been tested on layouts we generated
ourselves.

## 11. Pilot protocol

A proposal; the numbers are defaults to agree with the pilot customer.

1. **Double-key the first packages.** For each subcontractor, the first 3
   packages, and every package that uses a form not seen before. Two people key
   each document into a truth file independently, from the PDF, without
   looking at the app's reading. A third settles every difference against the
   document.
2. **Review as normal meanwhile.** During the pilot nothing is paid on the
   reader's output alone: reviewers check figures against the document, and
   every blocking finding must be resolved.
3. **Measure** with `pnpm eval:extraction --set real --engine <the engine in
   use>`, and record the date, commit, engine and document count with the
   numbers. Report synthetic and real figures separately, always.
4. **Any confidently wrong value stops the line.** Reproduce the layout as a
   synthetic case (no customer data in it), fix the reader, raise the gate,
   and re-run the real corpus.
5. **Reduce double keying for a subcontractor** only after its packages show no
   confidently wrong value, and overall only after at least 30 documents from
   at least 5 subcontractors show none. Zero errors in 30 documents still
   allows a per-document rate of up to about 10% (the "rule of three", 3/n at
   95% confidence), so keep double keying 1 package in 10 after that, and keep
   adding to the corpus.
