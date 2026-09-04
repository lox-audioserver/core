/**
 * The layer boundaries, enforced.
 *
 * Reading order is inside-out: `domain` knows nothing, `ports` knows only the
 * domain, `application` speaks to the outside world through ports alone, and
 * `adapters` are the only place a protocol or a vendor SDK appears. `runtime` is
 * the composition root and is therefore allowed to know everything.
 *
 * Every rule here passes today. They are written to keep an invariant that the
 * code already holds, not to describe an aspiration — a rule that fires on every
 * commit teaches everyone to ignore the reporter.
 *
 * Known debt this deliberately does *not* forbid: `adapters/http` reaches into
 * the content, inputs and outputs families directly rather than through the
 * application layer (~30 runtime edges, concentrated in `httpService.ts`). That
 * is real, but a rule for it would fire 30 times a run. When those calls move
 * behind application services, add `http` to the cross-talk rule below.
 *
 * Cycles are checked separately, in `.dependency-cruiser.cycles.cjs` — see that file for why
 * they cannot share this one.
 */
module.exports = {
  forbidden: [
    // --- The inner layers -------------------------------------------------
    {
      name: 'domain-is-innermost',
      comment:
        'The domain is the one layer with no outward dependencies at all. A type it needs ' +
        'from a port (ContentItemKind, once) belongs in the domain instead.',
      severity: 'error',
      from: { path: '^src/domain' },
      to: { path: '^src', pathNot: '^src/domain' },
    },
    {
      name: 'ports-only-domain',
      comment:
        'A port is a contract, so it may name domain concepts and nothing else. Reaching into ' +
        'the engine for a type (ProcessingChain, once) makes the contract depend on one ' +
        'implementation of itself.',
      severity: 'error',
      from: { path: '^src/ports' },
      to: { path: '^src', pathNot: '^src/(ports|domain)' },
    },
    {
      name: 'application-no-adapters-runtime',
      comment: 'Use cases reach the outside world through ports, never through an adapter.',
      severity: 'error',
      from: { path: '^src/application' },
      to: { path: '^src/(adapters|runtime)' },
    },
    {
      name: 'engine-no-application-adapters-runtime',
      comment:
        'The audio engine sits below the use cases: it may read ports, the domain and shared ' +
        'helpers. A constant it shares with an application service (ANALYSIS_DB_FLOOR, once) ' +
        'belongs in the domain.',
      severity: 'error',
      from: { path: '^src/engine' },
      to: { path: '^src/(application|adapters|runtime)' },
    },
    {
      name: 'shared-no-upward',
      comment:
        'Everything imports `shared` (254 times from adapters alone), so it must not import ' +
        'back: one edge into the application layer would couple every adapter to it.',
      severity: 'error',
      from: { path: '^src/shared' },
      to: { path: '^src/(application|adapters|engine|runtime)' },
    },
    {
      name: 'config-no-upward',
      comment: 'Static startup configuration is read by everyone and knows nobody.',
      severity: 'error',
      from: { path: '^src/config' },
      to: { path: '^src/(application|adapters|domain|engine|ports|runtime)' },
    },

    // --- The composition root ---------------------------------------------
    {
      name: 'runtime-only-from-server',
      comment:
        '`runtime` wires every layer together, which is exactly why nothing may import it: an ' +
        'import of the composition root is a cycle through the whole application. Only the ' +
        'entry point may.',
      severity: 'error',
      from: { path: '^src', pathNot: '^src/(runtime|server\\.ts)' },
      to: { path: '^src/runtime' },
    },

    // --- Adapters ---------------------------------------------------------
    {
      name: 'loxone-only-from-runtime-and-http',
      comment:
        'Loxone is one integration among several, not the core. Keeping its adapter reachable ' +
        'only from the composition root and the HTTP gateway is what makes that true rather ' +
        'than merely intended — and what keeps the standalone server buildable without it.',
      severity: 'error',
      from: { path: '^src', pathNot: '^src/(runtime|adapters/(loxone|http))' },
      to: { path: '^src/adapters/loxone' },
    },
    {
      name: 'driven-adapters-no-runtime-crosstalk',
      comment:
        'Content providers, inputs and outputs are driven adapters: the application calls them, ' +
        'they do not call each other. Naming a sibling\'s *type* is allowed — that is how a ' +
        'collaborator gets injected — but a runtime import means one integration is now wired ' +
        'into another behind the application\'s back.',
      severity: 'error',
      from: { path: '^src/adapters/(content|inputs|outputs)/' },
      to: {
        path: '^src/adapters/(content|inputs|outputs)/',
        pathNot: '^src/adapters/$1/',
        dependencyTypesNot: ['type-only'],
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    includeOnly: '^src',
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    /**
     * Follow `import type` too.
     *
     * Off by default, which means the graph is what survives compilation — and a type-only
     * import survives nothing. That is not a detail: all three layer leaks this config was
     * written for (`ContentItemKind` into the domain, `ProcessingChain` into ports,
     * `ANALYSIS_DB_FLOOR` into the engine) were `import type`, so the rule that should have
     * caught them cruised straight past. An erased import still points the wrong way in the
     * source, and the source is what a reader has to reason about.
     */
    tsPreCompilationDeps: true,
  },
};
