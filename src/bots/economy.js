// Reference bot: pure economy. Spawns workers and harvests relentlessly,
// cycling each creep between the nearest source and the spawn. Deterministic.

const abs = (n) => (n < 0 ? -n : n);
const cheb = (a, b) => Math.max(abs(a.x - b.x), abs(a.y - b.y));

export function loop(state, api) {
  const { me, sources } = state;
  const live = sources.filter((s) => s.energy > 0);

  if (me.spawn.energy >= me.costs.creep && me.creeps.length < me.maxCreeps) api.spawnCreep();

  for (const c of me.creeps) {
    if (c.carry >= me.carryCapacity) {
      if (cheb(c, me.spawn) <= 1) api.transfer(c.id);
      else api.moveTo(c.id, me.spawn.x, me.spawn.y);
      continue;
    }
    if (live.length === 0) continue;
    let target = live[0];
    for (const s of live) if (cheb(c, s) < cheb(c, target)) target = s;
    if (cheb(c, target) <= 1) api.harvest(c.id, target.id);
    else api.moveTo(c.id, target.x, target.y);
  }
}
