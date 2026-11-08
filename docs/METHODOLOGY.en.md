# Methodology and justification

[Русская версия](METHODOLOGY.md)

This document describes the mathematical model of the application, its assumptions and what they rest on. All numeric parameters live in `WALK` and `CONFIG` (`js/config.js`); the numbers in the tables below are produced from the formulas by code, not tuned by hand. Formulas that `tests/run.mjs` verifies independently (numerical integration and simulation) are marked ✔.

## 1. What is measured

Walking accessibility is the **time** from a point *x* to the nearest facility of category *c* along the real path network:

```
t_c(x) = min over facilities j of category c  T(x → j)
```

where `T` is the minimum expected walking time. An isochrone of level τ is the set reachable within τ:

```
Iso(τ, x₀) = { x : T(x₀ → x) ≤ τ }
```

This is a *cumulative* accessibility measure (the number of opportunities within a time threshold) and, combined with a decay function (section 8), a *gravity-type* measure in the classification of Geurs & van Wee (2004), going back to Hansen (1959). The 5/10/15 min thresholds correspond to the "15-minute city" concept (Moreno et al., 2021).

## 2. Network

OSM ways form a graph *G = (V, E)* embedded in the plane. Edges longer than 40 m are split into equal parts, which gives exact snapping of points to the network and smooth isochrone outlines. Excluded: `motorway`, `construction`, ways with `foot=no` / `access=private|no`, area features (`area=yes`). Small isolated components (fewer than 25 nodes) are dropped so that snapping does not land on "islands".

Distances are geodesic (haversine, R = 6,371,008.8 m). Rasterisation uses a local equirectangular projection around the area centre; at city scale (tens of km) the length distortion is negligible (about 10⁻⁴).

## 3. Edge time

```
t_e = ℓ_e · φ_e / v₀
```

`ℓ_e` is the length, `v₀` the free walking speed (default 4.8 km/h = 1.33 m/s; adjustable). It is a typical value: Tobler (1993) gives 5.04 km/h on flat ground; field measurements on sidewalks give 1.2–1.5 m/s, and 1.2 m/s is the design value for a mixed population in the HCM (Knoblauch et al., 1996; Highway Capacity Manual, 6th ed.).

The factor `φ_e ≥ 1` is assembled from OSM tags:

| Factor | Multiplier | Rationale |
|---|---|---|
| Stairs | 1.8 | climbing/descending steps is markedly slower than level walking |
| Surface (`surface`) | 1.0 (asphalt, concrete) … 1.4 (dirt, grass) … 1.8 (snow, ice) | slower on soft and slippery surfaces |
| Quality (`smoothness`) | 1.0 … 2.0 | same |
| Slope (`incline`) | see below | Tobler's function |
| Roadway without sidewalk | 1.2–1.4 (by class) | forced walking on the verge: lower speed and comfort |
| `sidewalk=separate` | 1.1 | next to a road we prefer the separately mapped sidewalk |

**Slope.** Tobler's speed: `v(s) = 6·exp(−3.5·|s + 0.05|)` km/h, *s* being the gradient. The direction of travel along an OSM edge is unknown, so the mean of uphill and downhill time relative to flat ground is used:

```
φ(s) = ½ · ( v(0)/v(s) + v(0)/v(−s) ),   φ(0) = 1,  φ(10 %) ≈ 1.2
```

A digital elevation model is **not used**: slope is accounted for only where OSM carries it.

## 4. Waiting at crossings

A road in the graph is a centreline, while a pedestrian walks on the sidewalk and must cross the carriageway. Waiting time is a random variable; routing uses its **expected value**.

### 4.1. Traffic signal (Webster, HCM) ✔

A pedestrian arrives at a moment uniformly distributed over a cycle of length *C*; if arriving during the pedestrian green *g* there is no wait, otherwise they wait until the next green:

```
E[W] = (1/C) ∫_g^C (C − t) dt = (C − g)² / (2C)
```

Parameters by road class (cycle *C*, pedestrian green *g*, s): service 40/12, residential 60/15, tertiary 75/15, secondary 90/15, primary 100/15, trunk 110/15. The formula is verified by numerical integration in the tests.

### 4.2. Unsignalised crossing (Adams formula) ✔

Vehicle flow is Poisson with intensity λ (veh/s); a pedestrian starts crossing if the next vehicle arrives no sooner than the critical gap *t_c*, otherwise lets it pass and re-evaluates the gap. The expected delay (Adams, 1936) is:

```
E[D] = ( e^{λ·t_c} − λ·t_c − 1 ) / λ
```

A pedestrian crosses the directions one after another, so the road is split in half: directional flow *q/2*, critical gap `t_c = (w/2)/v_c + t_s`, total delay `d = 2·E[D](q/2, t_c)`. Here *w* is the carriageway width (with a `lanes` tag, `lanes × 3.25 m`), *v_c* = 1.2 m/s, *t_s* = 3 s (start-up lost time, HCM). The formula is verified by simulating a Poisson flow (deviation < 3 %).

A marked unsignalised crossing is ×0.7; a zebra is ×(1 − η), η = 0.6 being the share of yielding drivers, at least 1 s. In Russia drivers must yield at an unsignalised crossing, so this estimate is conservative.

### 4.3. Resulting values, s

| Rank | Class | Signal | Zebra | Unmarked |
|---|---|---|---|---|
| 1 | service, living_street | 9.8 | 1.0 | 0.1 |
| 2 | residential, unclassified | 16.9 | 1.0 | 0.7 |
| 3 | tertiary | 24.0 | 1.0 | 2.2 |
| 4 | secondary | 31.3 | 2.2 | 5.6 |
| 5 | primary | 36.1 | 5.3 | 13.3 |
| 6 | trunk | 41.0 | 13.3 | 33.2 |

Base flows and widths by rank: 30/150/400/700/1000/1500 veh/h and 4/6/7/9/12/14 m. These are defaults from general considerations, not the result of field measurements in a particular city (see section 13).

A signal is detected by `highway=traffic_signals`, `crossing=traffic_signals`, `crossing:signals=yes`; a zebra by `crossing=zebra|marked`; a gate, barrier or turnstile adds 4 s; closed ways (`access=no|private`, `foot=no`) block passage.

## 5. Intersections as a ring of sidewalk ends

If a pedestrian at a junction were simply "crossing the side street", typical effects would be lost: at a T-junction there is no need to cross on the side opposite the branch; a left turn requires a crossing and a right turn does not; a major road without crossings is a barrier. To obtain these without special rules, the pedestrian state is a pair *(arc, side of the road σ ∈ {right, left})*.

A node *v* with *k* legs is modelled as a ring of 2*k* vertices. Legs are ordered clockwise by bearing; leg *i* has a left end `L_i` and a right end `R_i` of the sidewalk:

- **corner:** `R_i` is joined to `L_{i+1}` by zero-cost edges (the sidewalk wraps around the corner between neighbouring legs);
- **crossing:** `L_i` is joined to `R_i` by edges costing `w_i`, the wait for crossing leg *i* by the formulas of section 4 (0 for a pedestrian-only leg, which is one and the same sidewalk).

The cost of a transit from state *(a, σ)* to *(b, σ′)* is the length of the shortest path between the corresponding ring ends (Floyd–Warshall, 2*k* ≤ 16 vertices). Example: at a T-junction, going "straight on the side opposite the branch" costs 0; "straight on the branch side" costs *w* of the side street; "left" costs *w* of the road one arrived on.

On small streets (rank ≤ 2) the side can be changed anywhere at a cost of `w` (the wait for crossing the carriageway without markings); on others only at junctions and at nodes with a marked crossing. Hence a major road without crossings is a barrier, while a network of quiet streets is crossable almost freely, as in reality.

**Correctness.** All weights are non-negative, time-independent and depend only on the (entry, exit) pair, so ordinary Dijkstra (1959) works on the state graph: it yields the minimum expected time within the model. Complexity `O(|S| log |S|)`, `|S| ≤ 2·|A|`, where *A* is the set of arcs; on an 8 × 8 km grid (≈100 thousand arcs) one run takes tens of milliseconds. Verified numerically on a random network with various road classes, signals, zebras and gates: `T(x→y)` equals `T(y→x)` to 10⁻¹² s (as it must for walking without one-way restrictions).

## 6. Snapping points to the network

A point is snapped to the nearest node within a radius: facilities 150 m, buildings 200 m, start 300 m. The leg from the point to the network goes through courtyards, so its time is multiplied by 1.25. If the node belongs to a major road (rank ≥ 3), **¼ of a crossing wait** is added: snapped nodes do not know which side of the road the facility is on; for two independent points a crossing is needed with probability ½, and this wait is split equally between the ends.

Consequence: `T` is defined on "free" ends, so on triples of points the triangle inequality may be violated (passing through an intermediate point lets one change side for free). This does not affect isochrones or the index, which are computed in a single run from one source.

## 7. Building the isochrone

`Iso(τ)` is built as a "buffer" around reachable nodes rather than a convex or alpha hull (which wrongly covers blocks with no through paths):

1. nodes with `T ≤ τ` go onto a raster with step *h* = 40 m;
2. dilation by one cell (Chebyshev): the zone includes points 40–80 m from the reachable network, accounting for the distance from a path to an entrance;
3. tracing of the boundaries of filled cells (outer contours counter-clockwise, holes clockwise; diagonal contacts do not merge contours);
4. Chaikin smoothing (two corner-cutting iterations, Chaikin, 1974);
5. holes smaller than 4 ha are filled; larger ones (rivers, railways, parks without paths) are kept.

The boundary position error is of order 1.5*h* ≈ 60 m, i.e. ≈ 45 s of walking. The area is overstated because of the dilation: on an open Manhattan grid a 5 min isochrone gives ≈ 0.41 km² against a theoretical diamond of radius *v·τ* = 400 m and area 2*r*² = 0.32 km² (+28 %); the test requires the ratio to stay within 0.9–1.45. For comparing districts and problem zones this does not matter (the bias is systematic); keep it in mind for absolute areas. This is the standard compromise of network service areas (see O'Sullivan et al., 2000); *h* and the dilation can be changed in `isochroneGeometry`.

## 8. Accessibility index

The time to the nearest facility of a category is computed with one multi-source Dijkstra run from all facilities at once (equivalent to a virtual source joined to the facilities by zero-cost edges). For point *i* and category *c* the time is `t_c(i)` in minutes, and the score is a truncated piecewise-linear decay function:

```
s(t) = 100                                   for t ≤ 5
s(t) = 100 · (20 − t) / 15                    for 5 < t < 20
s(t) = 0                                     for t ≥ 20
```

The point index is the mean score over the selected categories; the index of a district *D* is the weighted mean over demand points:

```
I_D = Σ_{i∈D} w_i · s̄(i) / Σ_{i∈D} w_i
```

A truncated linear decay is the simplest "kernel" distance function in gravity accessibility measures (Hansen, 1959): it decreases monotonically and reaches zero beyond a reasonable walking reach. The thresholds of 5 and 20 min are parameters (`CONFIG.index`): ≤ 5 min (≈ 400 m) counts as "nearby", ≥ 20 min as "out of walking reach". For each category the shares of demand within the given thresholds (5/10/15 min by default) and the weighted median time are also computed.

**Demand.** OSM has no resident counts, so the dasymetric principle (Mennis, 2003) is applied: residential buildings are given a weight proportional to the number of levels (`building:levels`; apartment buildings without the tag count 5, the others 1; non-residential types are filtered out). This is a proxy, not a census: levels are not residents, and some buildings are not mapped. The "By streets" mode replaces buildings with network nodes weighted by street length. The "My population data" mode takes points (or polygon centroids) from an uploaded GeoJSON with the weight from the `pop` / `population` / `people` / `weight` property (otherwise 1); a point is snapped to the nearest network node within the building snap radius and unsnapped points are skipped. A polygon is reduced to the centroid of its outer ring and carries its whole weight there; for large polygons (districts) prefer points.

**"What if" scenarios.** A hypothetical facility is added to the Dijkstra sources of its category (snapped like ordinary facilities), the calculation is repeated and the results are compared with the baseline without the added facilities (index, number of problem zones, resident shares within the threshold). A facility is a single point with one entrance; a park is not modelled as an area.

## 9. Problem zones

The area is divided into 150 m cells with a weighted mean index. A cell is "problematic" if its index is < 35 (for equal weights this is on average ≈ 14.8 min to facilities) and its demand is at least half of the median (this removes isolated buildings on the outskirts). Connected groups (8-neighbourhood) form zones; each reports its share of total demand, its area and the category with the lowest score.

Results depend on how districts are cut (the modifiable areal unit problem, Openshaw, 1984), so both administrative boundaries and square grids of various sizes are offered, and problem zones are not tied to district boundaries.

## 10. Verification

`npm test` (54 tests, no network or browser needed) checks:

- **intersection delays:** straight on, T-junction, turn, diagonal "staircase", signal/zebra/unmarked, an explicit `footway=crossing`, gates, dead ends;
- the **Webster and Adams formulas**, by numerical integration and Monte Carlo simulation;
- **path factors:** stairs, surfaces, slope, sidewalks;
- **isochrone geometry:** area relative to the reference diamond on a Manhattan grid, nesting, closure and orientation of contours, preservation of holes;
- **cross-checks on random networks** (random road classes, signals, zebras): time is not less than the straight line at maximum speed (0.1 % tolerance for float32); a higher speed never increases time; route breakdown is consistent (start + walking + waiting = total); with zero wait parameters the time equals `length × φ / v₀`;
- **route breakdown:** `track` does not change Dijkstra's result, and the number of "signal" events on the test path equals the number of crossings;
- **model parameters:** recomputation of wait tables, ignoring invalid values, reset;
- **resilience:** a mirror going down, trying all mirrors, malformed responses (HTML, a timeout `remark`, no `elements`), timeout, retry rounds, cancellation, cool-down expiry, geocoder fallback to Photon;
- **localisation:** every UI string has a translation and the placeholders match;
- snapping, the index, problem zones and OSM parsing.

## 11. Route breakdown and transparency

Dijkstra in `track` mode remembers, for each state (arc, side), its predecessor, the amount of waiting and the transition type. From these `tracePath` reconstructs the path and splits the time: `T = T_access + T_walk + T_wait + T_egress`. Wait events (signal, zebra, marked crossing, unmarked crossing, gate, mid-block crossing) are reported with coordinates.

Model parameters (cycles, green phases, widths, flows, crossing speed, multipliers) can be changed in the interface (the "How it is calculated" dialog); the wait tables are recomputed with the same formulas (sections 4–5) and the graph is rebuilt, because intersection delays are "baked" into the ring matrices. The "Calculation log" records what was loaded (numbers of ways, signals, facilities, buildings), the graph size and stage timings.

## 12. Data sources and resilience

Data come from public services that can be unavailable, so requests are made with mirror failover (`js/failover.js`):

- 5 Overpass mirrors; a failure is an HTTP error, an attempt timeout (70 s), a network drop, a non-JSON response, missing `elements`, or a `remark` about running out of time/memory;
- a failed mirror is put in "quarantine" for `15 s · 2^(k−1)` (up to 5 min); the order is healthy mirrors first, those that answered more often earlier; if all fail, up to 3 rounds with pauses of 1.2 s and 2.4 s;
- a 429/503 response with `Retry-After` is honoured (up to 8 s);
- geocoder: Nominatim → Photon;
- loaded data tiles (0.03° × 0.045°) are cached in memory and in IndexedDB for 7 days, so after a failure only the missing ones are retried;
- the result does not depend on which mirror answered: the data are the same OSM (up to replication lag between mirrors, usually minutes).

## 13. Limitations and how to lift them

- **Means instead of distributions.** Routing uses expectations; the route optimal in expectation may differ from the one optimal when variance is considered (Jensen's inequality). To gauge the uncertainty, vary the parameters (the "How it is calculated" dialog) and the speed.
- **Parameters are not calibrated for a specific city.** Flows, widths and signal cycles are set by road class. For accurate estimates replace them with measurements; the architecture allows this: `roadFlow`, `roadWidth`, `signalCycle`, `signalGreen` are one object.
- **Terrain**, intensity and phases of real signals, weather, time of day, age and mobility of pedestrians are not accounted for.
- **OSM completeness.** Where sidewalks and crossings are not mapped, the model relies on road classes. Result quality in a city is bounded by the quality of its map.
- **Population proxy.** See section 8; your own population data replaces the proxy, but its quality and date are on you.
- **Scenarios** show the change in accessibility under the model, not a forecast of how a facility will be used: capacity, opening hours and queues are not considered.
- **Isochrone area overstatement** of ≈ 20–30 % because of the raster buffer (section 7).
- **Cache and freshness:** data in the local cache can be up to 7 days older than OSM; the "Clear cache" button removes this.

## References

- Adams W.F. Road traffic considered as a random series // Journal of the Institution of Civil Engineers. 1936. Vol. 4.
- Chaikin G.M. An algorithm for high-speed curve generation // Computer Graphics and Image Processing. 1974. Vol. 3(4).
- Dijkstra E.W. A note on two problems in connexion with graphs // Numerische Mathematik. 1959. Vol. 1.
- Geurs K.T., van Wee B. Accessibility evaluation of land-use and transport strategies: review and research directions // Journal of Transport Geography. 2004. Vol. 12(2).
- Hansen W.G. How accessibility shapes land use // Journal of the American Institute of Planners. 1959. Vol. 25(2).
- Highway Capacity Manual, 6th Edition. Transportation Research Board, 2016.
- Knoblauch R.L., Pietrucha M.T., Nitzburg M. Field studies of pedestrian walking speed and start-up time // Transportation Research Record. 1996. No. 1538.
- Mennis J. Generating surface models of population using dasymetric mapping // The Professional Geographer. 2003. Vol. 55(1).
- Moreno C., Allam Z., Chabaud D., Gall C., Pratlong F. Introducing the "15-Minute City" // Smart Cities. 2021. Vol. 4(1).
- Openshaw S. The Modifiable Areal Unit Problem. Geo Books, 1984.
- O'Sullivan D., Morrison A., Shearer J. Using desktop GIS for the investigation of accessibility by public transport: an isochrone approach // International Journal of Geographical Information Science. 2000. Vol. 14(1).
- Tobler W. Three presentations on geographical analysis and modeling. NCGIA Technical Report 93-1, 1993.
- Webster F.V. Traffic signal settings. Road Research Technical Paper No. 39, HMSO, 1958.
