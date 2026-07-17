// Slider autopilot (bugs.md): a mode where the player only manages research,
// ships and the map, and five sliders run every colony. Each turn the
// governor translates the slider weights into the same ordinary logged
// commands a human would issue (set_jobs / set_build_queue / buy_production)
// — the simulation never special-cases it, exactly like the solo bot.
//
// Sliders (0..10):
//   infra       — buildings, in the solo bot's winning BUILD_ORDER
//   pop         — housing emphasis (higher = grow to a fuller planet)
//   research    — job preset (industry ↔ blend ↔ research) + scientist shifts
//   colonyShips — colony_base + colony-ship pipeline depth (player sails them)
//   military    — warship quota per colony + a transport lift at high values

import { selectors } from '@engine/index';
import { itemCost, SHIP_BUILDABLES, PROJECT_BUILDABLES } from '@engine/items';
import type { GameState } from '@engine/types';
import type { GameSession } from '@protocol/session';
import { BUILD_ORDER } from './soloBot';

export interface SliderWeights {
  infra: number;
  pop: number;
  research: number;
  colonyShips: number;
  military: number;
}

export const DEFAULT_WEIGHTS: SliderWeights = { infra: 6, pop: 5, research: 5, colonyShips: 4, military: 3 };

/** clamp to 0..10, falling back on the default for anything non-numeric
 * (corrupt localStorage must not silently NaN a slider off) */
const clamp10 = (n: unknown, fallback: number) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(0, Math.min(10, v)) : fallback;
};

export function normalizeWeights(w: Partial<SliderWeights> | null | undefined): SliderWeights {
  return {
    infra: clamp10(w?.infra, DEFAULT_WEIGHTS.infra),
    pop: clamp10(w?.pop, DEFAULT_WEIGHTS.pop),
    research: clamp10(w?.research, DEFAULT_WEIGHTS.research),
    colonyShips: clamp10(w?.colonyShips, DEFAULT_WEIGHTS.colonyShips),
    military: clamp10(w?.military, DEFAULT_WEIGHTS.military),
  };
}

/** Run one governor pass over every colony the player owns. Idempotent per
 * turn: call it once when a new planning turn opens.
 *
 * `pinned` colonies have player-ordered builds outstanding (map-view quick
 * builds): their queues are untouchable — jobs are still balanced and a
 * buyable head is still bought out, but the governor neither reorders nor
 * replaces what the player queued until it completes or is cancelled. */
export function governColonies(
  session: GameSession<GameState>,
  weights: SliderWeights,
  pinned?: ReadonlySet<number>,
): void {
  const planned = session.getPlanned();
  if (!planned || planned.winner !== null) return;
  const me = session.playerId;
  const empire = planned.empires.find((e) => e.id === me);
  if (!empire) return;
  const w = normalizeWeights(weights);
  const submit = (kind: string, payload: unknown) => session.submit(kind, payload);

  // jobs: industry is the workhorse default (the blend preset caps workers
  // at pollution ≤ 2 and starved every yard in testing); research has to be
  // decisively ahead of infra to flip the whole empire to labs
  const preset0: selectors.JobPreset =
    w.research >= w.infra + 3 ? 'research' : w.research > w.infra ? 'blend' : 'industry';
  const sciShifts = Math.floor(w.research / 4); // 0..2 extra scientists per colony

  const myColonies = planned.colonies.filter((c) => c.owner === me && !c.outpost);
  const myWarships = planned.ships.filter((s) => s.owner === me && s.shipKind === 'design').length;
  const queuedWar = myColonies.reduce((n, c) => n + c.queue.filter((q) => q.item.startsWith('design:')).length, 0);
  const summary = selectors.empireSummary(planned, me);
  const cpHeadroom = summary.cpSources - summary.cpUsage;

  // v2-bot debt handling (soloBot.ts): tax while the treasury is negative and
  // flip the strongest yards to trade goods, scaled to the hole — one yard
  // cannot out-earn an empire-wide bleed. Both levers release once solvent.
  const wantTax = empire.bc < -100 ? 30 : empire.bc < 0 ? 15 : 0;
  if (summary.taxRatePct !== wantTax) submit('set_tax_rate', { pct: wantTax });
  const rescueYards = empire.bc < 0 ? Math.min(3, 1 + Math.floor(-empire.bc / 500)) : 0;
  let yardRank = 0;
  let warOrders = myWarships + queuedWar;
  // slider 4 ≈ one warship per colony; 10 ≈ militarist-grade 2.5 per colony
  const wantFleet = w.military > 0 ? Math.ceil(myColonies.length * (w.military / 4)) : 0;
  let transports =
    planned.ships.filter((s) => s.owner === me && s.shipKind === 'transport').length +
    myColonies.reduce((n, c) => n + c.queue.filter((q) => q.item === 'transport').length, 0);
  const wantTransports = w.military >= 6 && myWarships >= 4 ? Math.min(6, Math.floor(w.military / 2)) : 0;

  const freePlanets = planned.planets.filter(
    (p) =>
      p.body === 'planet' &&
      !planned.colonies.some((c) => c.planetId === p.id) &&
      !planned.monsters.some((m) => m.starId === p.starId),
  ).length;
  let pipeline =
    planned.ships.filter((s) => s.owner === me && s.shipKind === 'colony_ship').length +
    myColonies.reduce((n, c) => n + c.queue.filter((q) => q.item === 'colony_ship').length, 0);
  const wantPipeline = Math.min(Math.ceil(w.colonyShips / 2), freePlanets);

  // strongest yards decide first so the military/colony-ship quotas land on
  // the colonies that can actually deliver them (rows cached once — colonyRow
  // is a full economy pass, and a sort comparator would run it O(n log n))
  const rows = new Map(myColonies.map((c) => [c.id, selectors.colonyRow(planned, c)] as const));
  const ordered = [...myColonies].sort((a, b) => {
    return rows.get(b.id)!.output.prodToQueue - rows.get(a.id)!.output.prodToQueue || a.id - b.id;
  });

  for (const colony of ordered) {
    const row = rows.get(colony.id)!;
    const realYard = row.output.prodToQueue >= 5; // weak worlds grow instead of shipbuilding
    const rank = yardRank++;
    const head0 = colony.queue[0]?.item;

    // developed worlds flip to pure research when the slider cares (the solo
    // bot's rule) — but a shipyard mid-hull keeps hands on the tools;
    // everyone else works the weight-picked preset
    const buildingShips = !!head0 && (head0.startsWith('design:') || SHIP_BUILDABLES.has(head0));
    const preset = colony.buildings.length >= 5 && w.research >= 3 && !buildingShips ? 'research' : preset0;
    const jobs = selectors.presetJobs(planned, colony.id, preset);
    if (jobs) {
      // slider-picked scientist shifts, plus the v2 bot's growth term: big
      // colonies staff real labs (an extra scientist per 6 pop beyond 10)
      const units = jobs.reduce((n, g) => n + g.farmers + g.workers + g.scientists, 0);
      const shifts = preset === 'research' ? 0 : sciShifts + Math.max(0, Math.floor((units - 10) / 6));
      for (let k = 0; k < shifts; k++) {
        const g = jobs.find((x) => x.workers > 0);
        if (g) {
          g.workers--;
          g.scientists++;
        }
      }
      submit('set_jobs', { colonyId: colony.id, groups: jobs });
    }

    // v2-bot buyout rule: colony ships get bought outright when the treasury
    // covers them with a buffer; everything else at 2:1
    const buyLimit = head0 === 'colony_ship' ? empire.bc - 60 : Math.floor(empire.bc / 2);

    // player-pinned builds outrank the sliders (and even debt rescue): keep
    // hands off the queue, still buy the player's own order out
    if (pinned?.has(colony.id)) {
      if (row.canBuy && row.buyPrice !== null && row.buyPrice <= buyLimit) {
        submit('buy_production', { colonyId: colony.id });
      }
      continue;
    }

    // debt rescue: the strongest unpinned yards mint money until solvent
    if (rank < rescueYards) {
      if (empire.bc < 0 && head0 !== 'trade_goods' && row.buildable.includes('trade_goods')) {
        submit('set_build_queue', { colonyId: colony.id, items: ['trade_goods'] });
      }
      continue;
    }
    if (head0 === 'trade_goods' && empire.bc <= 50) continue; // still digging out

    // settling our own system needs no ship and no fuel — but only a yard
    // that can actually FINISH a colony base gets one prepended (a 1-pop
    // world spent the whole trace stuck on this), and never past the
    // 12-item queue cap (the command would be rejected every turn)
    if (
      w.colonyShips > 0 &&
      realYard &&
      row.queue.length < 12 &&
      row.buildable.includes('colony_base') &&
      !row.queue.includes('colony_base')
    ) {
      submit('set_build_queue', { colonyId: colony.id, items: ['colony_base', ...row.queue] });
      continue;
    }

    // anything the yard cannot finish in ~30 turns is a trap, not a build
    // (the trace showed 1-pop colonies pinned on star_base/colony_ship for
    // 60+ turns): re-decide instead of leaving it. housing/trade_goods never
    // complete, so they are always re-decidable — and colony_base is exempt
    // because the governor itself prepends it on modest yards (a >30-turn
    // base would otherwise be wiped and re-prepended every turn, discarding
    // the queue tail each cycle).
    const redecidable = head0 === 'trade_goods' || head0 === 'housing';
    const stalled =
      !!head0 && !redecidable && head0 !== 'colony_base' && (row.turnsLeft === null || row.turnsLeft > 30);
    const busy = colony.queue.length > 0 && !redecidable && !stalled;
    if (busy) {
      // something is on the slipway: leave it alone, just consider buying it out
      if (row.canBuy && row.buyPrice !== null && row.buyPrice <= buyLimit) {
        submit('buy_production', { colonyId: colony.id });
      }
      continue;
    }

    const options = row.buildable.filter((b) => b !== 'housing' && b !== 'trade_goods' && b !== 'spy');
    if (!options.length) continue;
    const buildings = options
      .filter((b) => !SHIP_BUILDABLES.has(b) && !PROJECT_BUILDABLES.has(b) && !b.startsWith('design:') && !b.startsWith('refit:'))
      .sort((a, b) => {
        const pa = BUILD_ORDER.indexOf(a);
        const pb = BUILD_ORDER.indexOf(b);
        if (pa !== pb) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
        return (itemCost(planned, me, a, colony) ?? 9999) - (itemCost(planned, me, b, colony) ?? 9999);
      });
    const designs = options
      .filter((b) => b.startsWith('design:'))
      .sort((a, b) => (itemCost(planned, me, a, colony) ?? 9999) - (itemCost(planned, me, b, colony) ?? 9999));

    let item: string | undefined;
    if (!realYard && w.pop > 0 && row.buildable.includes('housing') && row.popUnits < row.maxPop) {
      // no real industry yet: people first — everything else can wait
      item = 'housing';
    } else if (w.infra > 0 && colony.buildings.length < 4 && buildings.length) {
      // the human opening: factory/lab/farm before any hull — ship quotas
      // monopolized the only real yard in testing and nothing ever got built
      item = buildings[0];
    } else if (pipeline < wantPipeline && realYard && row.buildable.includes('colony_ship')) {
      item = 'colony_ship';
      pipeline++;
    } else if (realYard && warOrders < wantFleet && designs.length && (cpHeadroom > warOrders - myWarships || empire.bc > 500)) {
      // biggest hull this yard can finish in ~12 turns (the solo bot's rule)
      const budget = (row.output.prodToQueue || 1) * 12;
      const affordable = designs.filter((d) => (itemCost(planned, me, d, colony) ?? Infinity) <= budget);
      item = affordable[affordable.length - 1] ?? designs[0];
      warOrders++;
    } else if (transports < wantTransports && row.buildable.includes('transport')) {
      item = 'transport';
      transports++;
    } else if (
      w.pop > 0 &&
      colony.buildings.length >= 3 &&
      row.buildable.includes('housing') &&
      row.popUnits * 10 < row.maxPop * (3 + w.pop * 0.5)
    ) {
      // pop slider raises the fill level housing chases: 4 → 50%, 10 → 80%
      item = 'housing';
    } else if (w.infra > 0 && buildings.length) {
      item = buildings[0];
    } else if (w.pop > 0 && row.buildable.includes('housing') && row.popUnits + 2 < row.maxPop) {
      item = 'housing';
    } else {
      item = row.buildable.includes('trade_goods') ? 'trade_goods' : options[0];
    }
    if (item && colony.queue[0]?.item !== item) {
      submit('set_build_queue', { colonyId: colony.id, items: [item] });
    }
  }
}
