/**
 * The four lines of `next/server` that `route.ts` actually uses.
 *
 * The snapshot of the coupled dashboard's execution route is kept **verbatim** so its verdict
 * cannot drift from the original by an edit of mine. That route is a Next handler, and pulling in
 * Next to call one function would mean installing the framework, its bundler and its runtime into
 * a comparison harness — for a helper that turns an object into a JSON `Response`.
 *
 * So the import is redirected here instead, and this returns a real `Response`. The route reads
 * the result back with `await response.json()`, which is the only thing it does with it.
 */
export const NextResponse = {
  json(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  },
};
