/**
 * Import cycles, checked on the runtime graph only.
 *
 * A separate config because it needs the opposite `tsPreCompilationDeps` from the layer rules,
 * and that option is global to a run. The layer rules want `import type` in the graph — that is
 * where every leak they exist for was hiding. Cycle detection wants it out: TypeScript erases a
 * type-only import, so a cycle made of them is not a cycle in anything that runs, and 167 of
 * them fall out of the type-aware graph. Filtering the rule instead of the graph does not work,
 * since a mixed cycle is still reported from whichever of its edges does survive compilation.
 *
 * So: boundaries are judged on the source a reader sees, cycles on the module graph Node builds.
 * Both are zero today.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment:
        'No runtime import cycle anywhere in src. Keeping the graph acyclic is what lets any ' +
        'module be read, tested and loaded on its own.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    includeOnly: '^src',
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
