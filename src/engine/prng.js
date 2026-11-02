// Deterministic integer PRNG (xorshift32). No floating point anywhere, so the
// engine produces identical results on every architecture and in every runtime.

export function createRng(seed) {
  // Force a non-zero uint32 state.
  let state = (seed >>> 0) || 0x9e3779b9;
  return {
    /** Next uint32. */
    next() {
      let x = state;
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      state = x;
      return x;
    },
    /** Uniform integer in [0, n). n must be a positive integer. */
    int(n) {
      return n <= 1 ? 0 : this.next() % n;
    },
    /** Current state, so a game can be snapshotted/restored deterministically. */
    getState() {
      return state >>> 0;
    },
    setState(s) {
      state = (s >>> 0) || 0x9e3779b9;
    },
  };
}
