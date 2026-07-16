<script lang="ts">
  // Galaxy map v3 (SVG): proper star glyphs with glow, explored/unexplored fog,
  // fuel-range shading, in-flight fleet markers with travel progress, monster
  // lairs vs Andromedan raids, blockade badges, move ordering with re-routing.
  import { selectors, inRange, isBlockaded, fuelRangeCp, supportStars, areAtWar, shortEntityId } from '@engine/index';
  import type { StarColor } from '@engine/types';
  import { MAP_SIZE } from '@engine/galaxy';
  import { playerColor, STAR_COLORS } from '../colors';
  import { app, getActive } from '../state.svelte';

  const MAP_BG_CACHE = new Map<string, string>();

  function hashText(s: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(seed: number): () => number {
    let t = seed >>> 0;
    return () => {
      t = (t + 0x6d2b79f5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeGalaxyBackground(seedText: string, w: number, h: number): string {
    const seed = hashText(seedText);
    const rnd = mulberry32(seed);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    // deep-space base + soft center glow
    ctx.fillStyle = '#03050d';
    ctx.fillRect(0, 0, w, h);
    const core = ctx.createRadialGradient(w * 0.52, h * 0.44, 0, w * 0.52, h * 0.44, Math.max(w, h) * 0.64);
    core.addColorStop(0, 'rgba(60,78,140,0.22)');
    core.addColorStop(1, 'rgba(4,6,14,0)');
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, w, h);

    // broad spiral-arm haze using stamped radial blobs (cheap one-time draw)
    const cx = w * (0.45 + rnd() * 0.1);
    const cy = h * (0.46 + rnd() * 0.08);
    const armCount = 3;
    const armTurns = 2.1 + rnd() * 0.7;
    const maxR = Math.min(w, h) * (0.47 + rnd() * 0.07);
    for (let arm = 0; arm < armCount; arm++) {
      const armPhase = (Math.PI * 2 * arm) / armCount + rnd() * 0.25;
      for (let i = 0; i < 220; i++) {
        const t = i / 220;
        const th = armPhase + t * Math.PI * armTurns;
        const r = t * maxR + (rnd() - 0.5) * 38;
        const x = cx + Math.cos(th) * r;
        const y = cy + Math.sin(th) * r * (0.72 + rnd() * 0.16);
        const rr = 14 + rnd() * 44;
        const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
        g.addColorStop(0, `rgba(${80 + Math.floor(rnd() * 40)},${95 + Math.floor(rnd() * 45)},${150 + Math.floor(rnd() * 60)},${0.03 + rnd() * 0.05})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - rr, y - rr, rr * 2, rr * 2);
      }
    }

    // colorful nebulas: clustered translucent blobs
    const nebColors = [
      [168, 74, 62],
      [90, 62, 156],
      [58, 118, 148],
      [142, 76, 124],
    ] as const;
    const nebulaCount = 4;
    for (let n = 0; n < nebulaCount; n++) {
      const px = w * (0.12 + rnd() * 0.76);
      const py = h * (0.12 + rnd() * 0.76);
      const [cr, cg, cb] = nebColors[Math.floor(rnd() * nebColors.length)]!;
      for (let k = 0; k < 14; k++) {
        const ox = (rnd() - 0.5) * 170;
        const oy = (rnd() - 0.5) * 120;
        const rr = 38 + rnd() * 110;
        const a = 0.04 + rnd() * 0.08;
        const g = ctx.createRadialGradient(px + ox, py + oy, 0, px + ox, py + oy, rr);
        g.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(px + ox - rr, py + oy - rr, rr * 2, rr * 2);
      }
    }

    // dense but subtle star sprinkle (single-pixel only)
    const starCount = Math.floor((w * h) / 380);
    for (let i = 0; i < starCount; i++) {
      const x = Math.floor(rnd() * w);
      const y = Math.floor(rnd() * h);
      const b = rnd();
      const alpha = 0.06 + b * 0.28;
      const tint = rnd();
      if (tint < 0.12) ctx.fillStyle = `rgba(255,225,190,${alpha})`;
      else if (tint > 0.9) ctx.fillStyle = `rgba(190,215,255,${alpha})`;
      else ctx.fillStyle = `rgba(240,246,255,${alpha})`;
      ctx.fillRect(x, y, 1, 1);
    }

    // vignette to keep focus toward map center
    const vg = ctx.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.28, w * 0.5, h * 0.5, Math.max(w, h) * 0.82);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(2,3,8,0.5)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);

    return canvas.toDataURL('image/png');
  }

  const session = () => getActive()!.session;
  const gs = $derived.by(() => {
    void app.version;
    return session().getPlanned();
  });
  const me = () => session().playerId;
  const foeName = (id: number) => gs?.empires.find((e) => e.id === id)?.raceName ?? `#${id}`;
  const view = $derived.by(() => (gs ? selectors.galaxyView(gs, me()) : []));
  const fleets = $derived.by(() => (gs ? selectors.fleetRows(gs, me()) : []));
  const reachable = $derived.by(() => {
    if (!gs) return new Set<number>();
    const out = new Set<number>();
    for (const star of gs.stars) {
      if (inRange(gs, me(), star)) out.add(star.id);
    }
    return out;
  });
  const monstersByStar = $derived.by(() => {
    const m = new Map<number, string[]>();
    if (!gs) return m;
    for (const mon of gs.monsters) {
      m.set(mon.starId, [...(m.get(mon.starId) ?? []), mon.kind]);
    }
    return m;
  });
  const isRaid = (kinds: string[] | undefined) => (kinds ?? []).some((k) => k.startsWith('antaran_'));
  const blockadedStars = $derived.by(() => {
    const out = new Set<number>();
    if (!gs) return out;
    for (const c of gs.colonies) {
      if (c.owner !== me() || c.outpost) continue;
      if (isBlockaded(gs, c)) {
        const p = gs.planets.find((x) => x.id === c.planetId);
        if (p) out.add(p.starId);
      }
    }
    return out;
  });
  /** fuel-range envelope: circles around every colony/outpost star */
  let showRange = $state(true);

  /** map zoom mode: 'fit' shows the whole galaxy, 'zoom' is a scrollable
   * close-up. Persisted so a reload keeps the chosen view (bugs.md). */
  let mapZoom = $state<'fit' | 'zoom'>(
    typeof localStorage !== 'undefined' && localStorage.getItem('moo2.mapZoom') === 'zoom' ? 'zoom' : 'fit',
  );
  const MIN_SCALE = 0.2;
  const MAX_SCALE = 2.4;
  const clampScale = (s: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
  const clampFitScale = (s: number) => Math.min(MAX_SCALE, s);
  let mapScale = $state<number>((() => {
    if (typeof localStorage === 'undefined') return 0.85;
    const raw = Number(localStorage.getItem('moo2.mapScale') ?? '0.85');
    return Number.isFinite(raw) ? clampScale(raw) : 0.85;
  })());
  let fitScale = $state(1);
  const mapDims = $derived(gs ? MAP_SIZE[gs.settings.galaxySize] : { w: 2000, h: 1500 });
  const renderScale = $derived(mapZoom === 'fit' ? fitScale : mapScale);
  let mapBgUrl = $state('');
  const mapSvgStyle = $derived.by(() => {
    const base = `width:${Math.round(mapDims.w * renderScale)}px;max-width:none`;
    if (!mapBgUrl) return base;
    return `${base};background-image:url(${mapBgUrl});background-size:cover;background-position:center`;
  });

  function recomputeFitScale() {
    if (!mapScroller) return;
    const w = Math.max(1, mapScroller.clientWidth);
    const h = Math.max(1, mapScroller.clientHeight);
    fitScale = clampFitScale(Math.min(w / mapDims.w, h / mapDims.h));
  }

  function persistMapZoom() {
    try {
      localStorage.setItem('moo2.mapZoom', mapZoom);
      localStorage.setItem('moo2.mapScale', String(mapScale));
    } catch {
      // private mode: zoom still works for this session
    }
  }

  function toggleMapZoom() {
    if (mapZoom === 'fit') {
      mapZoom = 'zoom';
      // start zoom mode exactly from fit scale (no visible jump)
      mapScale = fitScale;
    } else {
      mapZoom = 'fit';
    }
    persistMapZoom();
  }

  function onMapWheel(ev: WheelEvent) {
    // Keep browser/page zoom intact globally; only intercept Ctrl/Cmd wheel
    // while hovering the galaxy map and apply it to map zoom instead.
    if (!ev.ctrlKey && !ev.metaKey) return;
    ev.preventDefault();
    const dir = ev.deltaY < 0 ? 1 : -1;
    const step = ev.shiftKey ? 0.16 : 0.08;

    let focusX = 0;
    let focusY = 0;
    let contentX = 0;
    let contentY = 0;
    if (mapScroller) {
      const rect = mapScroller.getBoundingClientRect();
      focusX = Math.max(0, Math.min(mapScroller.clientWidth, ev.clientX - rect.left));
      focusY = Math.max(0, Math.min(mapScroller.clientHeight, ev.clientY - rect.top));
      contentX = mapScroller.scrollLeft + focusX;
      contentY = mapScroller.scrollTop + focusY;
    }

    let oldScale = mapZoom === 'fit' ? fitScale : mapScale;
    if (mapZoom === 'fit') {
      // wheel-in from fit enters zoom mode seamlessly at the same scale
      if (dir < 0) return;
      mapZoom = 'zoom';
      mapScale = fitScale;
      oldScale = fitScale;
    }

    const nextScale = clampScale(oldScale + dir * step);

    // Unified end-state: zooming out to the fit scale snaps to fit mode.
    if (dir < 0 && nextScale <= fitScale + 0.0005) {
      mapScale = fitScale;
      mapZoom = 'fit';
      persistMapZoom();
      return;
    }

    if (nextScale === oldScale) {
      persistMapZoom();
      return;
    }

    mapScale = nextScale;
    persistMapZoom();

    if (mapScroller) {
      const ratio = nextScale / oldScale;
      requestAnimationFrame(() => {
        if (!mapScroller) return;
        const maxLeft = Math.max(0, mapScroller.scrollWidth - mapScroller.clientWidth);
        const maxTop = Math.max(0, mapScroller.scrollHeight - mapScroller.clientHeight);
        const left = contentX * ratio - focusX;
        const top = contentY * ratio - focusY;
        mapScroller.scrollLeft = Math.max(0, Math.min(maxLeft, left));
        mapScroller.scrollTop = Math.max(0, Math.min(maxTop, top));
      });
    }
  }

  let mapScroller = $state<HTMLDivElement | null>(null);
  let panning = $state(false);
  let panPointerId = -1;
  let panCandidate = false;
  let panStartX = 0;
  let panStartY = 0;
  let panStartLeft = 0;
  let panStartTop = 0;
  let suppressClickUntil = 0;

  function onMapPointerDown(ev: PointerEvent) {
    if (mapZoom !== 'zoom' || ev.button !== 0 || !mapScroller) return;
    panCandidate = true;
    panning = false;
    panPointerId = ev.pointerId;
    panStartX = ev.clientX;
    panStartY = ev.clientY;
    panStartLeft = mapScroller.scrollLeft;
    panStartTop = mapScroller.scrollTop;
  }

  function onMapPointerMove(ev: PointerEvent) {
    if (ev.pointerId !== panPointerId || !panCandidate || !mapScroller) return;
    const dx = ev.clientX - panStartX;
    const dy = ev.clientY - panStartY;
    if (!panning) {
      if (Math.abs(dx) + Math.abs(dy) <= 4) return;
      panning = true;
      suppressClickUntil = Date.now() + 140;
      mapScroller.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    }
    mapScroller.scrollLeft = panStartLeft - dx;
    mapScroller.scrollTop = panStartTop - dy;
  }

  function endMapPan(ev?: PointerEvent) {
    if (!mapScroller || (ev && ev.pointerId !== panPointerId)) return;
    if (ev && mapScroller.hasPointerCapture(ev.pointerId)) {
      mapScroller.releasePointerCapture(ev.pointerId);
    }
    panCandidate = false;
    panning = false;
    panPointerId = -1;
  }
  $effect(() => {
    void mapDims.w;
    void mapDims.h;
    requestAnimationFrame(() => recomputeFitScale());
  });
  $effect(() => {
    if (!mapScroller) return;
    if (typeof ResizeObserver === 'undefined') {
      requestAnimationFrame(() => recomputeFitScale());
      return;
    }
    const ro = new ResizeObserver(() => recomputeFitScale());
    ro.observe(mapScroller);
    requestAnimationFrame(() => recomputeFitScale());
    return () => ro.disconnect();
  });
  $effect(() => {
    if (!gs || typeof document === 'undefined') {
      mapBgUrl = '';
      return;
    }
    const texW = Math.max(900, Math.min(2048, Math.round(mapDims.w * 0.55)));
    const texH = Math.max(700, Math.min(1536, Math.round(mapDims.h * 0.55)));
    const key = `${JSON.stringify(gs.seed)}:${mapDims.w}x${mapDims.h}:${texW}x${texH}`;
    const cached = MAP_BG_CACHE.get(key);
    if (cached) {
      mapBgUrl = cached;
      return;
    }
    const url = makeGalaxyBackground(key, texW, texH);
    if (url) {
      MAP_BG_CACHE.set(key, url);
      mapBgUrl = url;
    }
  });
  const rangeCircles = $derived.by(() => {
    if (!gs || !showRange) return [];
    const empire = gs.empires.find((e) => e.id === me());
    if (!empire) return [];
    const r = Math.min(fuelRangeCp(empire), 4000);
    return supportStars(gs, me()).map((s) => ({ x: s.x, y: s.y, r }));
  });

  let selectedStarId = $state<number | null>(null);
  let selectedShipIds = $state<number[]>([]);
  // colony-ship arrival alert: "View on map" hands us the star to select
  $effect(() => {
    if (app.focusStarId !== null) {
      selectedStarId = app.focusStarId;
      app.focusStarId = null;
    }
  });
  // the fleets explainer shows until dismissed once (then never again)
  let showFleetTip = $state(localStorage.getItem('moo2.tip.fleets') !== '0');
  function dismissFleetTip() {
    showFleetTip = false;
    localStorage.setItem('moo2.tip.fleets', '0');
  }

  const selected = $derived(view.find((v) => v.star.id === selectedStarId) ?? null);
  const shipsHere = $derived(fleets.filter((f) => f.atStarId === selectedStarId));
  /** wormhole partner of the selected star: always a valid move target —
   * but only shown once the wormhole itself is known (visited/scanned) */
  const wormholeTarget = $derived.by(() => {
    if (!gs || selectedStarId === null) return null;
    const sv = view.find((v) => v.star.id === selectedStarId);
    return sv?.wormholeVisible ? sv.star.wormholeTo : null;
  });

  /** own fleets in flight (or ordered this turn): marker at progress point */
  const transits = $derived.by(() => {
    if (!gs) return [];
    const starAt = (id: number) => gs.stars.find((s) => s.id === id);
    const out: Array<{
      id: number;
      name: string;
      x: number;
      y: number;
      tx: number;
      ty: number;
      angle: number;
      eta: number;
      reroutable: boolean;
    }> = [];
    let lane = 0;
    for (const f of fleets) {
      if (!f.transit) continue;
      const from = starAt(f.transit.fromStarId);
      const to = starAt(f.transit.toStarId);
      if (!from || !to) continue;
      const total = Math.max(1, f.transit.arrivalTurn - f.transit.departedTurn);
      const p = Math.max(0.06, Math.min(0.94, (gs.turn - f.transit.departedTurn) / total));
      // spread overlapping fleets on the same lane a little
      const off = (lane++ % 3) * 14 - 14;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len = Math.max(1, Math.hypot(dx, dy));
      const nx = -dy / len;
      const ny = dx / len;
      out.push({
        id: f.ship.id,
        name: f.name,
        x: from.x + dx * p + nx * off,
        y: from.y + dy * p + ny * off,
        tx: to.x,
        ty: to.y,
        angle: (Math.atan2(dy, dx) * 180) / Math.PI,
        eta: Math.max(1, f.transit.arrivalTurn - gs.turn),
        reroutable: f.reroutable,
      });
    }
    return out;
  });

  /** enemy empires with ships at the selected star that we are NOT at war with */
  const peacefulForeigners = $derived.by(() => {
    if (!gs || !selected) return [];
    const owners = [...new Set(selected.ships.map((s) => s.owner))].filter((o) => o !== me() && o >= 0);
    return owners
      .filter((o) => !areAtWar(gs, me(), o))
      .map((o) => gs.empires.find((e) => e.id === o)?.name ?? `#${o}`);
  });

  /** transient move/settle feedback: silent failures read as a dead UI */
  let mapNote = $state('');
  let mapNoteTimer: ReturnType<typeof setTimeout> | null = null;
  function showNote(text: string) {
    mapNote = text;
    if (mapNoteTimer) clearTimeout(mapNoteTimer);
    mapNoteTimer = setTimeout(() => (mapNote = ''), 6000);
  }

  function clickStar(starId: number) {
    if (Date.now() < suppressClickUntil) return;
    if (selectedShipIds.length > 0 && selectedStarId !== starId) {
      // prune ships that no longer exist (destroyed in a battle) so a stale
      // selection can't wedge star selection with endless invalid moves
      const live = new Set(fleets.map((f) => f.ship.id));
      selectedShipIds = selectedShipIds.filter((id) => live.has(id));
      if (selectedShipIds.length > 0) {
        const res = session().submit('move_ships', { shipIds: selectedShipIds, destStarId: starId });
        if (!res.error) selectedShipIds = [];
        else showNote(`⛔ ${res.error}`);
        return;
      }
    }
    selectedStarId = starId;
  }

  function toggleShip(id: number) {
    selectedShipIds = selectedShipIds.includes(id)
      ? selectedShipIds.filter((x) => x !== id)
      : [...selectedShipIds, id];
  }

  // ---- fleet-selection hotkeys (bugs.md: ordering ships around was a
  // checkmark game). A = select all / none at the selected star; Backspace
  // cycles ship1 -> ship2 -> ... -> all, for peeling single ships off fast.
  function selectAllShips() {
    const ids = shipsHere.map((f) => f.ship.id);
    const allIn = ids.length > 0 && ids.every((id) => selectedShipIds.includes(id));
    selectedShipIds = allIn ? [] : ids;
  }
  function cycleShipSelection() {
    const ids = shipsHere.map((f) => f.ship.id);
    if (!ids.length) return;
    const idx = selectedShipIds.length === 1 ? ids.indexOf(selectedShipIds[0]!) : -1;
    if (idx >= 0 && idx < ids.length - 1) selectedShipIds = [ids[idx + 1]!];
    else if (idx === ids.length - 1) selectedShipIds = [...ids];
    else selectedShipIds = [ids[0]!];
  }
  function onMapKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (typing || !shipsHere.length) return;
    if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      selectAllShips();
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      cycleShipSelection();
    }
  }

  function colonize(shipId: number, planetId: number) {
    const res = session().submit('colonize', { shipId, planetId });
    if (res.error) showNote(`⛔ ${res.error}`);
  }
  function outpost(shipId: number, planetId: number) {
    const res = session().submit('build_outpost', { shipId, planetId });
    if (res.error) showNote(`⛔ ${res.error}`);
  }

  // ---- star rename (needs a settlement in the system) ----
  let renamingStar = $state(false);
  let renameStarText = $state('');
  const focusNow = (el: HTMLElement) => el.focus();
  const canRenameSelected = $derived.by(() => {
    if (!gs || !selected) return false;
    return gs.colonies.some((c) => {
      if (c.owner !== me()) return false;
      const p = gs.planets.find((x) => x.id === c.planetId);
      return p?.starId === selected.star.id;
    });
  });
  function startStarRename() {
    if (!selected) return;
    renamingStar = true;
    renameStarText = selected.star.name;
  }
  function commitStarRename() {
    if (!renamingStar || !selected) return;
    const name = renameStarText.trim();
    if (name && name !== selected.star.name) {
      session().submit('rename_star', { starId: selected.star.id, name });
    }
    renamingStar = false;
  }

  /** wormhole pairs (drawn once each) — only after an endpoint was visited
   * or lies in the scanner envelope; the fog must not leak the shortcuts */
  const wormholeLinks = $derived.by(() => {
    if (!gs) return [];
    const out: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    for (const sv of view) {
      const s = sv.star;
      if (s.wormholeTo !== null && s.wormholeTo > s.id && sv.wormholeVisible) {
        const t = gs.stars.find((x) => x.id === s.wormholeTo);
        if (t) out.push({ x1: s.x, y1: s.y, x2: t.x, y2: t.y });
      }
    }
    return out;
  });

  /** per-star fleet markers: military vs civilian, sized by ship count */
  function fleetMarks(ships: Array<{ owner: number; kind: string }>): Array<{ owner: number; mil: number; civ: number }> {
    const byOwner = new Map<number, { owner: number; mil: number; civ: number }>();
    for (const s of ships) {
      const e = byOwner.get(s.owner) ?? { owner: s.owner, mil: 0, civ: 0 };
      if (s.kind === 'design') e.mil++;
      else e.civ++;
      byOwner.set(s.owner, e);
    }
    return [...byOwner.values()].sort((a, b) => a.owner - b.owner);
  }
  const markSize = (n: number) => 10 + Math.round(5 * Math.sqrt(n));

  const CLIMATE_COLORS: Record<string, string> = {
    gaia: '#5ee08a', terran: '#6cc862', arid: '#d8bb6a', swamp: '#7aa85a', ocean: '#4da3ff',
    tundra: '#bcd7e8', desert: '#e0a35e', barren: '#8f8a80', energized: '#c78bff', hostile: '#ff6b5e',
  };

  // ---- little worlds (bugs.md: "worlds in system view should look nicer") ----
  // each planet gets a shaded globe with climate-specific surface details and
  // a deterministic per-planet variant, instead of a flat color disc
  function mixHex(a: string, b: string, t: number): string {
    const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
    const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
    return `#${pa.map((v, i) => Math.round(v + (pb[i]! - v) * t).toString(16).padStart(2, '0')).join('')}`;
  }
  interface WorldLook {
    base: string;
    light: string;
    dark: string;
    detail: string;
    pattern: 'seas' | 'bands' | 'craters' | 'ice';
    cap: boolean;
    /** deterministic tweak 0..3 shifting the detail placement */
    v: number;
  }
  const CLIMATE_PATTERNS: Record<string, Array<WorldLook['pattern']>> = {
    gaia: ['seas'], terran: ['seas'], ocean: ['seas'], swamp: ['seas', 'bands'],
    arid: ['bands', 'craters'], desert: ['bands', 'craters'], tundra: ['ice', 'craters'],
    barren: ['craters'], energized: ['bands', 'seas'], hostile: ['craters', 'bands'],
  };
  const DETAIL_TINT: Record<string, string> = {
    gaia: '#2f8f5a', terran: '#3f7fbf', ocean: '#2c6cc0', swamp: '#4d7a3a',
    arid: '#a8843c', desert: '#b07a3a', tundra: '#8fb8d8', barren: '#5d5a52',
    energized: '#8f5fd0', hostile: '#b03a30',
  };
  function worldLook(p: { id: number; climate: string }): WorldLook {
    const base = CLIMATE_COLORS[p.climate] ?? '#999';
    const h = ((p.id * 2654435761) >>> 0) % 1024;
    const patterns = CLIMATE_PATTERNS[p.climate] ?? ['craters'];
    return {
      base,
      light: mixHex(base, '#ffffff', 0.35),
      dark: mixHex(base, '#000000', 0.45),
      detail: DETAIL_TINT[p.climate] ?? mixHex(base, '#000000', 0.3),
      pattern: patterns[h % patterns.length]!,
      cap: p.climate === 'tundra' || p.climate === 'terran' || p.climate === 'gaia' ? h % 3 !== 0 : h % 5 === 0,
      v: h % 4,
    };
  }
  function mineralRing(m: string): { stroke: string; width: number; dash: string } | null {
    if (m === 'ultra_rich') return { stroke: '#ffd75e', width: 2.5, dash: '' };
    if (m === 'rich') return { stroke: '#ffd75e', width: 1.5, dash: '' };
    if (m === 'poor') return { stroke: '#777f9d', width: 1.2, dash: '3 3' };
    if (m === 'ultra_poor') return { stroke: '#565d78', width: 1.2, dash: '2 4' };
    return null;
  }

  interface StarVisual {
    spectral: string;
    common: string;
    coreR: number;
    coronaR: number;
    spikeLen: number;
    spikeCount: number;
    spikeAlpha: number;
    glow: number;
    hotCoreTint: number;
  }

  const STAR_VISUALS: Record<StarColor, StarVisual> = {
    // Approximate real classes by map color: hotter stars are larger + spikier.
    blue: { spectral: 'O/B', common: 'blue giant', coreR: 8.2, coronaR: 19, spikeLen: 25, spikeCount: 4, spikeAlpha: 0.48, glow: 0.28, hotCoreTint: 0.42 },
    white: { spectral: 'A/F', common: 'white main sequence', coreR: 7.5, coronaR: 17, spikeLen: 22, spikeCount: 4, spikeAlpha: 0.42, glow: 0.24, hotCoreTint: 0.36 },
    yellow: { spectral: 'G', common: 'yellow dwarf', coreR: 6.9, coronaR: 15, spikeLen: 18, spikeCount: 3, spikeAlpha: 0.32, glow: 0.2, hotCoreTint: 0.3 },
    orange: { spectral: 'K', common: 'orange dwarf/giant', coreR: 6.2, coronaR: 13.5, spikeLen: 14, spikeCount: 2, spikeAlpha: 0.2, glow: 0.16, hotCoreTint: 0.24 },
    red: { spectral: 'M', common: 'red dwarf/giant', coreR: 5.8, coronaR: 12.5, spikeLen: 11, spikeCount: 2, spikeAlpha: 0.15, glow: 0.14, hotCoreTint: 0.18 },
    brown: { spectral: 'L/T', common: 'brown dwarf', coreR: 5.1, coronaR: 10.5, spikeLen: 0, spikeCount: 0, spikeAlpha: 0, glow: 0.09, hotCoreTint: 0.12 },
    black_hole: { spectral: 'X', common: 'black hole', coreR: 0, coronaR: 0, spikeLen: 0, spikeCount: 0, spikeAlpha: 0, glow: 0, hotCoreTint: 0 },
  };

  const SPIKE_ANGLES: Record<StarColor, number[]> = {
    blue: [0, 45, 90, 135],
    white: [0, 45, 90, 135],
    yellow: [0, 60, 120],
    orange: [0, 90],
    red: [0, 90],
    brown: [],
    black_hole: [],
  };

  function starClassText(color: StarColor): string {
    const v = STAR_VISUALS[color];
    return color === 'black_hole' ? 'black hole' : `${v.spectral}-class ${v.common}`;
  }

  function starSpikeStroke(color: StarColor): string {
    return mixHex(STAR_COLORS[color], '#ffffff', color === 'blue' ? 0.62 : 0.5);
  }
  const prettify = (id: string) => id.replaceAll('_', ' ');
</script>

<svelte:window onkeydown={onMapKey} />

<div class="wrap">
  <div class="mapcol">
    {#if mapNote}
      <div class="mapnote" data-testid="map-note">{mapNote}</div>
    {/if}
    <div
      class="scroller"
      class:zoomed={mapZoom === 'zoom'}
      class:dragging={panning}
      role="region"
      aria-label="Galaxy map viewport"
      bind:this={mapScroller}
      onpointerdown={onMapPointerDown}
      onpointermove={onMapPointerMove}
      onpointerup={endMapPan}
      onpointercancel={endMapPan}
    >
    <svg
      viewBox="0 0 {mapDims.w} {mapDims.h}"
      data-testid="galaxy-map"
      data-allow-ctrl-wheel-zoom="true"
      onwheel={onMapWheel}
      style={mapSvgStyle}
    >
      <defs>
        <filter id="starglow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="starsoft" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="2.8" />
        </filter>
      </defs>

      <!-- fuel range as ONE muted territory in the player color: solid circles
           inside a group whose opacity applies AFTER compositing, so overlaps
           never darken and the union reads as a single region -->
      <g class="territory" style="fill:{playerColor(me())}">
        {#each rangeCircles as rc, i (i)}
          <circle cx={rc.x} cy={rc.y} r={rc.r} />
        {/each}
      </g>

      {#each wormholeLinks as wl, i (i)}
        <line x1={wl.x1} y1={wl.y1} x2={wl.x2} y2={wl.y2} class="wormhole">
          <title>wormhole — 1 turn transit either way</title>
        </line>
      {/each}

      {#each transits as t (t.id)}
        <line x1={t.x} y1={t.y} x2={t.tx} y2={t.ty} class="route" style="stroke:{playerColor(me())}" />
        <g transform="translate({t.x},{t.y}) rotate({t.angle})">
          <!-- in-flight ships wear the same player color as everything else;
               re-routable fleets keep the yellow fill as the affordance -->
          <polygon points="18,0 -12,-11 -6,0 -12,11" class="fleetmark" class:reroutable={t.reroutable} style="fill:{t.reroutable ? '' : playerColor(me())}" />
        </g>
        <text x={t.x} y={t.y - 18} text-anchor="middle" class="eta" fill={playerColor(me())}>{t.name} · {t.eta}t</text>
      {/each}

      {#each view as v (v.star.id)}
        {@const kinds = monstersByStar.get(v.star.id)}
        {@const sv = STAR_VISUALS[v.star.color]}
        {@const scale = v.explored ? 1 : 0.82}
        <g
          class="star"
          role="button"
          tabindex="0"
          onclick={() => clickStar(v.star.id)}
          onkeydown={(e) => e.key === 'Enter' && clickStar(v.star.id)}
          transform="translate({v.star.x},{v.star.y})"
        >
          <title>
            {v.star.name}
            {' — ' + starClassText(v.star.color)}
            {v.explored ? '' : ' — unexplored'}
            {reachable.has(v.star.id) ? '' : ' — out of fuel range'}
          </title>
          <!-- invisible hit target so the whole star area is clickable -->
          <circle r="30" fill="transparent" stroke="none" />
          {#if v.star.id === selectedStarId}
            <circle r="36" class="selring" />
          {/if}
          {#if selectedShipIds.length > 0 && v.star.id !== selectedStarId && (reachable.has(v.star.id) || v.star.id === wormholeTarget)}
            <circle r="30" class="target" />
          {/if}
          {#if !reachable.has(v.star.id)}
            <circle r="26" class="norange" />
          {/if}
          {#if v.star.color === 'black_hole'}
            <ellipse rx="16" ry="7.2" fill="none" stroke="#704c8a" stroke-width="2.6" opacity={v.explored ? 0.78 : 0.45} transform="rotate(-24)" />
            <ellipse rx="13.2" ry="6" fill="none" stroke="#ad89d9" stroke-width="1.2" opacity={v.explored ? 0.58 : 0.32} transform="rotate(-24)" />
            <circle r="8.4" fill="#02030a" stroke="#8a76b5" stroke-width="2.2" opacity={v.explored ? 1 : 0.5} />
            <circle r="4.4" fill="#000000" />
          {:else}
            <circle
              r={sv.coronaR}
              fill={mixHex(STAR_COLORS[v.star.color], '#ffffff', sv.hotCoreTint * 0.5)}
              opacity={v.explored ? sv.glow : Math.max(0.07, sv.glow * 0.5)}
              filter={v.explored ? 'url(#starglow)' : 'url(#starsoft)'}
            />
            <circle
              r={sv.coreR * 1.06 * scale}
              fill={STAR_COLORS[v.star.color]}
              opacity={v.explored ? 0.95 : 0.42}
            />
            <circle
              r={sv.coreR * 0.56 * scale}
              fill={mixHex(STAR_COLORS[v.star.color], '#ffffff', sv.hotCoreTint)}
              opacity={v.explored ? 0.88 : 0.5}
            />
            {#if sv.spikeCount > 0}
              {#each SPIKE_ANGLES[v.star.color] as ang, ai (ai)}
                <line
                  x1={-sv.spikeLen * scale}
                  y1="0"
                  x2={sv.spikeLen * scale}
                  y2="0"
                  stroke={starSpikeStroke(v.star.color)}
                  stroke-width={ang % 90 === 0 ? 1.45 : 1.05}
                  opacity={v.explored ? sv.spikeAlpha : sv.spikeAlpha * 0.45}
                  transform="rotate({ang})"
                  stroke-linecap="round"
                />
              {/each}
            {/if}
          {/if}
          {#if !v.explored}
            <circle r="21" class="fog" />
            <text y="7" text-anchor="middle" class="unknown">?</text>
          {/if}
          {#each v.colonies.filter((c) => !c.outpost) as c, i (c.id)}
            <circle r={22 + i * 5} fill="none" stroke={playerColor(c.owner)} stroke-width="3" opacity="0.9" />
          {/each}
          {#each fleetMarks(v.ships) as fm, i (fm.owner)}
            {@const y0 = -14 + i * 26}
            {#if fm.mil > 0}
              {@const s = markSize(fm.mil)}
              <polygon
                points="20,{y0} {20 + s},{y0 + s / 2} 20,{y0 + s}"
                fill={playerColor(fm.owner)}
                stroke="#05070f"
                stroke-width="1.5"
              >
                <title>{fm.mil} warship{fm.mil > 1 ? 's' : ''}</title>
              </polygon>
              {#if fm.mil > 1}
                <text x={22 + s} y={y0 + s / 2 + 6} class="count" fill={playerColor(fm.owner)}>{fm.mil}</text>
              {/if}
            {/if}
            {#if fm.civ > 0}
              {@const s = markSize(fm.civ)}
              {@const yc = y0 + (fm.mil > 0 ? 16 : 0)}
              <polygon
                points="20,{yc} {20 + s},{yc + s / 2} 20,{yc + s}"
                fill="none"
                stroke={playerColor(fm.owner)}
                stroke-width="2.5"
              >
                <title>{fm.civ} civilian ship{fm.civ > 1 ? 's' : ''} (scouts/colony/transport)</title>
              </polygon>
              {#if fm.civ > 1}
                <text x={22 + s} y={yc + s / 2 + 6} class="count" fill={playerColor(fm.owner)}>{fm.civ}</text>
              {/if}
            {/if}
          {/each}
          {#if v.explored && kinds}
            {#if isRaid(kinds)}
              <text y="-24" text-anchor="middle" class="raid">⚠</text>
            {:else}
              <text y="-24" text-anchor="middle" class="monster">☠</text>
            {/if}
          {/if}
          {#if blockadedStars.has(v.star.id)}
            <text x="-32" y="7" text-anchor="middle" class="blockade">⚓</text>
          {/if}
          <text y="38" text-anchor="middle" class="label" class:dimlabel={!v.explored}>{v.star.name}</text>
          {#if v.explored && v.planets.length}
            {@const bodies = v.planets.slice(0, 6)}
            {#each bodies as p, bi (p.id)}
              {@const bx = (bi - (bodies.length - 1) / 2) * 9}
              {#if p.body === 'planet'}
                {@const col = v.colonies.find((c) => gs?.colonies.find((x) => x.id === c.id)?.planetId === p.id)}
                <circle cx={bx} cy="50" r="2.4" fill={col ? playerColor(col.owner) : '#6a7288'}>
                  <title>{p.climate} planet{col ? ` — ${col.name}` : ' (uncolonized)'}</title>
                </circle>
              {:else}
                <text x={bx} y="53" text-anchor="middle" class="bodyx"><title>{p.body === 'asteroids' ? 'asteroid belt' : 'gas giant'}</title>×</text>
              {/if}
            {/each}
          {/if}
        </g>
      {/each}
    </svg>
    </div>
    <div class="legend">
      <button
        class="zoombtn"
        data-testid="map-zoom-toggle"
        title="toggle between fitting the whole galaxy and a scrollable close-up"
        onclick={toggleMapZoom}
      >{mapZoom === 'fit' ? '🔍 zoom in' : '🗺 fit galaxy'}</button>
      <label><input type="checkbox" bind:checked={showRange} /> fuel range</label>
      <span><span class="sw" style="border-color:#5a3030"></span> dashed ring = out of range</span>
      <span class="dimtext">◐ faded star = unexplored</span>
      <span><span class="monster">☠</span> monster lair</span>
      <span><span class="raid">⚠</span> Andromedan raid</span>
      <span>▶ fleet under way (label shows ETA)</span>
      <span>▲ solid = warships · △ hollow = civilians</span>
      <span style="color:#b78bff">┈ wormhole</span>
    </div>
  </div>

  <aside>
    {#if selected}
      <h3 data-testid="selected-star">
        {#if renamingStar}
          <input
            class="renamestar"
            data-testid="rename-star-input"
            bind:value={renameStarText}
            use:focusNow
            maxlength="24"
            onkeydown={(e) => {
              if (e.key === 'Enter') commitStarRename();
              else if (e.key === 'Escape') renamingStar = false;
            }}
            onblur={commitStarRename}
          />
        {:else}
          {selected.star.name} <span class="dim">({selected.star.color.replaceAll('_', ' ')})</span>
          {#if canRenameSelected}
            <button class="mini ghost" data-testid="rename-star" title="rename star (needs a settlement here)" onclick={startStarRename}>✏️</button>
          {/if}
        {/if}
      </h3>
      {#if !selected.explored}
        <p class="dim">unexplored — send a ship to chart this system</p>
      {/if}
      {#if selected.star.wormholeTo !== null}
        <p class="dim">🌀 wormhole link — 1 turn transit</p>
      {/if}
      {#if !reachable.has(selected.star.id)}
        <p class="warn">⛽ out of fuel range — extend range with fuel-cell tech or a closer colony/outpost</p>
      {/if}
      {#if selected.explored && monstersByStar.has(selected.star.id)}
        {@const kinds = monstersByStar.get(selected.star.id)!}
        {#if isRaid(kinds)}
          <p class="raid" data-testid="monster-warning">⚠ Andromedan raid in progress: {kinds.map(prettify).join(', ')}</p>
        {:else}
          <p class="monster" data-testid="monster-warning">☠ guarded by: {kinds.map(prettify).join(', ')} — destroy the keeper to settle here</p>
        {/if}
      {/if}
      {#if blockadedStars.has(selected.star.id)}
        <p class="blockade">⚓ blockaded — output halved, no freighter food</p>
      {/if}
      {#if peacefulForeigners.length}
        <p class="dim">🕊 {peacefulForeigners.join(', ')} ships present — you are at peace. Declare war on the Empires tab to engage.</p>
      {/if}
      {#if selected.explored && selected.planets.length}
        <!-- classic system view: star + orbit arcs, planet size/climate/richness at a glance -->
        <svg class="system" viewBox="0 0 330 92" aria-label="system view">
          <g transform="translate(-26,46)">
            {#if selected.star.color === 'black_hole'}
              <ellipse rx="56" ry="18" fill="none" stroke="#6c4f8e" stroke-width="4.5" opacity="0.7" transform="rotate(-24)" />
              <ellipse rx="47" ry="14" fill="none" stroke="#c6a2ec" stroke-width="2" opacity="0.5" transform="rotate(-24)" />
              <circle r="39" fill="#02030a" stroke="#8a76b5" stroke-width="3.5" />
              <circle r="18" fill="#000000" />
            {:else}
              <circle r={STAR_VISUALS[selected.star.color].coronaR * 2.7} fill={mixHex(STAR_COLORS[selected.star.color], '#ffffff', STAR_VISUALS[selected.star.color].hotCoreTint * 0.5)} opacity="0.24" filter="url(#starglow)" />
              <circle r={STAR_VISUALS[selected.star.color].coreR * 2.55} fill={STAR_COLORS[selected.star.color]} opacity="0.96" />
              <circle r={STAR_VISUALS[selected.star.color].coreR * 1.35} fill={mixHex(STAR_COLORS[selected.star.color], '#ffffff', STAR_VISUALS[selected.star.color].hotCoreTint)} opacity="0.9" />
              {#if STAR_VISUALS[selected.star.color].spikeCount > 0}
                {#each SPIKE_ANGLES[selected.star.color] as ang, ai (ai)}
                  <line
                    x1={-STAR_VISUALS[selected.star.color].spikeLen * 2.1}
                    y1="0"
                    x2={STAR_VISUALS[selected.star.color].spikeLen * 2.1}
                    y2="0"
                    stroke={starSpikeStroke(selected.star.color)}
                    stroke-width={ang % 90 === 0 ? 2.2 : 1.7}
                    opacity={STAR_VISUALS[selected.star.color].spikeAlpha * 0.55}
                    transform="rotate({ang})"
                    stroke-linecap="round"
                  />
                {/each}
              {/if}
            {/if}
          </g>
          {#each [1, 2, 3, 4, 5] as orbit (orbit)}
            {@const ox = 30 + orbit * 56}
            <circle cx="-26" cy="46" r={ox + 26} fill="none" stroke="#26304f" stroke-width="1" />
            {#each selected.planets.filter((p) => p.orbit === orbit) as p (p.id)}
              {@const px = ox + 4}
              {#if p.body === 'asteroids'}
                {#each [-8, -3, 2, 7, 12] as off, ai (ai)}
                  <circle cx={px + off} cy={46 + ((ai * 7) % 11) - 5} r="1.6" fill="#8f8a80" />
                {/each}
              {:else if p.body === 'gas_giant'}
                <circle cx={px} cy="46" r="13" fill="url(#gg-{p.id})" />
                <g clip-path="url(#clip-{p.id})" opacity="0.5">
                  <ellipse cx={px} cy="42" rx="14" ry="2.2" fill="#a87c46" />
                  <ellipse cx={px} cy="49" rx="14" ry="1.8" fill="#e6c898" />
                </g>
                <ellipse cx={px} cy="46" rx="17" ry="4" fill="none" stroke="#e0c090" stroke-width="1.2" opacity="0.7" />
                <defs>
                  <radialGradient id="gg-{p.id}" cx="0.35" cy="0.3" r="1">
                    <stop offset="0%" stop-color="#e8c894" /><stop offset="70%" stop-color="#c9a06a" /><stop offset="100%" stop-color="#6e5432" />
                  </radialGradient>
                  <clipPath id="clip-{p.id}"><circle cx={px} cy="46" r="13" /></clipPath>
                </defs>
              {:else}
                {@const ring = mineralRing(p.minerals)}
                {@const look = worldLook(p)}
                {@const pr = 4 + p.sizeClass * 1.8}
                <defs>
                  <radialGradient id="pg-{p.id}" cx="0.35" cy="0.3" r="1.05">
                    <stop offset="0%" stop-color={look.light} />
                    <stop offset="55%" stop-color={look.base} />
                    <stop offset="100%" stop-color={look.dark} />
                  </radialGradient>
                  <clipPath id="clip-{p.id}"><circle cx={px} cy="46" r={pr} /></clipPath>
                </defs>
                <circle cx={px} cy="46" r={pr} fill="url(#pg-{p.id})" />
                <g clip-path="url(#clip-{p.id})">
                  {#if look.pattern === 'seas'}
                    <!-- continents / seas: irregular blobs, placement varies per world -->
                    <ellipse cx={px - pr * 0.35 + look.v} cy={46 - pr * 0.2} rx={pr * 0.55} ry={pr * 0.35} fill={look.detail} opacity="0.75" transform="rotate({look.v * 17} {px} 46)" />
                    <ellipse cx={px + pr * 0.4 - look.v * 0.5} cy={46 + pr * 0.35} rx={pr * 0.4} ry={pr * 0.22} fill={look.detail} opacity="0.65" transform="rotate({-look.v * 11} {px} 46)" />
                  {:else if look.pattern === 'bands'}
                    <!-- latitude bands (dune belts, storm streaks) -->
                    <ellipse cx={px} cy={46 - pr * 0.35} rx={pr * 1.1} ry={pr * 0.16} fill={look.detail} opacity="0.6" transform="rotate({look.v * 4 - 6} {px} 46)" />
                    <ellipse cx={px} cy={46 + pr * 0.25} rx={pr * 1.1} ry={pr * 0.2} fill={look.detail} opacity="0.5" transform="rotate({look.v * 4 - 6} {px} 46)" />
                  {:else if look.pattern === 'craters'}
                    <circle cx={px - pr * 0.3} cy={46 - pr * 0.25 + look.v * 0.6} r={pr * 0.2} fill={look.dark} opacity="0.8" />
                    <circle cx={px + pr * 0.35} cy={46 + pr * 0.15} r={pr * 0.14} fill={look.dark} opacity="0.7" />
                    <circle cx={px + pr * 0.05 + look.v * 0.4} cy={46 + pr * 0.45} r={pr * 0.1} fill={look.detail} opacity="0.8" />
                  {:else if look.pattern === 'ice'}
                    <ellipse cx={px} cy={46 - pr * 0.55} rx={pr * 0.8} ry={pr * 0.35} fill="#eef6ff" opacity="0.85" />
                    <ellipse cx={px - pr * 0.2} cy={46 + pr * 0.3} rx={pr * 0.4} ry={pr * 0.18} fill={look.detail} opacity="0.5" />
                  {/if}
                  {#if look.cap}
                    <ellipse cx={px} cy={46 - pr * 0.78} rx={pr * 0.5} ry={pr * 0.2} fill="#f2f8ff" opacity="0.9" />
                  {/if}
                  <!-- night-side terminator -->
                  <circle cx={px + pr * 0.45} cy={46 + pr * 0.4} r={pr * 1.15} fill="#04060e" opacity="0.28" />
                </g>
                {#if ring}
                  <circle cx={px} cy="46" r={7 + p.sizeClass * 1.8} fill="none" stroke={ring.stroke} stroke-width={ring.width} stroke-dasharray={ring.dash} />
                {/if}
                {#each selected.colonies.filter((c) => gs?.colonies.find((x) => x.id === c.id)?.planetId === p.id) as c (c.id)}
                  <circle cx={px} cy="46" r={10 + p.sizeClass * 1.8} fill="none" stroke={playerColor(c.owner)} stroke-width="1.8" />
                {/each}
              {/if}
            {/each}
          {/each}
        </svg>
        <p class="syskey">size = circle · color = climate · thin gold ring = rich · THICK gold = ultra-rich · dashed = poor · player ring = colony</p>
      {/if}
      {#if selected.ships.some((sh) => sh.owner !== me())}
        {@const foes = selected.ships.filter((sh) => sh.owner !== me() && sh.owner >= 0)}
        {#if foes.length}
          <p class="foefleet" data-testid="enemy-fleet-{selected.star.id}">
            ⚔ enemy fleet:
            {#each Object.entries(foes.reduce((acc: Record<string, number>, sh) => { const k = `${foeName(sh.owner)} ${sh.hull ?? sh.kind}`; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {})) as [label, n] (label)}
              <span class="foechip">{n}× {label}</span>
            {/each}
          </p>
        {/if}
      {/if}
      <ul class="planets">
        {#each selected.planets as p (p.id)}
          <li data-testid="planet-{p.id}">
            <span class="orbit">{p.orbit}</span>
            {p.body === 'planet' ? `${p.climate} · size ${p.sizeClass} · ${prettify(p.minerals)} · ${p.gravity}-g` : prettify(p.body)}
            {#each selected.colonies.filter((c) => gs?.colonies.find((x) => x.id === c.id)?.planetId === p.id) as c (c.id)}
              <b style="color:{playerColor(c.owner)}"> — {c.name}</b>
              {#if c.owner === me() && c.outpost}
                <button
                  data-testid="scrap-outpost-{c.id}"
                  title="dismantle this outpost for 25 BC salvage (its fuel-range support goes with it)"
                  onclick={() => session().submit('scrap_outpost', { colonyId: c.id })}
                >🗑 scrap outpost</button>
              {/if}
            {/each}
            {#each shipsHere as f (f.ship.id)}
              {#if f.canColonizeHere.includes(p.id)}
                <button data-testid="colonize-{p.id}" onclick={() => colonize(f.ship.id, p.id)}>colonize</button>
              {:else if f.canOutpostHere.includes(p.id)}
                <button onclick={() => outpost(f.ship.id, p.id)}>outpost</button>
              {:else if f.canConstructHere.includes(p.id)}
                <button
                  data-testid="construct-{p.id}"
                  title="rebuild this body into a barren world (consumes the construction ship)"
                  onclick={() => session().submit('construct_planet', { shipId: f.ship.id, planetId: p.id })}
                >construct planet</button>
              {/if}
            {/each}
          </li>
        {/each}
      </ul>
      {#if shipsHere.length}
        <h4>
          Your ships here <span class="dim keys" title="hotkeys: A selects all/none · Backspace cycles through single ships (then all)">A=all · ⌫=cycle</span>
          <label class="selall" title="select every ship at this system (hotkey: A)">
            <input
              type="checkbox"
              data-testid="select-all-ships"
              checked={shipsHere.every((f) => selectedShipIds.includes(f.ship.id))}
              onchange={(e) => {
                const ids = shipsHere.map((f) => f.ship.id);
                selectedShipIds = (e.target as HTMLInputElement).checked
                  ? [...new Set([...selectedShipIds, ...ids])]
                  : selectedShipIds.filter((id) => !ids.includes(id));
              }}
            />
            all
          </label>
        </h4>
        <ul class="ships">
          {#each shipsHere as f (f.ship.id)}
            <li>
              <label>
                <input type="checkbox" checked={selectedShipIds.includes(f.ship.id)} onchange={() => toggleShip(f.ship.id)} />
                {f.name} <span class="dim">#{shortEntityId(f.ship.id)}</span>
              </label>
            </li>
          {/each}
        </ul>
        {#if selectedShipIds.length}
          <p class="go">➤ click a destination star to move {selectedShipIds.length} ship{selectedShipIds.length > 1 ? 's' : ''} — green halo = in range</p>
        {/if}
      {/if}
      {#if fleets.some((f) => f.reroutable)}
        <p class="dim">↩ fleets ordered this turn can still be re-routed from the Fleets tab.</p>
      {/if}
    {:else}
      <p class="dim">select a star</p>
      {#if showFleetTip}
        <p class="dim">
          Your ships travel star-to-star within fuel range. Fleets under way show as ▶ markers with their ETA.
          <button class="tipdismiss" onclick={dismissFleetTip}>got it ✕</button>
        </p>
      {/if}
    {/if}
  </aside>
</div>

<style>
  .bodyx {
    font-size: 8px;
    fill: #6a7288;
  }
  .tipdismiss {
    font-size: 0.72rem;
    padding: 0 0.3rem;
    margin-left: 0.4rem;
  }
  .selall {
    font-size: 0.75rem;
    font-weight: 400;
    color: var(--text-dim);
    margin-left: 0.5rem;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  .keys {
    font-size: 0.68rem;
    font-weight: 400;
    letter-spacing: 0.02em;
  }
  .foefleet {
    font-size: 0.8rem;
    color: var(--bad, #ff7b7b);
  }
  .foechip {
    background: rgba(255, 110, 110, 0.12);
    border: 1px solid rgba(255, 110, 110, 0.35);
    border-radius: 6px;
    padding: 0 0.3rem;
    margin-right: 0.25rem;
  }
  .wrap {
    display: flex;
    gap: 0.8rem;
    /* include nav, section padding, sticky footer and map legend in the
       viewport budget so fit mode keeps the full map + legend visible */
    height: calc(100dvh - 14rem);
    min-height: 30rem;
  }
  .mapcol {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .mapnote {
    background: #33201a;
    border: 1px solid var(--bad, #ff8a7a);
    color: var(--bad, #ff8a7a);
    border-radius: 6px;
    padding: 0.3rem 0.6rem;
    margin-bottom: 0.4rem;
    font-size: 0.85rem;
  }
  svg {
    background:
      radial-gradient(70% 60% at 60% 30%, rgba(38, 48, 95, 0.35) 0%, transparent 70%),
      #05070f;
    border: 1px solid var(--line);
    border-radius: 10px;
    min-height: 0;
    display: block;
  }
  /* zoom-to-fit really FITS: the whole galaxy stays inside the viewport
     height instead of only matching the width and scrolling vertically */
  .scroller {
    min-height: 0;
    flex: 1;
  }
  .scroller:not(.zoomed) {
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .scroller:not(.zoomed) svg {
    height: auto;
    margin: 0;
  }
  .scroller.zoomed {
    overflow: auto;
    max-height: 74vh;
    border-radius: 10px;
    cursor: grab;
  }
  .scroller.zoomed svg {
    min-height: 420px;
  }
  .scroller.zoomed.dragging {
    cursor: grabbing;
    user-select: none;
  }
  .zoombtn {
    font-size: 0.8rem;
  }
  .star {
    cursor: pointer;
  }
  .star:focus {
    outline: none;
  }
  text {
    fill: #aab3d0;
    font-size: 22px;
  }
  .label {
    fill: #c7d0ee;
    text-shadow: 0 0 6px #05070f;
  }
  .dimlabel {
    fill: #5d6788;
  }
  .unknown {
    fill: #5d6788;
    font-size: 20px;
    pointer-events: none;
  }
  .fog {
    fill: none;
    stroke: #39415f;
    stroke-width: 1.5;
    stroke-dasharray: 3 5;
  }
  .selring {
    fill: none;
    stroke: #8fb8ff;
    stroke-width: 3;
    animation: selpulse 1.6s ease-in-out infinite;
  }
  @keyframes selpulse {
    0%, 100% { stroke-opacity: 1; r: 36; }
    50% { stroke-opacity: 0.5; r: 40; }
  }
  .target {
    fill: rgba(94, 224, 138, 0.08);
    stroke: #5ee08a;
    stroke-width: 1.5;
    stroke-dasharray: 6 6;
  }
  .norange {
    fill: none;
    stroke: #5a3030;
    stroke-width: 2;
    stroke-dasharray: 4 6;
  }
  .territory {
    /* group-level opacity: overlapping circles composite to ONE flat region */
    opacity: 0.09;
    pointer-events: none;
  }
  .route {
    stroke: #6ea8ff;
    stroke-width: 2;
    stroke-dasharray: 10 10;
    opacity: 0.5;
    pointer-events: none;
    animation: routeflow 1.2s linear infinite;
  }
  @keyframes routeflow {
    to { stroke-dashoffset: -20; }
  }
  .fleetmark {
    fill: #8fb8ff;
    stroke: #05070f;
    stroke-width: 1.5;
    filter: drop-shadow(0 0 6px rgba(110, 168, 255, 0.8));
  }
  .fleetmark.reroutable {
    fill: #ffd75e;
  }
  .eta {
    font-size: 17px;
    fill: #8fb8ff;
    pointer-events: none;
  }
  aside {
    width: 22rem;
    max-height: 100%;
    overflow: auto;
    font-size: 0.9rem;
    background: linear-gradient(180deg, var(--panel-2), var(--panel));
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 0.6rem 0.9rem;
    align-self: flex-start;
  }
  aside h3 {
    margin: 0.2rem 0 0.5rem;
    color: var(--accent-soft);
  }
  aside h3 .ghost {
    opacity: 0.35;
    border: none;
    background: transparent;
    padding: 0 0.2rem;
    font-size: 0.8rem;
  }
  aside h3 .ghost:hover {
    opacity: 1;
  }
  .renamestar {
    width: 11rem;
  }
  .dim,
  .dimtext {
    opacity: 0.65;
  }
  .warn {
    color: var(--gold);
  }
  .go {
    color: var(--good);
  }
  ul {
    padding-left: 1rem;
    list-style: none;
    margin: 0.3rem 0;
  }
  li {
    margin-bottom: 0.3rem;
  }
  .orbit {
    display: inline-block;
    width: 1.2rem;
    height: 1.2rem;
    line-height: 1.2rem;
    text-align: center;
    background: var(--panel-3);
    border-radius: 50%;
    font-size: 0.75rem;
    margin-right: 0.3rem;
    color: var(--accent-soft);
  }
  .monster {
    fill: #ff8a7a;
    color: #ff8a7a;
    font-size: 24px;
  }
  .raid {
    fill: #ffd75e;
    color: #ffd75e;
    font-size: 26px;
    font-weight: 700;
  }
  .blockade {
    fill: #ffd479;
    color: #ffd479;
    font-size: 24px;
  }
  aside .monster,
  aside .raid,
  aside .blockade {
    font-size: 0.9rem;
  }
  .legend {
    flex: 0 0 auto;
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    font-size: 0.78rem;
    color: var(--text-dim);
    padding: 0.4rem 0.2rem 0;
    align-items: center;
  }
  .legend .monster,
  .legend .raid {
    font-size: 0.85rem;
  }
  .legend .sw {
    display: inline-block;
    width: 0.8rem;
    height: 0.8rem;
    border: 2px dashed #5a3030;
    border-radius: 50%;
    vertical-align: middle;
  }
  .legend label {
    display: flex;
    gap: 0.3rem;
    align-items: center;
    color: var(--text);
  }

  @media (min-height: 980px) {
    .wrap {
      height: calc(100dvh - 13rem);
    }
  }
  .wormhole {
    stroke: #b78bff;
    stroke-width: 2;
    stroke-dasharray: 3 9;
    opacity: 0.55;
    pointer-events: stroke;
  }
  .count {
    font-size: 15px;
    font-weight: 700;
  }
  .system {
    width: 100%;
    background: #05070f;
    border: 1px solid var(--line);
    border-radius: 8px;
    margin: 0.3rem 0 0.1rem;
  }
  .syskey {
    font-size: 0.68rem;
    color: var(--text-dim);
    margin: 0.15rem 0 0.4rem;
  }
</style>
