// Everything the browser may have.
//
// The barrel re-exports `freeze()`, which hashes with `node:crypto`. Importing
// it from a client component drags a Node builtin into a webpack bundle and the
// build fails — twice now, from two different files, which is the argument for
// making the boundary explicit rather than remembering to avoid it.
//
// The split is not arbitrary. Freezing is the act of producing an immutable
// build id, and that belongs to the server: the browser proposes edits, the
// server decides what compiles. Everything below is analysis and rendering,
// which the canvas legitimately needs in order to draw findings as you type.

export { elaborate, blockingFindings, registry } from "./elaborate.js";
export { Graph, fieldsOf, splitPath, topoSort, loopScopes } from "./graph.js";
export { nodeConditions, edgeConditions, optionSources, transportRegistry } from "./conditions.js";
export { policyIsResolved, resolvedToRelation, resolvedToImpl } from "./conditions.js";
export type { Option } from "./conditions.js";
export { apply, applyAll, validate, fill, MutationError } from "./mutations.js";
export { parseAnswer, isListValued } from "./mutations.js";
export { render, EmptyOptionSet, NothingToConfirm, NotAQuestion } from "./render.js";
export { askKey, askedAlready, shouldAsk, findingKey, mutationKey } from "./asked.js";
export type { AskedComment } from "./asked.js";
export type { Rendered } from "./render.js";
export * from "./types.js";
