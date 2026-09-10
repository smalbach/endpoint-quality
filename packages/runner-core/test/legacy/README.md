# Legacy snapshot

Verbatim copies of documentation/endpoint-quality-dashboard/lib as of 2026-09-10T01:27:58Z.
Only edit applied to the .ts files: the `@/lib/x` import alias rewritten to `./x.ts`,
so Node can run them with type stripping. No logic touched.

Source md5:

```
c9563c199ce2bdee76f10e3900632953 contract-operations.ts
4701c72fcf6dc8dac4968cdcdceff419 endpoints.ts
2f1ca232fde5359f5422c490c32c4060 scenarios.ts
8a585b93ba8cfcd7255239e35117db63 execution-plan.ts
bf39eec74241b9984697c2a06a5e58c5 budgets.mjs
040c633c2e7e03ee32d63f0c76df12b9 contract.mjs
```

These files exist to produce `test/golden/matrix.json` and nothing else. They are the
oracle of the P0 parity test and are deleted in P7, together with the original repo.
