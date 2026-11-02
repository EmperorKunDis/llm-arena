// Reference bot: military rush. Two creeps harvest to fund the spawn; everyone
// else marches on the enemy spawn and attacks whatever is adjacent. Deterministic.

const abs = (n) => (n < 0 ? -n : n);
const cheb = (a, b) => Math.max(abs(a.x - b.x), abs(a.y - b.y));

export function loop(state, api) {
  const { me, enemy, sources } = state;
  const live = sources.filter((s) => s.energy > 0);

  if (me.spawn.energy >= me.costs.creep && me.creeps.length < me.maxCreeps) api.spawnCreep();

  // Stable ordering so the same two ids always harvest.
  const creeps = [...me.creeps].sort((a, b) => (a.id < b.id ? -1 : 1));
  creeps.forEach((c, i) => {
    const harvester = i < 2 && live.length > 0;
    if (harvester) {
      if (c.carry >= me.carryCapacity) {
        if (cheb(c, me.spawn) <= 1) api.transfer(c.id);
        else api.moveTo(c.id, me.spawn.x, me.spawn.y);
        return;
      }
      let t = live[0];
      for (const s of live) if (cheb(c, s) < cheb(c, t)) t = s;
      if (cheb(c, t) <= 1) api.harvest(c.id, t.id);
      else api.moveTo(c.id, t.x, t.y);
      return;
    }
    // Soldier: attack an adjacent enemy, else advance on the enemy spawn.
    const targets = [...enemy.creeps, ...enemy.structures, enemy.spawn];
    const adj = targets.find((t) => cheb(c, t) <= 1);
    if (adj) api.attack(c.id, adj.id);
    else api.moveTo(c.id, enemy.spawn.x, enemy.spawn.y);
  });
}
