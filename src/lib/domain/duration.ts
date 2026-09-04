/**
 * A length of time in minutes, branded so it can't be passed where a price, a traveller
 * count or any other plain number is expected.
 *
 * Issue #1: "Duration — minutes as a branded number."
 *
 * There is no constructor function here on purpose — this directory is types and
 * constants only. Produce one with `123 as Duration` at the point a literal is known
 * (see the DEFAULT_* constants across this directory for examples).
 */
export type Duration = number & { readonly __brand: 'Duration' };
