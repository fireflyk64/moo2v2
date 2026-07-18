# Masters of Onions CPU — Tech Fortress Doctrine (terse spec)

Core loop: find dominant constraint → remove it → re-evaluate → repeat.
Research is the default tool, not the goal. Pivot whenever another action resolves the
current constraint better or captures an expiring opportunity.

## Turn loop
```
update: map, economy, colony roles, enemy models, fleet caps
phase = classify_phase()
constraints = score_all()            # dominant + secondary + 1 monitored risk
opportunities = scan()
actions = generate(dominant, secondary, opportunities, phase)
score each action; pick best
if emergency_override: switch now
elif best >= current * 1.15: switch
else: continue
assign production / research / fleet missions
verify treasury reserve; verify defense coverage; commit
```

## Six core values (what the score components mean)
1. **Constraint relief** — does it remove the current limiting factor? (propulsion→range,
   computers→accuracy, food→pop allocation, spaceport→treasury, fleet→hostile neighbor)
2. **Permanent leverage** — value left after it's done. High: tech, artifact world, ultra
   rich colony, econ leader, mobility, killing an irreplaceable fleet. Low: local advantage,
   soon-obsolete ships, rushing a bad colony, capturing what you can't hold.
3. **Optionality** — future choices created/preserved (BC reserve, drives, central colony,
   an intact fleet).
4. **Opportunity window** — still available later? Persistent: unreachable systems, econ
   tech, internal development. Temporary: leader offers, weak/undefended enemies, diplomacy,
   newly reachable worlds, guardians before a rival claims them.
5. **Risk-adjusted return** — value after losses, delay, retaliation, uncertainty. Never take
   low reward + high risk.
6. **Time to effect** — leader now vs. rush saving turns vs. distant tech vs. colony ship
   (build + travel + development). A closer weaker target can beat a distant better one.

## Action score (0-100, normalize components first)
```
0.30 constraint_relief + 0.20 permanent_leverage + 0.15 optionality
+ 0.15 opportunity_urgency + 0.10 econ_return + 0.10 security
- cost_penalty - risk_penalty - disruption_penalty
```
- cost: BC, production, RP, upkeep, command pts, travel time, pop displacement, opp cost
- risk: expected losses, P(defeat), P(retaliation), P(lose colony), enemy uncertainty, obsolescence
- disruption: abandoning near-done project, moving sole defensive fleet, breaking reserve,
  delaying critical tech, interrupting time-sensitive colony ship

## Anti-thrash
- Hysteresis: switch only if new score ≥ 1.15 × current.
- Min commitment: colony plan 3 turns; research until tech completes; fleet mission until
  arrival/threat change; build until done or urgent override; war until target falls or
  loss threshold.
- Emergency overrides (re-evaluate immediately): enemy fleet in range of valuable colony;
  major leader offer; guardian becomes defeatable; high-value system becomes reachable;
  war declared; fleet destroyed/crippled; critical tech done; treasury < emergency reserve;
  command points negative; new enemy weapon invalidates defense; neighbor loses its fleet;
  invasion route opens/closes.

## Non-goals
No research maxing for its own sake. No colonizing everything. No spending to zero. No
biggest-fleet default. No "bigger hull is better" assumption. No continuing a plan whose
justification vanished. No attacking just because you can. No reacting to every jitter.

## Start classification (after survey) → opening bias
Dimensions: neighborhood planet value, expansion density, neighbor proximity, guardian
density, homeworld economy, research acceleration potential.

| Start type | Bias |
|---|---|
| Open frontier (several decent reachable planets, no close hostile) | expand high, research med, military low, reserve med; colony ships early, best systems first, skip poor planets |
| Sparse isolation (few/poor planets, distant neighbors) | research + propulsion very high, expansion low until range improves, military low; compound internally |
| Contested border (close neighbor, valuable systems between) | fleet readiness high, expansion high, research med, reserve high; strategic > economic colonies; escort colony ships |
| Guardian-rich (multiple guarded high-value systems) | research high, fleet *quality* very high, fleet count low; research toward cheapest clear threshold |
| Rich dense (many strong planets, short hops) | colony production very high; temporarily pivot off pure research; return to research when window closes |
| Weak home system | constraint-specific infra very high, expansion selective, military low, treasury discipline very high; diagnose actual weakness, don't apply generic fix |

## Constraints (score severity, confidence, time-sensitivity, resolutions, cost, post-leverage)
- **Neighborhood value** — no worthwhile colony targets / all valuable planets out of range
  or guarded. Fix: propulsion, range-extension colony, kill guardian, attack blocker,
  delay + compound, diplomacy, shift region.
- **Expansion capacity** — good planets unclaimed, colony ships too slow. Fix: reassign
  production, rush-buy colony ship, more production, better drives, multiple yards,
  suspend low-priority infra.
- **Research** — key techs too slow, enemy out-teching, missing combat multiplier. Fix:
  Research Labs, pop → scientists, food tech to free farmers, research/econ leaders,
  Artifact worlds, stop ship production, rush infra.
- **Production** — buildings/ships take too long, new colonies never become useful. Fix:
  Auto Factories, pop reassign, Rich/Ultra Rich colony, labor leader, rush-buy, specialize
  colonies, avoid big hulls when small platforms suffice.
- **Food/pop allocation** — too many farmers, research stalls despite pop growth.
  Value food tech as research/production tech:
  `value = farmers_freed × best_alternative_output / cost` — build when payback is short.
- **Treasury/liquidity** — can't hire leaders, can't rush, repeatedly hits 0 BC. Fix:
  Spaceports, econ leaders, trade tech, cut maintenance, stop overbuilding, temp tax raise,
  capture econ colonies. BC = ability to respond; keep reserve when flexibility > spending.
- **Combat effectiveness** — can't beat guardian, first-volley damage or hit% too low,
  enemy shields/armor invalidate weapons, platforms die before firing, wins only via
  attrition. Fix: computers, weapons, weapon mods, more platforms, bigger hulls, drives,
  defenses, tactical leaders, better targeting/stance.
- **Mobility** — fleet arrives late, one fleet can't cover empire, enemy picks engagements.
  Fix: drives, navigator leaders, forward colonies, central positioning, less fragmentation,
  second fleet only if mobility alone insufficient.
- **Defense** — key colonies exposed, enemy travel time < friendly response. Fix: reposition,
  mobility, local ships, planetary defense, second fleet, hit enemy staging, abandon Tier 4,
  diplomacy.

## Neighborhood value (0-100)
```
0.25 econ_quality + 0.20 pop_capacity + 0.15 artifact/research + 0.15 strategic_position
+ 0.10 travel_efficiency + 0.10 defensive_geography + 0.05 future_expansion_access
```
Penalize: guardian strength, enemy contest, poor habitability, dev time, long reinforcement,
command-point strain, diplomatic risk.
80-100 critical (secure it) · 60-79 strong (pursue) · 40-59 selective · 20-39 range/defense
only · 0-19 ignore.

## Opportunities (value can expire; constraints don't)
```
Opportunity = 0.25 permanent_reward + 0.20 constraint_relief + 0.15 strategic_position
  + 0.15 window_urgency + 0.10 optionality + 0.10 denial_value + 0.05 immediate_econ
  - risk - diversion_cost
```
- **A Transformational** (artifact world, ultra rich, exceptional leader, exposed enemy
  capital, combat-regime tech, chokepoint): re-evaluate now, may override happy path.
- **B Strong** (rich/gaia colony, defeatable guardian, weak frontier, mobility upgrade,
  high-payback spaceport, useful military leader): pursue if risk controlled.
- **C Convenient**: take only if it doesn't interrupt a stronger plan.
- **D Distraction** (poor colony, ill-fitting expensive leader, war that changes nothing,
  extra fleet after superiority achieved): decline.

## Planets
Roles: research core, production core, treasury hub, food support, colony-ship yard,
frontier anchor, range extension, mixed, temp outpost.
```
Acquisition = 0.25 pop_potential + 0.20 minerals + 0.20 artifact/research
  + 0.15 location + 0.10 immediate_habitability + 0.10 constraint_synergy
```
Penalize dev time, terraform/support need, defense cost, travel, contest, low pop cap, poor
minerals, command points.

Colonize priority: artifact > ultra rich > rich > gaia > large terran/ocean > strategic
node > high-pop normal > range extension > average w/ short payback > poor/tiny only if
required.

Build choice = marginal payoff, not a fixed order:
- Research Lab: pop sufficient, research is dominant constraint, factory delay tolerable,
  research payoff arrives first.
- Auto Factory: production very low, infra can't complete, colony will build ships/colony
  ships, empire needs capacity.
- Hydroponic Farm: frees ≥1 farmer now (or prevents shortage), freed pop becomes
  scientist/worker, short payback.
- Spaceport: treasury below reserve, colony active enough, BC is blocking leaders/rush/
  maintenance.
- Colony Ship: high-value reachable planet unclaimed, window closing, producer can absorb
  delay, no urgent defense project.
- Idle/minimal: capped low-value colony, poor payback, purpose is range/control only.

Rush-buy when: expansion window would be missed; defense prevents major loss; econ building
repays within planning horizon; frees pop for research now; project nearly done and cheap;
treasury stays above emergency reserve after.
Don't rush: low-value colony, weak near-term use, would block an exceptional leader hire,
or it's compensating for bad planning.

## Treasury
Layers: operating cash / opportunity reserve (leaders, colony ships, key infra, guardian
prep, upgrades) / emergency reserve (defense ships, replacements, upkeep, tax avoidance).
`Target reserve = leader allowance + emergency ship allowance + critical rush allowance`
Reference: early 250-400 BC, mid 400-800 BC — scale with income, leader price, ship cost,
threatened fronts, replacement cost, opportunity frequency. Spend below reserve only for
emergencies or Class A opportunities.

## Research priority by binding constraint
- Expansion → range, drives, colony capability, food, pop growth
- Accuracy → computers, targeting, accuracy leaders. High-volume weapons + Auto-Fire become
  far better *after* accuracy is adequate; detect when a computer upgrade crosses a
  combat threshold.
- Damage → weapons that beat known armor/shields, Armor Piercing, heavy mounts, weapon
  density, Battle Pods
- Survivability → Reinforced Hull, shields, armor, mobility, defensive coverage; bigger
  hulls only when small platforms die before contributing
- Economy → labs, factories, food tech, spaceports, pop efficiency, econ leaders
- Mobility → drives, navigation, Helmsman/Navigator leaders, range tech

## Ships
Core rule: build the **smallest fleet that reliably crosses the required threshold**. Then
stop building, return production to economy/research/expansion, preserve ships for
experience, use leaders as multipliers.

Evaluate: platform count, weapons/platform, first-volley kill P, overkill, platform survival
P, initiative, accuracy, range, speed, replacement time, command cost, upkeep, upgrade burden.

Roles: **Alpha Destroyer** (best computer, high-damage forward weapons, AP, Battle Pods,
Reinforced Hull, strong drive, minimal defensive lasers) · **Heavy Cruiser** (when
destroyers can't one-cycle the target, or enemy erases destroyers first) · **Defensive
Interceptor** (360° lasers, point defense, auto-fire, no range dissipation, fast) ·
**Scout** (never scout with combat ships).

Platform-count rule — do NOT assume 2 cruisers > 3 destroyers. Compute per-platform P(kill
an opposing platform in first effective firing cycle):
- ≥80% → prefer more independent firing platforms
- 40-80% → balance platform count and weapon density
- <40% → prefer bigger hulls / sustained firepower / better tech
- If enemy one-shots your small hulls but you can't one-shot theirs → abandon platform-count
  doctrine; fix hull size, defense, accuracy, damage first.

Overkill control: estimate damage needed to kill; assign minimum platforms to exceed it with
confidence; send the rest at other targets; concentrate only under high uncertainty or when
target survival is dangerous.

Fleet scaling: one elite fleet while it can reach and beat local threats on one front.
Second fleet only when travel time, two simultaneous high-value opportunities, or an
offensive would strip the core — and only if neither half drops below its threshold.

Upgrade when it changes first-volley kill P, crosses an accuracy threshold, defeats a
previously resistant defense, materially changes reach, or costs less than replacement.
Never upgrade for small numbers that don't change outcomes.

## Aggression
```
0.25 military_advantage + 0.20 target_value + 0.15 constraint_relief + 0.15 urgency
+ 0.10 enemy_recovery_damage + 0.10 position_gain + 0.05 diplomatic
- expected_attrition - retaliation_risk - diversion_cost
```
85-100 attack (unless it exposes something more valuable) · 70-84 attack if losses low or
window closing · 55-69 prepare/reposition/scout · 40-54 avoid unless defensive · <40 never.

- Guardian: attack when win P acceptable, losses replaceable, protected system valuable,
  fleet still able to defend after, and nothing better needs the fleet. Never attack merely
  because it's beatable — a guardian over a poor system usefully denies it to rivals.
- Enemy fleet: prioritize when it's the main threat to valuable colonies, killing it opens
  expansion, enemy replacement is slow, attrition is low, enemy is split, or reinforcements
  are far.
- Colony: attack when economically/strategically important, holdable, its loss hurts the
  enemy, it adds range/production/research/navigation, and diversion is acceptable. Avoid
  low-value colony grabs that leave the main enemy fleet intact.

Pre-engagement data needed: friendly fleet stats (platforms, weapons/mods/arcs, damage &
hit% by range, shields/armor/structure, speed, initiative, specials, leaders, command &
replacement cost/time, damage, experience); enemy estimates + uncertainty + reinforcement
distance; sim output (win P, expected losses both sides, first-volley damage both ways,
per-platform survival & kill P, duration, retreat P, overkill, ammo, range sensitivity,
variance across seeds, worst/median/best); strategic context (target value, assets
protected, travel & reinforcement times, whether victory opens systems, whether defeat
exposes the core, enemy replaceability, target type, diplomacy).

## Defense
Tiers: **1 Critical** (capital, artifact research center, ultra-rich shipyard, primary
research core, chokepoint, sole range link) · **2 High** (rich production colony, large
developed world, treasury center, shipyard, forward base with dependencies) · **3 Moderate**
· **4 Low** (tiny/poor, temp outpost, isolated undeveloped, defense costs > contribution).

Response: low → continue + monitor · moderate → reposition, delay risky offense, raise
readiness · high → concentrate fleet, rush essential defense, recall offense, protect T1/T2 ·
overwhelming → preserve elite fleet, trade low-value space for time, hold the highest-value
node, seek diplomacy, hit enemy staging if direct defense is impossible.

Never trade the elite fleet for a Tier 4 colony. Trade ships for a Tier 1 colony only if
irreplaceable, loss cascades, losses don't doom you later, and no evacuation/counterattack
exists.

Needs: enemy travel time per colony, friendly response time, pathing, enemy range, tier,
local defense, siege duration, reinforcement availability, P(feint).

## Leaders
```
Leader = 0.30 constraint_fit + 0.20 coverage + 0.20 long_term_return
  + 0.15 immediate_power + 0.10 rarity + 0.05 secondary_utility
  - hire_cost - upkeep - time_until_relevant
```
Never hire just because BC exists. Spy leader long before first contact = hundreds of BC for
nothing. Early Megawealth leader that out-earns upkeep = transformational.
Economic leaders: BC, labor, research, colony development, self-funding. Military leaders:
fleet-wide accuracy, weapons, navigation, speed, survivability, command/ordnance.

## Phases (reference turns; state overrides turn count)
- **Opening 0-30** — survey; answer: what's the neighborhood, what's reachable, how close is
  the neighbor, what's the first binding constraint. Avoid early big fleet, colony spam,
  treasury depletion.
- **Engine 20-60** — research/production infra, food efficiency, first strong colonies, basic
  reserve. Exit: clear path, colonies can finish projects, first threat understood.
- **Access 40-100** — resolve range/neighborhood constraints, selective expansion, start
  combat-threshold research. Exit: valuable systems reachable, first target identified.
- **Combat threshold 70-130** — accuracy, effective weapons, Battle Pods, Reinforced Hull,
  drives, minimal elite fleet. Exit: beats target class with acceptable losses; more ships
  now worth less than economy/research.
- **Capture 100-170** — guardian systems, rich/artifact worlds, weak enemy positions,
  mobility. Exit: strategic depth, fleet operates beyond home neighborhood.
- **Projection 140+** — speed, multiple options, delete enemy fleets, preserve veterans,
  second fleet only if required. Advantage = appearing where leverage is highest.

## Personality modifiers (weight deltas on the shared engine, not separate AIs)
- **Techer**: research leverage +20%, long-term +10%, aggression -10%, pivot threshold higher
- **Rusher**: urgency +20%, enemy-weakness +20%, long-term econ -10%, attrition tolerance
  higher, pivot threshold lower
- **Industrialist**: production +20%, colony dev +15%, rush-buy +10%, research -5%
- **Expander**: neighborhood value +20%, colonization +20%, planet-quality bar lower, fleet
  concentration slightly lower
- **Militarist**: combat readiness +20%, threat elimination +20%, fleet reserve +10%,
  attrition tolerance and treasury reserve higher
- **Random**: score normally, pick randomly among top 3 weighted by score, never below
  minimum safety/viability thresholds

## Data interfaces required
- Map: known/unknown systems, distances, reachability, planet attrs, guardians, colonization
  status, path connections
- Colony: pop/max/growth, food, production, research, BC, morale, buildings, queue, turns
  left, rush cost, richness, habitability, artifact, role, threat
- Empire: BC, income, maintenance, taxes, research, food surplus, production, command points,
  colony/fleet counts, techs known & available, leader roster & offers
- Fleet: location, destination, travel time, groups, designs, damage, readiness, leader,
  strength, reinforcement & replacement time
- Enemy: colonies + value, fleets, observed techs/weapons, est. economy & production,
  diplomatic status, aggression history, reinforcement paths, **confidence per estimate**
- Combat: hit rates, first-volley damage, per-platform kill & survival P, overkill, win P,
  attrition, variance, retreat P, range effects, initiative
- History: past battle outcomes, actual vs predicted losses, enemy design changes, tech
  pacing, opportunity outcomes, failed attacks, guardian thresholds that worked.
  **Update estimates when reality disagrees with prediction.**

## Acceptance tests
1. Sparse start → research + propulsion, no colony-ship spam, small fleet.
2. Rich opening → pivot to colony ships; research continues but doesn't miss the window.
3. Early hostile neighbor → minimum viable fleet, value strategic colonies, don't tech into
   defeat.
4. Guardian over poor system → delay attack, treat as neutral barrier.
5. Guardian over ultra-rich/artifact, beatable → assemble, attack, immediately plan capture.
6. Leader offer: high value + fits constraint + above reserve → hire now; low value / far
   from relevant → decline.
7. 3 destroyers vs 2 cruisers, both one-volley capable → recognize platform-count advantage;
   don't infer cruiser win from structure/weapon totals.
8. Combat superiority achieved, one front → stop building warships, redirect to research/
   economy/mobility/expansion.
9. Low-value colony under overwhelming attack → preserve the fleet.
10. BC blocking leaders/rushes → treat Spaceport as an optionality multiplier, build where
    payback is useful.
