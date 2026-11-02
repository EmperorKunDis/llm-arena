// Reference bot: deterministic "random" walk. Picks moves from a hash of the
// tick and creep id (no Math.random, so matches stay reproducible). A weak
// baseline that still spends energy and wanders.

const hash = (tick, id) => {
  let h = tick * 2654435761;
  for (let i = 0; i < id.length; i++) h = (h ^ id.charCodeAt(i)) * 16777619;
  return (h >>> 0) % 8;
};

export function loop(state, api) {
  const { me } = state;
  if (me.spawn.energy >= me.costs.creep && me.creeps.length < me.maxCreeps && state.tick % 3 === 0)
    api.spawnCreep();
  for (const c of me.creeps) api.move(c.id, hash(state.tick, c.id));
}
