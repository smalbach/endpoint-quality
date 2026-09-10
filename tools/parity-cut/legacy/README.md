# Legacy execution snapshot

The other half of the oracle. `packages/runner-core/test/legacy` froze how the coupled dashboard
**generated** its 311 cases; this freezes how it **executed** them, so P6 can compare a verdict
against a verdict instead of against a description of one.

`route.ts` is a verbatim copy of `documentation/endpoint-quality-dashboard/app/api/run/route.ts`
as of 2026-09-10. Two import lines are rewritten and nothing else:

- `@/lib/contract.mjs` and `@/lib/budgets.mjs` point at the copies already in
  `packages/runner-core/test/legacy` — the same files, not a second snapshot of them;
- `next/server` points at `next-server-shim.ts`, fifteen lines that return a real `Response`, so
  the handler can be called as a function without installing Next into a comparison harness.

Source md5:

```
c90fed27af16d4910a8918f672b21618 route.ts
```

`orchestrate.ts` could not be copied: in the original it is a closure over React state inside
`components/api-dashboard.tsx`. Its header lists the edits applied, which are the removal of the
`setResults` calls, direct invocation of `POST`, and turning component state into constructor
parameters. Every branch is unchanged.

Deleted in P7 together with the original repo.
