import { defineConfig } from 'tsup';

/**
 * Build the published `clawroll` package.
 *
 * ## Why there is a build step at all
 *
 * There wasn't one, and that made the package unusable outside this repo: `main` pointed at
 * `./src/index.ts`, which plain `node` cannot load. The source also uses TypeScript's `./x.js`
 * specifier convention for files that are `./x.ts` on disk — correct, and resolvable only by a
 * TS-aware resolver. From a raw npm tarball, that is a module-not-found on first import.
 *
 * ## Why `@clawroll/protocol` is bundled rather than published alongside
 *
 * It is a real runtime dependency, not just types: `client.ts` calls `parseClientMessage` on
 * every outbound frame and reads `PROTOCOL_VERSION` at connect. So it has to reach consumers
 * somehow, and the choice is publish it or inline it.
 *
 * Inlining wins on the thing that actually bites. Two published packages have to be versioned
 * in step, and an SDK resolved against a mismatched protocol is a wire-format bug that presents
 * as a mysterious rejection several hands in. Bundling makes that unrepresentable. It also
 * keeps the wire protocol an implementation detail, which is what it is — nobody writing a bot
 * should be importing zod schemas.
 *
 * `zod` and `ws` stay external and become ordinary dependencies. Bundling those would bloat the
 * package and defeat deduplication in a consumer's tree.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // `resolve` inlines @clawroll/protocol's types into the emitted .d.ts as well.
  //
  // `noExternal` alone only covers the JavaScript. Without this the declarations still read
  // `import { SeatView } from '@clawroll/protocol'` — a package no consumer can resolve — so
  // the JS would run fine and every TypeScript user would fail to compile against it. A
  // failure mode that a smoke test written in plain JS would never catch.
  dts: { resolve: ['@clawroll/protocol'] },
  clean: true,
  sourcemap: true,
  // Node 22 is the floor. The SDK uses `node:crypto` and `ws`, so it was never going to run
  // in a browser, and pretending otherwise in the build target helps nobody.
  target: 'node22',
  platform: 'node',
  noExternal: ['@clawroll/protocol'],
});
