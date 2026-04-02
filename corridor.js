/*
 * ================================================================
 * corridor.js  —  FABRIK Corridor Pathfinder (v3)
 * ================================================================
 * Depends on: topology.js (unsigned total-pressure elevation field)
 *
 * PURPOSE:
 *   Find the paths of least resistance through the topology
 *   (from computeTopology). Total light pressure = elevation
 *   (mountains). No light = flat terrain (corridors). Price flows
 *   through the dark zones between pressure zones.
 *
 * APPROACH: Pool-Routed FABRIK
 *
 *   1. DISCOVER POOLS: Scan intermediate columns at regular intervals
 *      for low-pressure zones. Each pool is a Y-range where terrain
 *      is below a threshold — a gap between pressure zones.
 *
 *   2. BUILD GRAPH: Connect pools in adjacent scan columns with edges.
 *      An edge is valid only if the Y-distance between pools can be
 *      traversed within the maxStepGy constraint over the columns
 *      between scan points. Edge weight = average terrain along the
 *      connection line.
 *
 *   3. ROUTE: Dijkstra from entry to each far-end target through the
 *      pool graph. This finds globally optimal stepping-stone paths
 *      that a local search would miss — e.g. routing through a saddle
 *      point to reach a much better corridor on the other side.
 *
 *   4. SEED FABRIK: Initialize each chain along the graph route (not
 *      a straight line). Joints start at the pool centers.
 *
 *   5. FABRIK RELAXATION: Forward + backward passes refine the path,
 *      with the same reach-then-seek mechanics as before, plus:
 *        - Max step constraint: joints can't move faster than price can
 *        - Straight-line dampening: after 3+ joints at similar slope,
 *          a perturbation nudge prevents the corridor from recommending
 *          paths the prediction engine will tax
 *        - Color bias nudge: support/resistance polarity influence
 *
 *   6. COMPOSITE SCORING: Rank paths by terrain energy, corridor width,
 *      ridge crossings, color bias alignment, momentum alignment, and
 *      temporal continuity (paths that held a good rank last frame get
 *      a stability bonus).
 *
 * OUTPUT:
 *   Same waypoint array format as before (backward compatible).
 *   Plus .paths with all ranked FABRIK chains for visualization.
 * ================================================================
 */


// ================================================================
// TEMPORAL CONTINUITY STATE
// ================================================================
// Module-level memory of previous frame's path signatures.
// Used by STEP 6 to give a stability bonus to chains that match
// a previous frame's path. This prevents paths from jumping
// wildly between frames when terrain changes are small.
//
// Each entry: { endGy, midGy, rank, source }
// Reset when entryGx changes (new data loaded).
var _prevPaths = [];
var _prevEntryGx = -1;


// ================================================================
// POOL DISCOVERY
// ================================================================
// Scan columns at regular intervals to find low-pressure zones.
// Each pool is a continuous vertical range where terrain elevation
// is below a threshold — a gap between pressure ridges.
//
// Returns array of { scanGx, gy, pressure, width } objects grouped
// by scan column. Each scan column can have 0..N pools.

function discoverPools(topo, startGx, endGx, scanInterval) {
  var cols = topo.cols;
  var rows = topo.rows;
  var elevation = topo.intensity;
  var ref = topo.refIntensity || 1;
  if (!scanInterval) scanInterval = 5;

  var threshold = ref * 0.60;  // pools below 60% of ref pressure

  // Group pools by scan column index for graph building
  var scanColumns = [];

  for (var sx = startGx; sx <= endGx; sx += scanInterval) {
    if (sx < 0 || sx >= cols) continue;

    var colPools = [];
    var inPool = false;
    var poolStart = 0;

    // Average pressure over a small window (3 columns) for stability
    for (var y = 0; y < rows; y++) {
      var sum = 0;
      var cnt = 0;
      for (var dx = -1; dx <= 1; dx++) {
        var cx = sx + dx;
        if (cx >= 0 && cx < cols) {
          sum += elevation[y * cols + cx];
          cnt++;
        }
      }
      var avgP = sum / cnt;

      if (avgP < threshold) {
        if (!inPool) {
          inPool = true;
          poolStart = y;
        }
      } else {
        if (inPool) {
          _addPool(colPools, elevation, cols, sx, poolStart, y - 1, ref);
          inPool = false;
        }
      }
    }
    if (inPool) {
      _addPool(colPools, elevation, cols, sx, poolStart, rows - 1, ref);
    }

    // If no pools found in this column, create one at the lowest point
    if (colPools.length === 0) {
      var bestY = 0, bestP = Infinity;
      for (var fy = 0; fy < rows; fy++) {
        var p = elevation[fy * cols + sx];
        if (p < bestP) { bestP = p; bestY = fy; }
      }
      colPools.push({
        scanGx: sx,
        gy: bestY,
        pressure: bestP / (ref + 0.001),
        width: 1,
        top: bestY,
        bot: bestY
      });
    }

    scanColumns.push({ gx: sx, pools: colPools });
  }

  return scanColumns;
}


// Helper: build a pool from a vertical range in a scan column
function _addPool(colPools, elevation, cols, gx, startY, endY, ref) {
  var width = endY - startY + 1;
  // Accept even single-cell pools — narrow gaps between ridges are valid

  var bestY = startY, bestP = Infinity;
  var totalP = 0;
  for (var y = startY; y <= endY; y++) {
    var p = elevation[y * cols + gx];
    totalP += p;
    if (p < bestP) { bestP = p; bestY = y; }
  }

  colPools.push({
    scanGx: gx,
    gy: bestY,          // center of pool (lowest point)
    pressure: (totalP / width) / (ref + 0.001),  // normalized avg pressure
    width: width,
    top: startY,
    bot: endY
  });
}


// ================================================================
// GRAPH ROUTING (Dijkstra through pool graph)
// ================================================================
// Connect pools in adjacent scan columns with edges, respecting
// the maxStepGy constraint. Then find cheapest path from entry
// to each far-end pool.
//
// Edge weight = average terrain elevation along the connecting
// line segment between two pools.
//
// Returns an array of route objects: { pools: [...], cost: number }
// sorted by cost (cheapest first).

function routeThroughPools(scanColumns, topo, entryGy, maxStepGy, exhaustionZones) {
  if (scanColumns.length < 2) return [];

  var cols = topo.cols;
  var rows = topo.rows;
  var elevation = topo.intensity;
  var ref = topo.refIntensity || 1;

  // Build flat pool list with column indices for Dijkstra
  var allPools = [];
  var colStart = [];  // index into allPools where each scan column starts

  // Add a virtual entry pool
  var entryPool = {
    scanGx: scanColumns[0].gx,
    gy: entryGy,
    pressure: 0,
    width: 1,
    top: entryGy,
    bot: entryGy,
    _colIdx: -1,
    _poolIdx: allPools.length
  };
  allPools.push(entryPool);

  for (var ci = 0; ci < scanColumns.length; ci++) {
    colStart.push(allPools.length);
    var sc = scanColumns[ci];
    for (var pi = 0; pi < sc.pools.length; pi++) {
      sc.pools[pi]._colIdx = ci;
      sc.pools[pi]._poolIdx = allPools.length;
      allPools.push(sc.pools[pi]);
    }
  }

  var N = allPools.length;
  if (N < 2) return [];

  // Build adjacency list
  var adj = [];
  for (var ai = 0; ai < N; ai++) adj.push([]);

  // Edge reachability: the max Y distance between two connected pools
  // is maxStepGy × numCandles between them. This is the physical limit —
  // price can't move more than one average candle body per candle,
  // and the candles between scan columns are the budget. No inflation.
  // When maxStepGy is unknown or zero, use a generous fallback.
  var hasStepConstraint = (maxStepGy > 0.01);
  var fallbackReach = Math.floor(rows * 0.40);

  // Entry → first TWO scan columns' pools.
  // NO distance filter — the entry price might be inside a high-pressure
  // zone, far from any pool. Connect to everything and let Dijkstra
  // find the cheapest way to reach a corridor. Edge weight includes
  // a distance penalty so nearby pools are naturally preferred.
  var connectEnd = (scanColumns.length > 2) ? colStart[2] : N;

  for (var fp = colStart[0]; fp < connectEnd; fp++) {
    var fpYDist = Math.abs(allPools[fp].gy - entryGy);
    var ew = _edgeWeight(elevation, cols, rows, ref,
                         entryPool.scanGx, entryGy,
                         allPools[fp].scanGx, allPools[fp].gy);
    var distPenalty = (fpYDist / (rows * 0.25 + 1)) * 0.3;
    var exhCost = _exhaustionEdgeCost(entryGy, allPools[fp].gy, exhaustionZones);
    adj[0].push({ to: fp, weight: ew + distPenalty + exhCost });
  }

  console.log("[Corridor] Entry edges: " + adj[0].length + " (to " + (connectEnd - colStart[0]) + " pools in first 2 columns)");

  // Connect adjacent scan columns
  for (var c = 0; c < scanColumns.length - 1; c++) {
    var curStart = colStart[c];
    var curEnd   = (c + 1 < scanColumns.length) ? colStart[c + 1] : N;
    var nxtStart = colStart[c + 1];
    var nxtEnd   = (c + 2 < scanColumns.length) ? colStart[c + 2] : N;

    var colDist = Math.abs(scanColumns[c + 1].gx - scanColumns[c].gx) || 1;
    // Physical budget: how many cells price CAN cover between scan columns
    var colBudget = hasStepConstraint ? maxStepGy * colDist : rows * 0.4;

    for (var a = curStart; a < curEnd; a++) {
      for (var b = nxtStart; b < nxtEnd; b++) {
        // Closest approach between pool Y ranges
        var aTop = allPools[a].top || allPools[a].gy;
        var aBot = allPools[a].bot || allPools[a].gy;
        var bTop = allPools[b].top || allPools[b].gy;
        var bBot = allPools[b].bot || allPools[b].gy;

        var yD;
        if (aBot < bTop) {
          yD = bTop - aBot;
        } else if (bBot < aTop) {
          yD = aTop - bBot;
        } else {
          yD = 0;  // pools overlap
        }

        // NO hard filter. Distance beyond the physical budget adds a
        // steep cost penalty, making the edge expensive but not impossible.
        // Dijkstra will naturally prefer edges within budget but can use
        // expensive edges when no better route exists.
        var w = _edgeWeight(elevation, cols, rows, ref,
                            allPools[a].scanGx, allPools[a].gy,
                            allPools[b].scanGx, allPools[b].gy);

        // Distance penalty: steep for exceeding the physical budget
        if (yD > 0 && colBudget > 0.01) {
          var overBudget = yD / colBudget;  // 0..N (>1 = exceeds budget)
          if (overBudget > 1) {
            // Quadratic penalty for exceeding budget — expensive but possible
            w += (overBudget - 1) * (overBudget - 1) * 2.0;
          }
          // Mild linear penalty within budget
          w += overBudget * 0.1;
        }

        // Exhaustion zone cost: resistance zones penalized, support zones favored
        w += _exhaustionEdgeCost(allPools[a].gy, allPools[b].gy, exhaustionZones);

        adj[a].push({ to: b, weight: w });
      }
    }
  }

  // Count total edges for diagnostics
  var totalEdges = 0;
  for (var ec = 0; ec < N; ec++) totalEdges += adj[ec].length;
  console.log("[Corridor] Graph: " + N + " nodes, " + totalEdges + " edges");

  // Determine endpoint scan window (computed once, used in each Dijkstra run)
  var lastColsStart;
  if (scanColumns.length >= 3) {
    lastColsStart = colStart[scanColumns.length - 3];
  } else if (scanColumns.length >= 2) {
    lastColsStart = colStart[scanColumns.length - 2];
  } else {
    lastColsStart = colStart[scanColumns.length - 1];
  }

  // ---- DIVERSITY-AWARE SELECTION with PENALTY RE-ROUTING ----
  //
  // The problem with a single Dijkstra run: it builds ONE shortest-path
  // tree, so routes to different endpoints often share all intermediate
  // pools. Filtering duplicates from one run can't CREATE new paths.
  //
  // Solution: run Dijkstra up to 3 times. After each run, mark pools
  // on selected routes as "used" and inflate edge weights for edges
  // connecting to/from used pools. This forces the next run to find
  // genuinely alternative paths through different intermediate pools.
  // N is small (50-200), so multiple runs are trivial.
  var minSep = Math.max(3, Math.floor(rows * 0.05));
  var selected = [];
  var usedPools = new Uint8Array(N);  // penalty flags per pool

  for (var dijkRun = 0; dijkRun < 3 && selected.length < 4; dijkRun++) {
    var countBefore = selected.length;  // track to detect no-progress

    // ---- Run Dijkstra with penalty weights ----
    var dist = new Float32Array(N);
    var prev = new Int32Array(N);
    var visited = new Uint8Array(N);
    for (var di = 0; di < N; di++) { dist[di] = Infinity; prev[di] = -1; }
    dist[0] = 0;

    for (var iter = 0; iter < N; iter++) {
      var u = -1, uDist = Infinity;
      for (var fi = 0; fi < N; fi++) {
        if (!visited[fi] && dist[fi] < uDist) { uDist = dist[fi]; u = fi; }
      }
      if (u < 0) break;
      visited[u] = 1;

      var edges = adj[u];
      for (var ei = 0; ei < edges.length; ei++) {
        var e = edges[ei];
        // Penalty: inflate weight for edges connecting to/from pools
        // that were used in previously-selected routes. This forces
        // Dijkstra to prefer alternative intermediate pools.
        var penalty = 1.0;
        if (usedPools[u])    penalty += 2.0;
        if (usedPools[e.to]) penalty += 2.0;
        var nd = dist[u] + e.weight * penalty;
        if (nd < dist[e.to]) {
          dist[e.to] = nd;
          prev[e.to] = u;
        }
      }
    }

    // ---- Extract routes to far-end pools ----
    var routes = [];
    for (var li = lastColsStart; li < N; li++) {
      if (dist[li] >= Infinity * 0.5) continue;  // unreachable
      var route = [];
      var cur = li;
      while (cur >= 0) {
        route.push(allPools[cur]);
        cur = prev[cur];
      }
      route.reverse();
      if (route.length < 3) continue;
      routes.push({ pools: route, cost: dist[li] });
    }
    routes.sort(function(a, b) { return a.cost - b.cost; });

    // ---- Diversity filter against ALL previously selected routes ----
    for (var si = 0; si < routes.length && selected.length < 4; si++) {
      var candidate = routes[si];
      var candEnd = candidate.pools[candidate.pools.length - 1].gy;
      var candMidIdx = Math.floor(candidate.pools.length / 2);
      var candMid = candidate.pools[candMidIdx].gy;

      var tooSimilar = false;
      for (var sj = 0; sj < selected.length; sj++) {
        var selEnd = selected[sj].pools[selected[sj].pools.length - 1].gy;
        var selMidIdx = Math.floor(selected[sj].pools.length / 2);
        var selMid = selected[sj].pools[selMidIdx].gy;

        var endDist = Math.abs(candEnd - selEnd);
        var midDist = Math.abs(candMid - selMid);

        // Primary: close endpoints = same destination, always reject
        if (endDist < minSep) {
          tooSimilar = true;
          break;
        }
        // Secondary: moderately close endpoints + very close midpoints =
        // same corridor with slightly different exit, reject
        if (endDist < minSep * 3 && midDist < minSep) {
          tooSimilar = true;
          break;
        }
      }

      if (!tooSimilar) {
        selected.push(candidate);

        // Mark pools on this route as used — next Dijkstra run will
        // penalize edges to/from these pools, forcing discovery of
        // alternative intermediate stepping stones.
        for (var pi = 0; pi < candidate.pools.length; pi++) {
          var pIdx = candidate.pools[pi]._poolIdx;
          if (pIdx != null && pIdx >= 0 && pIdx < N) {
            usedPools[pIdx] = 1;
          }
        }
      }
    }

    // If this run added nothing new, stop early — further penalty
    // won't help, the graph is exhausted for diverse paths
    if (selected.length === countBefore && dijkRun > 0) break;
  }

  return selected;
}


// Helper: compute average terrain along a line between two grid points
// ================================================================
// EXHAUSTION ZONE EDGE COST
// ================================================================
// Given an edge from gridY y1 to y2, returns an additional cost
// penalty for crossing through cannon exhaustion zones.
//
// Resistance zones (blue/upward momentum blocked) ADD cost —
// corridors should avoid routing through ceilings.
// Support zones (yellow/downward momentum blocked) SUBTRACT cost —
// corridors should prefer routing along floors.
//
// Returns a value to add to the edge weight (can be negative for support).

function _exhaustionEdgeCost(y1, y2, zones) {
  if (!zones || zones.length === 0) return 0;

  var yMin = Math.min(y1, y2);
  var yMax = Math.max(y1, y2);
  var cost = 0;

  for (var i = 0; i < zones.length; i++) {
    var z = zones[i];
    // Check if the edge's Y range overlaps this zone
    if (yMax < z.gyMin || yMin > z.gyMax) continue;

    // Overlap amount (0..1 of zone height)
    var overlapTop = Math.max(yMin, z.gyMin);
    var overlapBot = Math.min(yMax, z.gyMax);
    var overlapFrac = (overlapBot - overlapTop) / (z.gyMax - z.gyMin + 0.001);
    var weight = overlapFrac * Math.min(1, z.strength / 5);

    if (z.type === "resistance") {
      cost += weight * 0.4;   // penalize crossing resistance
    } else {
      cost -= weight * 0.15;  // mild bonus for following support
    }
  }

  return cost;
}


function _edgeWeight(elevation, cols, rows, ref, x1, y1, x2, y2) {
  var dx = x2 - x1;
  var dy = y2 - y1;
  var steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
  var sx = dx / steps;
  var sy = dy / steps;

  var totalE = 0;
  for (var s = 0; s <= steps; s++) {
    var px = Math.round(x1 + sx * s);
    var py = Math.round(y1 + sy * s);
    if (px >= 0 && px < cols && py >= 0 && py < rows) {
      totalE += elevation[py * cols + px];
    }
  }

  return (totalE / (steps + 1)) / (ref + 0.001);
}


// ================================================================
// TARGET DISCOVERY
// ================================================================
// Scan columns near the far end of the projection zone for areas
// of genuinely low terrain resistance. We average |elevation| over
// the scan window, then pick the deepest valleys as targets.
//
// The approach:
//   1. Build a smoothed vertical profile of average |elevation|
//   2. Find all rows below a low-resistance threshold
//   3. Cluster adjacent qualifying rows into valley zones
//   4. Pick the center of the best (lowest avg) zones
//
// Returns up to maxTargets well-separated targets.

function findCorridorTargets(topo, startGx, steps, maxTargets) {
  var cols = topo.cols;
  var rows = topo.rows;
  var elevation = topo.intensity;
  var ridges = topo.ridges;
  var ref = topo.refIntensity || 1;

  // Scan the final ~35% of the projection zone for targets.
  var scanStart = Math.floor(startGx + steps * 0.65);
  var scanEnd   = Math.min(startGx + steps, cols - 1);
  if (scanStart >= scanEnd) scanStart = Math.max(0, scanEnd - 3);
  if (scanStart < 0) scanStart = 0;
  var scanWidth = scanEnd - scanStart + 1;
  if (scanWidth < 1) scanWidth = 1;

  // -- Step 1: Build averaged elevation profile at the far end --
  var profile = new Float32Array(rows);
  for (var r = 0; r < rows; r++) {
    var sum = 0;
    for (var c = scanStart; c <= scanEnd; c++) {
      sum += elevation[r * cols + c];  // unsigned, no Math.abs needed
    }
    profile[r] = sum / scanWidth;
  }

  // -- Step 1b: Smooth the profile (3-cell box blur) --
  var smooth = new Float32Array(rows);
  smooth[0] = profile[0];
  smooth[rows - 1] = profile[rows - 1];
  for (var si = 1; si < rows - 1; si++) {
    smooth[si] = (profile[si - 1] + profile[si] + profile[si + 1]) / 3;
  }

  // -- Step 1c: Ridge barrier scan (issue 4) --
  // For each row, count how many ridge cells must be crossed to get
  // there from the entry Y. This penalizes targets that look great
  // at the far end but require tunneling through barriers to reach.
  // Scan the midpoint columns (30-60% of projection zone) where
  // barriers have the most impact.
  var midStart = Math.floor(startGx + steps * 0.20);
  var midEnd   = Math.floor(startGx + steps * 0.60);
  if (midStart < 0) midStart = 0;
  if (midEnd >= cols) midEnd = cols - 1;
  var midWidth = midEnd - midStart + 1;
  if (midWidth < 1) midWidth = 1;

  var ridgeBarrier = new Float32Array(rows);
  if (ridges) {
    for (var br = 0; br < rows; br++) {
      var ridgeCount = 0;
      for (var bc = midStart; bc <= midEnd; bc++) {
        if (ridges[br * cols + bc]) ridgeCount++;
      }
      ridgeBarrier[br] = ridgeCount / midWidth;  // 0..1 density
    }
    // Smooth the barrier profile too
    var barrierSmooth = new Float32Array(rows);
    barrierSmooth[0] = ridgeBarrier[0];
    barrierSmooth[rows - 1] = ridgeBarrier[rows - 1];
    for (var bsi = 1; bsi < rows - 1; bsi++) {
      barrierSmooth[bsi] = (ridgeBarrier[bsi - 1] + ridgeBarrier[bsi] + ridgeBarrier[bsi + 1]) / 3;
    }
    ridgeBarrier = barrierSmooth;
  }

  // -- Step 2: Find qualifying rows (below threshold) --
  // Factor in ridge barrier: effective elevation = profile + barrier penalty
  var threshold = ref * 0.60;  // consistent with pool discovery threshold

  // -- Step 3: Cluster adjacent qualifying rows into zones --
  var zones = [];
  var inZone = false;
  var zStart = 0;

  // Effective profile = far-end elevation + ridge barrier penalty
  var effective = new Float32Array(rows);
  for (var ei = 0; ei < rows; ei++) {
    effective[ei] = smooth[ei] + ridgeBarrier[ei] * ref * 0.5;
  }

  for (var zy = 0; zy < rows; zy++) {
    if (effective[zy] < threshold) {
      if (!inZone) {
        inZone = true;
        zStart = zy;
      }
    } else {
      if (inZone) {
        _addZone(zones, effective, zStart, zy - 1);
        inZone = false;
      }
    }
  }
  if (inZone) {
    _addZone(zones, effective, zStart, rows - 1);
  }

  // If clustering found nothing, fall back to absolute minimum
  if (zones.length === 0) {
    var fallbackBest = 0;
    var fallbackVal = Infinity;
    for (var fb = 1; fb < rows - 1; fb++) {
      if (effective[fb] < fallbackVal) {
        fallbackVal = effective[fb];
        fallbackBest = fb;
      }
    }
    zones.push({
      startRow: Math.max(0, fallbackBest - 2),
      endRow:   Math.min(rows - 1, fallbackBest + 2),
      bestRow:  fallbackBest,
      bestVal:  fallbackVal,
      avgVal:   fallbackVal,
      width:    5
    });
  }

  // -- Step 4: Sort zones by quality, pick up to maxTargets --
  zones.sort(function(a, b) {
    var scoreA = a.avgVal - (a.width / rows) * ref * 0.15;
    var scoreB = b.avgVal - (b.width / rows) * ref * 0.15;
    return scoreA - scoreB;
  });

  // Enforce minimum separation between targets
  var minSep = Math.max(4, Math.floor(rows * 0.06));
  var targets = [];
  for (var ti = 0; ti < zones.length && targets.length < maxTargets; ti++) {
    var z = zones[ti];
    var tooClose = false;
    for (var ej = 0; ej < targets.length; ej++) {
      if (Math.abs(targets[ej].gy - z.bestRow) < minSep) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) {
      targets.push({
        gy:      z.bestRow,
        absElev: z.bestVal,
        width:   z.width,
        score:   z.avgVal
      });
    }
  }

  // Final fallback
  if (targets.length === 0) {
    targets.push({ gy: Math.floor(rows / 2), absElev: 0, width: rows, score: 0 });
  }

  return targets;
}


// Helper: analyze and add a zone to the zones array.
function _addZone(zones, smooth, startRow, endRow) {
  var bestRow = startRow;
  var bestVal = smooth[startRow];
  var sum = 0;
  var count = endRow - startRow + 1;

  for (var r = startRow; r <= endRow; r++) {
    sum += smooth[r];
    if (smooth[r] < bestVal) {
      bestVal = smooth[r];
      bestRow = r;
    }
  }

  zones.push({
    startRow: startRow,
    endRow:   endRow,
    bestRow:  bestRow,
    bestVal:  bestVal,
    avgVal:   sum / count,
    width:    count
  });
}


// ================================================================
// COLUMN VALLEY FINDER (for terrain attraction during FABRIK)
// ================================================================
// For a given column, find the best low-elevation Y position near
// a reference point. This is the "seek" step of FABRIK — after
// reaching toward a neighbor, the joint seeks the nearest valley.
//
// The distance penalty is quadratic and intentionally very mild —
// barely matters within half the search radius, only kicks in at
// the edges to prevent huge jumps. This lets joints freely explore
// nearby terrain to find genuinely good valleys.
//
// Returns the Y position of the best nearby valley floor.

function findNearestValley(topo, gx, centerGy, searchRadius) {
  var cols = topo.cols;
  var rows = topo.rows;
  var elevation = topo.intensity;
  var ref = topo.refIntensity || 1;

  if (gx < 0 || gx >= cols) return centerGy;

  var bestGy = centerGy;
  var bestScore = Infinity;

  var yMin = Math.max(0, Math.round(centerGy) - searchRadius);
  var yMax = Math.min(rows - 1, Math.round(centerGy) + searchRadius);

  for (var y = yMin; y <= yMax; y++) {
    var absE = Math.abs(elevation[y * cols + gx]);
    var dist = Math.abs(y - centerGy);

    // Quadratic distance penalty: negligible close up, only matters
    // at the edge of the search radius. This lets the joint freely
    // explore nearby terrain without being glued to its position.
    var distPenalty = (dist * dist) / (searchRadius * searchRadius) * 0.15;
    var score = absE / (ref + 0.001) + distPenalty;

    if (score < bestScore) {
      bestScore = score;
      bestGy = y;
    }
  }

  return bestGy;
}


// ================================================================
// FABRIK CHAIN RELAXATION (v2 — reach-then-seek)
// ================================================================
// Iteratively relax a chain through the terrain using proper
// two-step FABRIK passes.
//
// Each joint per pass does TWO explicit steps:
//
//   1. REACH: Move partway toward the neighbor joint (the one
//      already updated this pass). This is standard FABRIK — it
//      propagates endpoint information along the chain.
//
//   2. SEEK:  From the REACHED position (not the old position),
//      find the nearest terrain valley and pull toward it.
//      Centering the search on the reached position is the
//      critical fix — it means both passes genuinely explore
//      terrain from each endpoint's perspective.
//
// The backward pass propagates "where the target is" info toward
// the start. The forward pass propagates "where the entry is"
// toward the target. After convergence, the chain settles into
// the terrain's natural corridors with smooth paths between the
// two endpoints.

function fabrikRelax(topo, chain, entryGy, targetGy, iterations, searchRadius, maxStepGy) {
  if (!iterations) iterations = 12;
  if (!searchRadius) searchRadius = 10;

  var n = chain.length;
  if (n < 3) return;

  var rows = topo.rows;
  var cols = topo.cols;
  var elevation = topo.intensity;
  var gradY = topo.gradY;
  var ref = topo.refIntensity || 1;  // vertical gradient: which way is "downhill"

  // Color bias
  var hasBias = !!(topo.colorBias && topo.maxBias > 0.001);
  var biasData = hasBias ? topo.colorBias : null;
  var biasMax  = hasBias ? topo.maxBias : 1;
  var biasStr  = (typeof state !== "undefined" && state.colorBiasForce != null)
                 ? state.colorBiasForce : 0.25;

  // Max step constraint
  var stepLimit = (maxStepGy && maxStepGy > 0) ? maxStepGy * 1.2 : 0;

  // Lock endpoints
  chain[0].gy = entryGy;
  chain[n - 1].gy = targetGy;

  // Compute the straight-line slope from entry to target.
  // This is the "boring" line — we want to deviate from it when
  // terrain offers a better path.
  var straightSlope = (targetGy - entryGy) / (n + 1);

  for (var iter = 0; iter < iterations; iter++) {

    // PROGRESSIVE CONSTANTS:
    // Early iterations: reachStr is moderate — propagate endpoint info
    //   so the chain broadly connects entry to target.
    // Later iterations: reachStr drops, terrainPull rises — the chain
    //   settles into terrain features and wraps around pressure zones.
    // This is the key insight: FABRIK's reach step is a straightening
    // force. Letting it dominate early gives good connectivity, then
    // reducing it lets terrain sculpt the final shape.
    var iterFrac = iter / iterations;  // 0..1
    var reachStr = 0.35 - iterFrac * 0.20;   // 0.35 → 0.15
    var terrainPull = 0.65 + iterFrac * 0.25; // 0.65 → 0.90

    // ---- BACKWARD PASS (from target toward start) ----
    chain[n - 1].gy = targetGy;

    for (var bi = n - 2; bi >= 1; bi--) {
      var bCurrent  = chain[bi].gy;
      var bNeighbor = chain[bi + 1].gy;

      // Step 1: TERRAIN-AWARE REACH toward forward neighbor.
      // Instead of pulling straight toward the neighbor (which cuts
      // through pressure zones), sample several Y positions between
      // current and neighbor, and pull toward the one with the lowest
      // terrain pressure. This makes the reach step itself follow
      // low-pressure paths rather than fighting them.
      var bReachY;
      var bGx = chain[bi].gx;
      if (bGx >= 0 && bGx < cols && elevation) {
        var bDelta = bNeighbor - bCurrent;
        var bBestReachY = bCurrent + bDelta * reachStr;  // linear fallback
        var bBestReachElev = Infinity;

        // Sample 5 points along the reach arc: the linear target plus
        // offsets above and below. Pick the one in lowest pressure.
        var bLinearTarget = bCurrent + bDelta * reachStr;
        var bProbeSpread = Math.abs(bDelta) * 0.4 + 2;  // wider spread for larger steps

        for (var bp = -2; bp <= 2; bp++) {
          var bProbeY = bLinearTarget + bp * (bProbeSpread / 2);
          var bProbeYr = Math.round(bProbeY);
          if (bProbeYr < 0 || bProbeYr >= rows) continue;
          var bProbeElev = elevation[bProbeYr * cols + bGx];
          // Score: elevation + mild penalty for distance from linear target
          // so we don't wander too far without good reason
          var bProbeDist = Math.abs(bProbeY - bLinearTarget);
          var bProbeScore = bProbeElev + bProbeDist * 0.05 * ref;
          if (bProbeScore < bBestReachElev) {
            bBestReachElev = bProbeScore;
            bBestReachY = bProbeY;
          }
        }
        bReachY = bBestReachY;
      } else {
        bReachY = bCurrent + (bNeighbor - bCurrent) * reachStr;
      }

      // Step 2: SEEK valley from the REACHED position
      var bValleyY = findNearestValley(topo, chain[bi].gx, bReachY, searchRadius);

      // Final position: blend reached + valley
      var bNewY = bReachY + (bValleyY - bReachY) * terrainPull;

      // Step 3: COLOR BIAS NUDGE
      if (hasBias && chain[bi].gx >= 0 && chain[bi].gx < cols) {
        var bIdx = Math.round(bNewY) * cols + chain[bi].gx;
        if (bIdx >= 0 && bIdx < biasData.length) {
          var bBias = biasData[bIdx] / biasMax;
          bNewY -= bBias * biasStr * searchRadius * 0.3;
        }
      }

      // Step 4: GRADIENT-FOLLOWING PRESSURE AVOIDANCE
      // Instead of detecting straight lines, use the terrain gradient
      // to push the joint DOWNHILL — away from pressure zones. The
      // gradient tells us which direction has less pressure nearby.
      // This naturally wraps the path around obstacles.
      //
      // Also check: if this joint is close to the straight entry→target
      // line AND sitting in significant pressure, actively push it toward
      // the nearest valley offset from the straight line. This breaks
      // the "diagonal through pressure" pattern.
      if (chain[bi].gx >= 1 && chain[bi].gx < cols - 1) {
        var bGyR = Math.round(bNewY);
        if (bGyR >= 1 && bGyR < rows - 1) {
          var bCellIdx = bGyR * cols + chain[bi].gx;

          // (a) Gradient nudge: push downhill (toward less pressure)
          // gradY points uphill; negate it to go downhill.
          if (gradY) {
            var bGradForce = -gradY[bCellIdx] * 0.5 * terrainPull;
            bNewY += bGradForce;
          }

          // (b) Straight-line escape: if sitting near the diagonal AND
          // in pressure, search for a valley away from the line.
          var bStraightY = entryGy + straightSlope * (bi + 1);
          var bDistFromStraight = Math.abs(bNewY - bStraightY);
          var bLocalPressure = elevation[bCellIdx] / (topo.refIntensity + 0.001);

          // If close to straight line AND in meaningful pressure
          if (bDistFromStraight < searchRadius * 0.4 && bLocalPressure > 0.15) {
            // Search above and below the straight line for a valley
            var bOff = searchRadius * 0.5;
            var bAltHi = findNearestValley(topo, chain[bi].gx, bStraightY - bOff, searchRadius);
            var bAltLo = findNearestValley(topo, chain[bi].gx, bStraightY + bOff, searchRadius);
            var bElHi = (Math.round(bAltHi) >= 0 && Math.round(bAltHi) < rows)
                      ? elevation[Math.round(bAltHi) * cols + chain[bi].gx] : Infinity;
            var bElLo = (Math.round(bAltLo) >= 0 && Math.round(bAltLo) < rows)
                      ? elevation[Math.round(bAltLo) * cols + chain[bi].gx] : Infinity;
            var bBestAlt = (bElHi < bElLo) ? bAltHi : bAltLo;
            var bBestAltEl = Math.min(bElHi, bElLo);
            // Pull toward the off-line valley, scaled by pressure intensity
            // Stronger pull when sitting in higher pressure
            var bEscapeStr = Math.min(0.6, bLocalPressure * 0.8) * terrainPull;
            bNewY += (bBestAlt - bNewY) * bEscapeStr;
          }
        }
      }

      // Step 5: MAX STEP CONSTRAINT
      // Clamp so the joint can't be farther from its neighbor than
      // price could physically move in that many columns.
      if (stepLimit > 0) {
        var bDelta = bNewY - chain[bi + 1].gy;
        if (bDelta > stepLimit) bNewY = chain[bi + 1].gy + stepLimit;
        if (bDelta < -stepLimit) bNewY = chain[bi + 1].gy - stepLimit;
      }

      if (bNewY < 1) bNewY = 1;
      if (bNewY > rows - 2) bNewY = rows - 2;
      chain[bi].gy = bNewY;
    }

    // ---- FORWARD PASS (from start toward target) ----
    chain[0].gy = entryGy;

    for (var fi = 1; fi < n - 1; fi++) {
      var fCurrent  = chain[fi].gy;
      var fNeighbor = chain[fi - 1].gy;

      // Step 1: TERRAIN-AWARE REACH toward backward neighbor.
      var fReachY;
      var fGx = chain[fi].gx;
      if (fGx >= 0 && fGx < cols && elevation) {
        var fDelta = fNeighbor - fCurrent;
        var fBestReachY = fCurrent + fDelta * reachStr;
        var fBestReachElev = Infinity;

        var fLinearTarget = fCurrent + fDelta * reachStr;
        var fProbeSpread = Math.abs(fDelta) * 0.4 + 2;

        for (var fp2 = -2; fp2 <= 2; fp2++) {
          var fProbeY = fLinearTarget + fp2 * (fProbeSpread / 2);
          var fProbeYr = Math.round(fProbeY);
          if (fProbeYr < 0 || fProbeYr >= rows) continue;
          var fProbeElev = elevation[fProbeYr * cols + fGx];
          var fProbeDist = Math.abs(fProbeY - fLinearTarget);
          var fProbeScore = fProbeElev + fProbeDist * 0.05 * ref;
          if (fProbeScore < fBestReachElev) {
            fBestReachElev = fProbeScore;
            fBestReachY = fProbeY;
          }
        }
        fReachY = fBestReachY;
      } else {
        fReachY = fCurrent + (fNeighbor - fCurrent) * reachStr;
      }

      // Step 2: SEEK valley from the REACHED position
      var fValleyY = findNearestValley(topo, chain[fi].gx, fReachY, searchRadius);

      // Final position: blend reached + valley
      var fNewY = fReachY + (fValleyY - fReachY) * terrainPull;

      // Step 3: COLOR BIAS NUDGE
      if (hasBias && chain[fi].gx >= 0 && chain[fi].gx < cols) {
        var fBIdx = Math.round(fNewY) * cols + chain[fi].gx;
        if (fBIdx >= 0 && fBIdx < biasData.length) {
          var fBias = biasData[fBIdx] / biasMax;
          fNewY -= fBias * biasStr * searchRadius * 0.3;
        }
      }

      // Step 4: GRADIENT-FOLLOWING PRESSURE AVOIDANCE (same as backward)
      if (chain[fi].gx >= 1 && chain[fi].gx < cols - 1) {
        var fGyR = Math.round(fNewY);
        if (fGyR >= 1 && fGyR < rows - 1) {
          var fCellIdx = fGyR * cols + chain[fi].gx;

          // (a) Gradient nudge: push downhill
          if (gradY) {
            var fGradForce = -gradY[fCellIdx] * 0.5 * terrainPull;
            fNewY += fGradForce;
          }

          // (b) Straight-line escape
          var fStraightY = entryGy + straightSlope * (fi + 1);
          var fDistFromStraight = Math.abs(fNewY - fStraightY);
          var fLocalPressure = elevation[fCellIdx] / (topo.refIntensity + 0.001);

          if (fDistFromStraight < searchRadius * 0.4 && fLocalPressure > 0.15) {
            var fOff = searchRadius * 0.5;
            var fAltHi = findNearestValley(topo, chain[fi].gx, fStraightY - fOff, searchRadius);
            var fAltLo = findNearestValley(topo, chain[fi].gx, fStraightY + fOff, searchRadius);
            var fElHi = (Math.round(fAltHi) >= 0 && Math.round(fAltHi) < rows)
                      ? elevation[Math.round(fAltHi) * cols + chain[fi].gx] : Infinity;
            var fElLo = (Math.round(fAltLo) >= 0 && Math.round(fAltLo) < rows)
                      ? elevation[Math.round(fAltLo) * cols + chain[fi].gx] : Infinity;
            var fBestAlt = (fElHi < fElLo) ? fAltHi : fAltLo;
            var fEscapeStr = Math.min(0.6, fLocalPressure * 0.8) * terrainPull;
            fNewY += (fBestAlt - fNewY) * fEscapeStr;
          }
        }
      }

      // Step 5: MAX STEP CONSTRAINT
      if (stepLimit > 0) {
        var fDelta = fNewY - chain[fi - 1].gy;
        if (fDelta > stepLimit) fNewY = chain[fi - 1].gy + stepLimit;
        if (fDelta < -stepLimit) fNewY = chain[fi - 1].gy - stepLimit;
      }

      if (fNewY < 1) fNewY = 1;
      if (fNewY > rows - 2) fNewY = rows - 2;
      chain[fi].gy = fNewY;
    }

    // Lock endpoints after each full iteration
    chain[0].gy = entryGy;
    chain[n - 1].gy = targetGy;
  }
}


// ================================================================
// PATH ENERGY SCORING (v2 — composite)
// ================================================================
// Scores a FABRIK chain on multiple criteria and returns a composite
// score. Lower = better path.
//
// FACTORS (all normalized to similar ranges, then weighted):
//
//   1. Terrain energy:     sum of elevation along the path (existing)
//   2. Ridge crossings:    penalty for segments that cross ridge cells
//   3. Corridor width:     bonus for wide corridors (more reliable)
//   4. Color bias alignment: bonus when path direction matches S/R bias
//   5. Momentum alignment:  bonus when path slope matches entry regime
//
// Parameters:
//   topo     — topology object
//   chain    — array of joint objects with { gx, gy }
//   options  — { entrySlope, entryGy } for momentum scoring
//              entrySlope: positive = trending down (pixel-Y), negative = up
//              (both optional — omitted fields just skip that factor)

function scoreChainEnergy(topo, chain, options) {
  if (!options) options = {};
  var cols = topo.cols;
  var rows = topo.rows;
  var elevation = topo.intensity;
  var ref = topo.refIntensity || 1;
  var ridges = topo.ridges;
  var biasData = topo.colorBias;
  var biasMax = topo.maxBias || 1;

  var totalEnergy = 0;
  var maxEnergy = 0;
  var totalWidth = 0;
  var ridgeCrossings = 0;
  var biasAlignment = 0;    // positive = path direction agrees with color bias
  var biasCount = 0;

  for (var i = 0; i < chain.length; i++) {
    var gx = chain[i].gx;
    var gy = Math.round(chain[i].gy);
    if (gy < 0) gy = 0;
    if (gy >= rows) gy = rows - 1;
    if (gx < 0 || gx >= cols) continue;

    var cellIdx = gy * cols + gx;
    var absE = elevation[cellIdx];  // already unsigned (total pressure)
    totalEnergy += absE;
    if (absE > maxEnergy) maxEnergy = absE;

    chain[i].elevation = absE;
    chain[i].absElev = absE;

    // ---- Corridor width: scan up/down for walls ----
    var wallThresh = ref * 0.3;
    var corrTop = gy;
    var corrBot = gy;
    for (var ct = gy - 1; ct >= 0; ct--) {
      if (elevation[ct * cols + gx] > wallThresh) break;
      corrTop = ct;
    }
    for (var cb = gy + 1; cb < rows; cb++) {
      if (elevation[cb * cols + gx] > wallThresh) break;
      corrBot = cb;
    }
    chain[i].corridorTop = corrTop;
    chain[i].corridorBot = corrBot;
    chain[i].corridorWidth = corrBot - corrTop + 1;
    totalWidth += corrBot - corrTop + 1;

    var width = corrBot - corrTop + 1;
    chain[i].clarity = Math.min(1.0, width / 20)
                     * (1.0 - Math.min(1.0, absE / ref));

    // ---- Ridge crossing detection ----
    // Check if the segment from previous joint to this one crosses
    // any ridge cells. Walk the Y span between joints at this column.
    if (i > 0 && ridges) {
      var prevGy = Math.round(chain[i - 1].gy);
      if (prevGy < 0) prevGy = 0;
      if (prevGy >= rows) prevGy = rows - 1;

      // Scan the Y range between consecutive joints at this column
      var yLo = Math.min(prevGy, gy);
      var yHi = Math.max(prevGy, gy);
      for (var ry = yLo; ry <= yHi; ry++) {
        if (ry >= 0 && ry < rows && ridges[ry * cols + gx]) {
          ridgeCrossings++;
          break;  // one crossing per segment is enough
        }
      }
    }

    // ---- Color bias alignment ----
    // Check if the path's local direction (up/down) matches the
    // color bias at this cell. Support bias (positive) should align
    // with upward paths (negative pixel-Y slope), and vice versa.
    if (biasData && i > 0) {
      var localSlope = chain[i].gy - chain[i - 1].gy;  // positive = trending down
      var localBias = biasData[cellIdx] / biasMax;       // positive = support (pushes up)
      // Good alignment: support + going up, OR resistance + going down
      // localSlope negative (up) * localBias positive (support) = negative = aligned
      // We want negative products, so negate for "bonus"
      if (Math.abs(localSlope) > 0.1 && Math.abs(localBias) > 0.05) {
        biasAlignment -= localSlope * localBias;  // positive = good alignment
        biasCount++;
      }
    }
  }

  // ---- Momentum alignment (issue 1) ----
  // Does the overall path slope match the entry regime?
  // entrySlope: from detectRegime — positive score = bullish = trending up = negative pixel-Y
  var momentumScore = 0;
  if (chain.length > 2 && options.entrySlope != null) {
    // Path slope in pixel-Y: positive = path goes down, negative = goes up
    var pathSlope = (chain[chain.length - 1].gy - chain[0].gy) / chain.length;

    // entrySlope: positive = bullish regime = price going UP = pixel-Y going DOWN
    // So alignment = entrySlope * (-pathSlope): both positive when aligned
    momentumScore = options.entrySlope * (-pathSlope);
    // Normalize to roughly -1..+1 range
    if (momentumScore > 2) momentumScore = 2;
    if (momentumScore < -2) momentumScore = -2;
  }

  // ---- Composite score (lower = better) ----
  var n = chain.length || 1;
  var avgEnergy = totalEnergy / n;
  var avgWidth = totalWidth / n;

  // Energy: already in ref-relative units. Lower = better.
  var energyScore = avgEnergy / (ref + 0.001);

  // Width bonus
  var widthPenalty = 1.0 - Math.min(1.0, avgWidth / 25);

  // Ridge penalty
  var ridgePenalty = ridgeCrossings / (n * 0.5 + 1);

  // Bias alignment
  var biasScore = (biasCount > 0) ? biasAlignment / biasCount : 0;
  if (biasScore > 1) biasScore = 1;
  if (biasScore < -1) biasScore = -1;

  // Straightness penalty: measure how much the path deviates from
  // a straight line between its endpoints. Paths that just draw a
  // diagonal through pressure get penalized. Paths that curve around
  // terrain get rewarded.
  //
  // Compute the mean absolute deviation from the entry→target line.
  // Zero deviation = perfectly straight = maximum penalty.
  var straightPenalty = 0;
  if (n > 4) {
    var entryY = chain[0].gy;
    var endY   = chain[n - 1].gy;
    var lineSlope = (endY - entryY) / n;
    var totalDeviation = 0;

    for (var di = 1; di < n - 1; di++) {
      var expectedY = entryY + lineSlope * (di + 1);
      totalDeviation += Math.abs(chain[di].gy - expectedY);
    }

    var avgDeviation = totalDeviation / (n - 2);
    // Normalize: deviation as fraction of grid height.
    // Paths with < 2% deviation are considered straight.
    var devFraction = avgDeviation / (rows * 0.02 + 1);
    // Penalty: 1.0 for perfectly straight, 0 at 100%+ deviation
    straightPenalty = Math.max(0, 1.0 - devFraction);
  }

  // ---- Exhaustion zone alignment ----
  // Paths that sit on support zones get a bonus (lower score).
  // Paths that cross through resistance zones get a penalty (higher score).
  // This helps corridors route around momentum ceilings and along floors.
  var exhaustionScore = 0;
  var exhZones = options.exhaustionZones;
  if (exhZones && exhZones.length > 0 && n > 1) {
    var exhHits = 0;
    for (var ei = 0; ei < chain.length; ei++) {
      var eGy = chain[ei].gy;
      for (var ezi = 0; ezi < exhZones.length; ezi++) {
        var ez = exhZones[ezi];
        if (eGy >= ez.gyMin && eGy <= ez.gyMax) {
          var ezStr = Math.min(1, ez.strength / 5);
          if (ez.type === "resistance") {
            exhaustionScore += ezStr;   // penalty for being inside resistance
          } else {
            exhaustionScore -= ezStr * 0.5;  // mild bonus for following support
          }
          exhHits++;
        }
      }
    }
    if (exhHits > 0) {
      exhaustionScore /= n;  // normalize by chain length
    }
  }

  // Combine: energy is primary, others adjust it
  var compositeScore = energyScore * 1.0            // primary: terrain energy
                     + widthPenalty * 0.25           // narrow corridors penalized
                     + ridgePenalty * 0.40           // ridge crossings heavily penalized
                     + straightPenalty * 0.30        // straight lines penalized
                     - biasScore * 0.15              // bias-aligned paths favored
                     - momentumScore * 0.20          // momentum-aligned paths favored
                     + exhaustionScore * 0.25;       // exhaustion zones: resistance penalized, support favored

  return {
    totalEnergy:    totalEnergy,
    maxEnergy:      maxEnergy,
    avgEnergy:      avgEnergy,
    avgWidth:       avgWidth,
    ridgeCrossings: ridgeCrossings,
    biasScore:      biasScore,
    momentumScore:  momentumScore,
    straightPenalty: straightPenalty,
    exhaustionScore: exhaustionScore,
    compositeScore: compositeScore
  };
}


// ================================================================
// MAIN ENTRY: traceCorridors (v3 — pool-routed FABRIK)
// ================================================================
// Parameters:
//   topo, entryGx, entryGy, steps, numScouts, spreadPx — as before
//   options — (optional) {
//     entrySlope: number — regime score (positive = bullish)
//     maxStepGy:  number — max Y movement per column in grid cells
//   }

function traceCorridors(topo, entryGx, entryGy, steps, numScouts, spreadPx, options) {
  if (!options) options = {};
  var cols = topo.cols;
  var rows = topo.rows;
  var ref = topo.refIntensity || 1;
  var maxStepGy = options.maxStepGy || 0;

  // ---- STEP 1: Discover pools along the route ----
  // Scan interval adapts to maxStepGy so that the vertical reach
  // between adjacent scan columns (maxStepGy × interval) is at least
  // targetReach cells. This ensures the graph stays connected even
  // when individual candle moves are small.
  var endGx = Math.min(entryGx + steps, cols - 1);
  var targetReach = 3;  // want at least 3 cells of Y reach between scans
  var scanInterval;
  if (maxStepGy > 0.01) {
    scanInterval = Math.round(targetReach / maxStepGy);
    if (scanInterval < 2) scanInterval = 2;
    if (scanInterval > 5) scanInterval = 5;  // never skip more than 5 columns
  } else {
    scanInterval = Math.max(3, Math.min(5, Math.floor(steps / 25)));
  }
  var scanColumns = discoverPools(topo, entryGx, endGx, scanInterval);

  // ---- Diagnostic logging ----
  var totalPools = 0;
  for (var dci = 0; dci < scanColumns.length; dci++) {
    totalPools += scanColumns[dci].pools.length;
  }
  console.log("[Corridor] Pool discovery: " + totalPools + " pools across "
    + scanColumns.length + " columns (interval " + scanInterval
    + ", reach " + (maxStepGy > 0.01 ? (maxStepGy * scanInterval).toFixed(1) : "n/a")
    + " cells, threshold " + (topo.refIntensity * 0.60).toFixed(1) + ")");

  // ---- STEP 2: Graph-route through pools ----
  // Dijkstra finds cheapest paths from entry to far-end pools,
  // respecting the maxStepGy constraint.
  var routes = routeThroughPools(scanColumns, topo, entryGy, maxStepGy, options.exhaustionZones || null);

  console.log("[Corridor] Graph routing: " + routes.length + " diverse routes"
    + (routes.length > 0 ? " (best cost: " + routes[0].cost.toFixed(2)
      + ", " + routes[0].pools.length + " waypoints)" : "")
    + ", maxStepGy=" + maxStepGy.toFixed(1) + ", pools=" + totalPools
    + ", endpoints=[" + routes.map(function(r) {
        return r.pools[r.pools.length - 1].gy;
      }).join(", ") + "]");

  // ---- STEP 3: Also find far-end targets (fallback + additional paths) ----
  var maxTargets = 4;
  var farTargets = findCorridorTargets(topo, entryGx, steps, maxTargets);

  // ---- STEP 4: Build chains ----
  // Goal: at least 2 paths, up to 4. Sources:
  //   1. Graph routes (pool-routed Dijkstra paths) — already diversity-filtered
  //   2. Far-end targets — only used if they cover uncovered terrain, OR
  //      to fill remaining slots when graph found fewer than 4
  //   3. Spread paths (above/below entry if we still need more)
  //
  // STRATEGY: Let graph routes fill all 4 slots first (the diversity
  // filter in routeThroughPools ensures they're well-separated). Then
  // check far-end targets: if any covers terrain NOT represented by
  // existing chains, REPLACE the worst-cost graph route. This avoids
  // the old problem where a hard cap of 3 dropped a genuinely diverse
  // graph route (e.g. endpoint 0) only to replace it with a far-end
  // target at Y=36, right next to an existing route at Y=37.
  var chains = [];
  var minSepChain = Math.max(4, Math.floor(rows * 0.05));

  // (A) From graph routes: seed chain along discovered stepping stones
  for (var ri = 0; ri < routes.length && chains.length < 4; ri++) {
    var route = routes[ri].pools;
    if (route.length < 2) continue;

    var targetGy = route[route.length - 1].gy;
    var chain = _buildChainFromRoute(route, entryGx, entryGy, steps, cols, rows);
    if (chain.length < 2) continue;

    chains.push({
      targetGy: targetGy,
      targetInfo: { gy: targetGy, absElev: 0, width: 1, score: routes[ri].cost },
      joints: chain,
      source: "graph"
    });
  }

  // (B) Far-end targets: check if any covers uncovered terrain.
  // "Uncovered" = far enough from ALL existing chain targets.
  // If we find one, replace the worst-cost chain (highest route cost).
  // If chains has room (< 4), just append instead of replacing.
  //
  // Also check midpoint coverage: a far-end target might end near
  // an existing chain but take a completely different path to get there.
  // We check endpoint distance only — FABRIK will sculpt the path.
  if (chains.length >= 4) {
    // All 4 slots taken by graph routes — check for uncovered far-end targets
    for (var ti = 0; ti < farTargets.length; ti++) {
      var tgt = farTargets[ti];
      var covered = false;
      for (var ci2 = 0; ci2 < chains.length; ci2++) {
        if (Math.abs(chains[ci2].targetGy - tgt.gy) < minSepChain) {
          covered = true;
          break;
        }
      }
      if (covered) continue;

      // Found an uncovered far-end target — replace the worst chain.
      // "Worst" = highest route cost among graph routes, preferring
      // to keep the best-cost routes intact.
      var worstIdx = -1;
      var worstCost = -Infinity;
      for (var wi = 0; wi < chains.length; wi++) {
        if (chains[wi].source === "graph" && chains[wi].targetInfo.score > worstCost) {
          worstCost = chains[wi].targetInfo.score;
          worstIdx = wi;
        }
      }
      if (worstIdx < 0) break;  // no graph chains to replace (shouldn't happen)

      // Build the replacement chain
      var replChain = [];
      for (var rs = 0; rs < steps; rs++) {
        var rgx = entryGx + rs + 1;
        if (rgx >= cols) break;
        var rt = (rs + 1) / steps;
        replChain.push({
          gx: rgx,
          gy: entryGy + (tgt.gy - entryGy) * rt,
          elevation: 0, absElev: 0,
          corridorTop: 0, corridorBot: rows - 1,
          corridorWidth: rows, clarity: 0.5
        });
      }
      if (replChain.length >= 2) {
        chains[worstIdx] = {
          targetGy: tgt.gy,
          targetInfo: tgt,
          joints: replChain,
          source: "linear"
        };
        break;  // only replace one — don't gut all graph routes
      }
    }
  } else {
    // Graph found fewer than 4 routes — fill remaining slots from far-end targets.
    // ALWAYS enforce minimum separation — adding a target 1-2 cells from
    // an existing chain is never useful, even when we desperately need more
    // paths. Use a tighter threshold (half of minSepChain, minimum 2) when
    // we have fewer than 2 chains so we don't block everything.
    var tightSep = Math.max(2, Math.floor(minSepChain * 0.5));
    for (var ti2 = 0; ti2 < farTargets.length && chains.length < 4; ti2++) {
      var tgt2 = farTargets[ti2];

      // Always dedup — use tighter threshold when starved for chains
      var sepThresh = (chains.length < 2) ? tightSep : minSepChain;
      var covered2 = false;
      for (var ci3 = 0; ci3 < chains.length; ci3++) {
        if (Math.abs(chains[ci3].targetGy - tgt2.gy) < sepThresh) {
          covered2 = true;
          break;
        }
      }
      if (covered2) continue;

      var chain2 = [];
      for (var step = 0; step < steps; step++) {
        var gx = entryGx + step + 1;
        if (gx >= cols) break;
        var t = (step + 1) / steps;
        chain2.push({
          gx: gx,
          gy: entryGy + (tgt2.gy - entryGy) * t,
          elevation: 0, absElev: 0,
          corridorTop: 0, corridorBot: rows - 1,
          corridorWidth: rows, clarity: 0.5
        });
      }
      if (chain2.length >= 2) {
        chains.push({
          targetGy: tgt2.gy,
          targetInfo: tgt2,
          joints: chain2,
          source: "linear"
        });
      }
    }
  }

  // (C) Spread paths: if we STILL have fewer than 2, generate one
  // above and one below the entry. These explore the full vertical
  // range and will get pulled into terrain by FABRIK.
  if (chains.length < 2) {
    var spreadTargets = [
      Math.max(2, entryGy - Math.floor(rows * 0.2)),
      Math.min(rows - 3, entryGy + Math.floor(rows * 0.2))
    ];
    // Also add entry-level horizontal if we have zero chains
    if (chains.length === 0) {
      spreadTargets.unshift(entryGy);
    }
    for (var si = 0; si < spreadTargets.length && chains.length < 4; si++) {
      var sTarget = spreadTargets[si];
      var sChain = [];
      for (var ss = 0; ss < steps; ss++) {
        var sgx = entryGx + ss + 1;
        if (sgx >= cols) break;
        var st = (ss + 1) / steps;
        sChain.push({
          gx: sgx,
          gy: entryGy + (sTarget - entryGy) * st,
          elevation: 0, absElev: 0,
          corridorTop: 0, corridorBot: rows - 1,
          corridorWidth: rows, clarity: 0.5
        });
      }
      if (sChain.length >= 2) {
        chains.push({
          targetGy: sTarget,
          targetInfo: { gy: sTarget, absElev: 0, width: rows, score: 0 },
          joints: sChain,
          source: "spread"
        });
      }
    }
  }

  // (D) CONTRARIAN PATH — the intentional odd duck.
  //
  // After graph routes, far-end targets, and spread paths have been placed,
  // all chains tend to follow the same general terrain slope. If 3 paths
  // say "price goes down," we want one path that shows the best route UP.
  // This gives the prediction engine a genuine alternative to consider,
  // not just variations of the same direction.
  //
  // ALGORITHM:
  //   1. Compute consensus: average endpoint Y of all chains relative to entry.
  //      Positive delta = consensus is below entry (bearish in pixel-Y).
  //      Negative delta = consensus is above entry (bullish).
  //   2. Contrarian direction = opposite of consensus.
  //   3. Scan the far-end terrain profile for the best valley in the
  //      contrarian Y-band. Must be a real low-pressure zone, not random.
  //   4. If the contrarian target is genuinely different from all existing
  //      chains (minSepChain), take the 4th slot — either fill it or
  //      replace the worst-cost chain.
  if (chains.length >= 2) {
    // Step 1: consensus direction
    var consensusSum = 0;
    for (var cdi = 0; cdi < chains.length; cdi++) {
      consensusSum += (chains[cdi].targetGy - entryGy);
    }
    var consensusAvg = consensusSum / chains.length;  // positive = bearish (below entry)

    // Step 2: contrarian search band
    // If consensus is bearish (targets below entry), search above entry.
    // If consensus is bullish (targets above entry), search below entry.
    // The search band is the half of the grid opposite to the consensus.
    var contrarianSearchTop, contrarianSearchBot;
    if (consensusAvg > 0) {
      // Consensus is below entry → contrarian searches ABOVE entry (lower Y values)
      contrarianSearchTop = 1;
      contrarianSearchBot = Math.max(1, entryGy - 2);  // include a little below entry
    } else {
      // Consensus is above entry → contrarian searches BELOW entry (higher Y values)
      contrarianSearchTop = Math.min(rows - 2, entryGy + 2);  // include a little above entry
      contrarianSearchBot = rows - 2;
    }

    // Step 3: scan far-end terrain for the best valley in the contrarian band.
    // Reuse the same far-end scan window as findCorridorTargets (last ~35%).
    var ctScanStart = Math.floor(entryGx + steps * 0.65);
    var ctScanEnd   = Math.min(entryGx + steps, cols - 1);
    if (ctScanStart >= ctScanEnd) ctScanStart = Math.max(0, ctScanEnd - 3);
    var ctScanWidth = ctScanEnd - ctScanStart + 1;
    if (ctScanWidth < 1) ctScanWidth = 1;

    var ctBestY = -1;
    var ctBestElev = Infinity;
    for (var cty = contrarianSearchTop; cty <= contrarianSearchBot; cty++) {
      var ctSum = 0;
      for (var ctx = ctScanStart; ctx <= ctScanEnd; ctx++) {
        ctSum += topo.intensity[cty * cols + ctx];
      }
      var ctAvg = ctSum / ctScanWidth;
      // Mild distance penalty from entry — don't wander to the absolute
      // edge of the grid if there's a decent valley closer to entry
      var ctDistPenalty = Math.abs(cty - entryGy) / (rows * 0.3 + 1) * ref * 0.1;
      var ctScore = ctAvg + ctDistPenalty;
      if (ctScore < ctBestElev) {
        ctBestElev = ctScore;
        ctBestY = cty;
      }
    }

    // Step 4: check if the contrarian target is genuinely different
    if (ctBestY >= 0) {
      var ctCovered = false;
      for (var ctci = 0; ctci < chains.length; ctci++) {
        if (Math.abs(chains[ctci].targetGy - ctBestY) < minSepChain) {
          ctCovered = true;
          break;
        }
      }

      if (!ctCovered) {
        // Build the contrarian chain (linear seed — FABRIK will sculpt it)
        var ctChain = [];
        for (var cts = 0; cts < steps; cts++) {
          var ctgx = entryGx + cts + 1;
          if (ctgx >= cols) break;
          var ctt = (cts + 1) / steps;
          ctChain.push({
            gx: ctgx,
            gy: entryGy + (ctBestY - entryGy) * ctt,
            elevation: 0, absElev: 0,
            corridorTop: 0, corridorBot: rows - 1,
            corridorWidth: rows, clarity: 0.5
          });
        }

        if (ctChain.length >= 2) {
          if (chains.length < 4) {
            // Empty slot — just append
            chains.push({
              targetGy: ctBestY,
              targetInfo: { gy: ctBestY, absElev: ctBestElev, width: 1, score: 0 },
              joints: ctChain,
              source: "contra"
            });
          } else {
            // All 4 slots taken — replace the worst-cost chain.
            // The contrarian is the odd duck, so it gets priority over
            // the worst consensus path.
            var ctWorstIdx = -1;
            var ctWorstCost = -Infinity;
            for (var ctwi = 0; ctwi < chains.length; ctwi++) {
              var ctCost = chains[ctwi].targetInfo.score || 0;
              if (ctCost > ctWorstCost) {
                ctWorstCost = ctCost;
                ctWorstIdx = ctwi;
              }
            }
            if (ctWorstIdx >= 0) {
              chains[ctWorstIdx] = {
                targetGy: ctBestY,
                targetInfo: { gy: ctBestY, absElev: ctBestElev, width: 1, score: 0 },
                joints: ctChain,
                source: "contra"
              };
            }
          }
        }
      }
    }
  }
  // ---- STEP 5: FABRIK relaxation ----
  var graphCount = 0, linearCount = 0, spreadCount = 0, contraCount = 0;
  for (var lci = 0; lci < chains.length; lci++) {
    if (chains[lci].source === "graph") graphCount++;
    else if (chains[lci].source === "linear") linearCount++;
    else if (chains[lci].source === "contra") contraCount++;
    else spreadCount++;
  }
  console.log("[Corridor] " + chains.length + " chains built (graph:"
    + graphCount + " linear:" + linearCount + " contra:" + contraCount
    + " spread:" + spreadCount
    + ") targets=[" + chains.map(function(c) {
        return c.source[0] + ":" + c.targetGy;
      }).join(", ") + "]");
  var iters = Math.min(25, Math.max(14, Math.floor(steps / 2)));
  var searchRad = Math.max(8, Math.min(15, Math.floor(rows * 0.08)));
  var stepLimit = (maxStepGy && maxStepGy > 0) ? maxStepGy * 1.2 : 0;

  for (var ci = 0; ci < chains.length; ci++) {
    fabrikRelax(
      topo,
      chains[ci].joints,
      entryGy,
      chains[ci].targetGy,
      iters,
      searchRad,
      maxStepGy
    );

    // ---- POST-FABRIK: Pressure ceiling + straight-segment breaking ----
    // Two-pass cleanup on the relaxed chain:
    //
    // PASS 1: PRESSURE CEILING
    //   Any joint sitting in a cell with pressure above a threshold
    //   gets forced to the nearest cell below the threshold. This is
    //   a hard constraint — the corridor CANNOT recommend sitting in
    //   high pressure. FABRIK's soft nudges aren't enough.
    //
    // PASS 2: STRAIGHT-SEGMENT DETECTION (ray intersection)
    //   Same technique as the prediction engine: shoot a ray from
    //   start to end of a segment window, count how many intermediate
    //   joints the ray intersects. If it hits too many (= straight line),
    //   force the middle joints off the ray toward nearby valleys.

    var cJoints = chains[ci].joints;
    var cN = cJoints.length;
    var cTargetGy = chains[ci].targetGy;

    // -- PASS 1: Pressure ceiling --
    var pressureCeiling = ref * 0.35;  // joints must be below 35% of ref

    for (var pc = 1; pc < cN - 1; pc++) {
      var pcGx = cJoints[pc].gx;
      var pcGy = Math.round(cJoints[pc].gy);
      if (pcGx < 0 || pcGx >= cols || pcGy < 0 || pcGy >= rows) continue;

      var pcPressure = topo.intensity[pcGy * cols + pcGx];
      if (pcPressure <= pressureCeiling) continue;

      // Joint is in high pressure — find nearest cell below ceiling
      var bestPcY = pcGy;
      var bestPcDist = Infinity;
      var pcSearchR = searchRad * 2;  // wider search for escape

      for (var pcy = Math.max(0, pcGy - pcSearchR); pcy < Math.min(rows, pcGy + pcSearchR); pcy++) {
        var pcElev = topo.intensity[pcy * cols + pcGx];
        if (pcElev < pressureCeiling) {
          var pcDist = Math.abs(pcy - pcGy);
          if (pcDist < bestPcDist) {
            bestPcDist = pcDist;
            bestPcY = pcy;
          }
        }
      }

      // No step limit for pressure ceiling — this is an emergency move.
      // If a joint is inside high pressure, it MUST get out. The overall
      // path will be smoothed by subsequent FABRIK-like passes or by
      // the prediction engine's own step constraints.
      cJoints[pc].gy = bestPcY;
    }

    // -- PASS 2: Straight-segment breaking (ray intersection) --
    // Slide a window along the chain. For each window, shoot a ray
    // from the first to last joint. If all intermediate joints sit
    // within 1.5 cells of the ray (= straight line), force the
    // middle ones toward off-ray valleys.
    //
    // Step limit for ray-breaking: use searchRadius instead of the
    // tight per-candle stepLimit. These are deliberate corrections
    // that need room to actually move off the diagonal.
    var rayStepLimit = Math.max(searchRad * 0.5, stepLimit * 3);
    var windowSize = Math.max(6, Math.floor(cN * 0.15));

    // Run the straight-segment breaking 2-3 times — breaking one segment
    // can create or reveal another nearby.
    for (var cleanIter = 0; cleanIter < 3; cleanIter++) {

    for (var ws = 0; ws < cN - windowSize; ws += Math.floor(windowSize * 0.5)) {
      var we = ws + windowSize;
      if (we >= cN) we = cN - 1;

      var rayStartY = cJoints[ws].gy;
      var rayEndY   = cJoints[we].gy;
      var rayLen    = we - ws;
      var raySlope  = (rayEndY - rayStartY) / rayLen;

      // Count how many intermediate joints are on the ray
      var onRay = 0;
      for (var rj = ws + 1; rj < we; rj++) {
        var expectedY = rayStartY + raySlope * (rj - ws);
        if (Math.abs(cJoints[rj].gy - expectedY) < 1.5) {
          onRay++;
        }
      }

      // If >70% of intermediate joints are on the ray, it's straight
      var intermediateCount = we - ws - 1;
      if (intermediateCount > 3 && onRay > intermediateCount * 0.7) {
        // Force middle joints off the ray
        var midStart = ws + Math.floor(rayLen * 0.25);
        var midEnd   = ws + Math.floor(rayLen * 0.75);

        for (var mj = midStart; mj <= midEnd; mj++) {
          if (mj <= 0 || mj >= cN - 1) continue;

          var mjGx = cJoints[mj].gx;
          if (mjGx < 0 || mjGx >= cols) continue;

          var mjRayY = rayStartY + raySlope * (mj - ws);

          // Search for the best valley AWAY from the ray.
          // Score strongly rewards distance from the ray while still
          // preferring low elevation. The 0.15 factor means 7 cells of
          // distance offsets roughly 1.0 units of normalized elevation.
          var mjSearchR = searchRad;
          var mjBestY = cJoints[mj].gy;
          var mjBestScore = Infinity;

          for (var msy = Math.max(0, Math.round(mjRayY) - mjSearchR);
               msy < Math.min(rows, Math.round(mjRayY) + mjSearchR); msy++) {
            var msElev = topo.intensity[msy * cols + mjGx];
            var msDistFromRay = Math.abs(msy - mjRayY);
            // Elevation cost minus distance-from-ray bonus.
            // Negative bonus = strongly prefer off-ray cells.
            var msScore = msElev / (ref + 0.001) - msDistFromRay * 0.15;
            if (msScore < mjBestScore) {
              mjBestScore = msScore;
              mjBestY = msy;
            }
          }

          // Apply generous step constraint for ray-breaking corrections
          if (rayStepLimit > 0) {
            var mjPrev = cJoints[mj - 1].gy;
            if (mjBestY > mjPrev + rayStepLimit) mjBestY = mjPrev + rayStepLimit;
            if (mjBestY < mjPrev - rayStepLimit) mjBestY = mjPrev - rayStepLimit;
          }

          cJoints[mj].gy = mjBestY;
        }
      }
    }

    } // end cleanIter
  }

  // ---- STEP 6: Score, rank, and apply temporal continuity ----
  var scoreOpts = {
    entrySlope: options.entrySlope || 0,
    exhaustionZones: options.exhaustionZones || null
  };

  // 6a. Score all chains on terrain quality (same as before)
  for (var si = 0; si < chains.length; si++) {
    chains[si].score = scoreChainEnergy(topo, chains[si].joints, scoreOpts);
  }

  // 6b. TEMPORAL CONTINUITY BONUS
  //
  // If entryGx changed too much (new data load), reset memory — stale
  // paths from a different chart are meaningless. Otherwise, match each
  // current chain to the closest previous-frame path and adjust its
  // composite score with a stability bonus.
  //
  // The bonus is rank-weighted: a chain that matches the previous
  // frame's #1 path gets a bigger bonus than one matching #4.
  // This creates natural hysteresis — the best path won't suddenly
  // jump to worst unless the terrain genuinely shifts. Over 2-3
  // frames of worsening terrain, it will gracefully demote instead.
  //
  // Match criteria: endpoint within matchRadius. Midpoint matching is
  // too volatile during animation — as scan columns advance by 1 each
  // frame, pool discovery shifts and intermediate joints can move
  // significantly even for "the same" path. The endpoint is the stable
  // identity of a corridor path.
  //
  // Multi-frame memory: each stored path carries a "strength" that
  // decays exponentially. A path that held rank 0 for 5 frames has
  // built up strong continuity; a path that appeared once fades fast.
  if (Math.abs(_prevEntryGx - entryGx) > 5) {
    // Large jump in entry position — new data loaded or big skip.
    // Previous paths are from a different context, discard them.
    _prevPaths = [];
  }

  if (_prevPaths.length > 0) {
    var matchRadius = Math.max(8, Math.floor(rows * 0.12));
    // Max bonus: 0.40 for a strong match to the previous best path.
    // This is significant relative to typical composite score differences
    // of 0.1-0.5 between adjacent ranks — enough to hold a path for
    // 2-3 frames of gradual terrain degradation before it demotes.
    var maxBonus = 0.40;
    var usedPrev = [];  // track which prev paths are already matched

    for (var ci = 0; ci < chains.length; ci++) {
      var cEnd = chains[ci].targetGy;

      var bestMatch = -1;
      var bestMatchDist = Infinity;

      for (var pi = 0; pi < _prevPaths.length; pi++) {
        if (usedPrev[pi]) continue;  // already matched to another chain

        var endDist = Math.abs(cEnd - _prevPaths[pi].endGy);

        if (endDist < matchRadius) {
          if (endDist < bestMatchDist) {
            bestMatchDist = endDist;
            bestMatch = pi;
          }
        }
      }

      if (bestMatch >= 0) {
        usedPrev[bestMatch] = true;
        // Rank-weighted bonus: rank 0 gets full maxBonus, rank 3 gets ~20%
        var prevRank = _prevPaths[bestMatch].rank;  // 0..N
        var prevTotal = _prevPaths[bestMatch].total || 4;
        var rankFrac = prevRank / (prevTotal - 1 + 0.001);  // 0 = best, 1 = worst
        var bonus = maxBonus * (1.0 - rankFrac * 0.8);  // best: 0.40, worst: 0.08

        // Strength: accumulated from previous frames. Decays each frame
        // but builds up when a path holds its rank consistently.
        var strength = _prevPaths[bestMatch].strength || 1.0;
        bonus *= Math.min(1.5, strength);  // cap at 1.5× so it can't dominate forever

        // Distance decay: bonus fades as the match gets less precise
        var distFade = 1.0 - (bestMatchDist / (matchRadius * 1.5));
        if (distFade < 0.15) distFade = 0.15;
        bonus *= distFade;

        chains[ci].score.continuityBonus = bonus;
        chains[ci].score.compositeScore -= bonus;
        chains[ci]._matchedPrevIdx = bestMatch;
        chains[ci]._prevStrength = _prevPaths[bestMatch].strength || 1.0;
      } else {
        chains[ci].score.continuityBonus = 0;
        chains[ci]._matchedPrevIdx = -1;
        chains[ci]._prevStrength = 0;
      }
    }
  }

  // 6c. Sort by adjusted composite score
  chains.sort(function(a, b) {
    return a.score.compositeScore - b.score.compositeScore;
  });

  // 6d. Store current frame's path signatures for next frame.
  // Capture AFTER sorting so rank indices are correct.
  //
  // Strength accumulation: if a chain matched a previous path, its
  // strength grows (decayed carry-forward + 1.0 for surviving).
  // Unmatched paths start at 1.0. Strength decays by 0.7× per frame,
  // so a path that disappears fades in ~3 frames, but one that holds
  // for 5+ frames resists rank changes strongly.
  _prevPaths = [];
  for (var spi = 0; spi < chains.length; spi++) {
    var spJoints = chains[spi].joints;
    var spMidIdx = Math.floor(spJoints.length / 2);

    // Carry forward: decay previous strength + 1.0 for surviving this frame
    var spStrength = (chains[spi]._prevStrength || 0) * 0.7 + 1.0;
    if (spStrength > 3.0) spStrength = 3.0;  // cap to prevent runaway

    _prevPaths.push({
      endGy:    chains[spi].targetGy,
      midGy:    (spMidIdx >= 0 && spMidIdx < spJoints.length)
                ? spJoints[spMidIdx].gy : chains[spi].targetGy,
      rank:     spi,
      total:    chains.length,
      source:   chains[spi].source,
      strength: spStrength
    });
  }
  _prevEntryGx = entryGx;

  // ---- STEP 7: Build output waypoints from best chain ----
  var bestChain = chains[0].joints;
  var waypoints = [];

  for (var wi = 0; wi < bestChain.length; wi++) {
    var j = bestChain[wi];
    var jGyInt = Math.round(j.gy);
    if (jGyInt < 0) jGyInt = 0;
    if (jGyInt >= rows) jGyInt = rows - 1;

    waypoints.push({
      gx:             j.gx,
      bestY:          j.gy,
      bestYInt:       jGyInt,
      corridorTop:    j.corridorTop,
      corridorBot:    j.corridorBot,
      corridorWidth:  j.corridorWidth,
      elevation:      j.elevation,
      clarity:        j.clarity,
      aliveScouts:    chains.length,
      totalScouts:    chains.length,
      bestScoutY:     j.gy
    });
  }

  waypoints.paths = chains;
  // waypoints.poolDebug = scanColumns;  // disabled — debug overlay removed
  return waypoints;
}


// ================================================================
// Build a FABRIK chain seeded along a pool route
// ================================================================
// Interpolates joint positions between pool waypoints so the chain
// starts near the discovered stepping stones instead of on a straight
// line. One joint per column from entryGx+1 to entryGx+steps.

function _buildChainFromRoute(route, entryGx, entryGy, steps, cols, rows) {
  // Build a lookup: for each grid-X, what Y does the route suggest?
  // The route has sparse waypoints (every scanInterval columns).
  // Interpolate linearly between them.
  var waypoints = [{ gx: entryGx, gy: entryGy }];
  for (var ri = 0; ri < route.length; ri++) {
    waypoints.push({ gx: route[ri].scanGx, gy: route[ri].gy });
  }

  var chain = [];
  var wpIdx = 0;

  for (var step = 0; step < steps; step++) {
    var gx = entryGx + step + 1;
    if (gx >= cols) break;

    // Advance waypoint index until gx is between wpIdx and wpIdx+1
    while (wpIdx < waypoints.length - 2 && waypoints[wpIdx + 1].gx < gx) {
      wpIdx++;
    }

    // Interpolate Y between adjacent waypoints
    var wp0 = waypoints[wpIdx];
    var wp1 = waypoints[Math.min(wpIdx + 1, waypoints.length - 1)];
    var t = (wp1.gx !== wp0.gx)
          ? (gx - wp0.gx) / (wp1.gx - wp0.gx)
          : 0;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    var initGy = wp0.gy + (wp1.gy - wp0.gy) * t;

    chain.push({
      gx: gx,
      gy: initGy,
      elevation: 0,
      absElev: 0,
      corridorTop: 0,
      corridorBot: rows - 1,
      corridorWidth: rows,
      clarity: 0.5
    });
  }

  return chain;
}


// ================================================================
// CORRIDOR SIGNAL (for prediction step loop)
// ================================================================
// Same interface — projection.js calls this unchanged.

function corridorSignal(corridors, step, currentGy, maxStepGy) {
  if (!corridors || step >= corridors.length || step < 0) {
    return { signal: 0, clarity: 0, targetY: currentGy };
  }

  var wp = corridors[step];

  // --- IMMEDIATE PULL: spring toward corridor center ---
  var delta = wp.bestY - currentGy;
  var pullSig = delta / (maxStepGy + 0.001);
  if (pullSig > 1) pullSig = 1;
  if (pullSig < -1) pullSig = -1;

  // --- TRAJECTORY: where is the corridor going? ---
  var trajSig = 0;
  var lookSteps = Math.min(8, corridors.length - step - 1);
  if (lookSteps >= 2) {
    var weightedSlope = 0;
    var totalWeight = 0;
    for (var la = 1; la <= lookSteps; la++) {
      var futureWp = corridors[step + la];
      var slope = futureWp.bestY - wp.bestY;
      var w = 1.0 / la;
      weightedSlope += slope * w;
      totalWeight += w;
    }
    if (totalWeight > 0) weightedSlope /= totalWeight;
    trajSig = weightedSlope / (maxStepGy * 0.5 + 0.001);
    if (trajSig > 1) trajSig = 1;
    if (trajSig < -1) trajSig = -1;
  }

  // --- BLEND: adaptive based on distance from corridor ---
  var distFromCorridor = Math.abs(delta) / (maxStepGy + 0.001);
  if (distFromCorridor > 1) distFromCorridor = 1;
  var pullWeight = 0.2 + distFromCorridor * 0.6;
  var trajWeight = 1.0 - pullWeight;

  var signal = pullSig * pullWeight + trajSig * trajWeight;
  if (signal > 1) signal = 1;
  if (signal < -1) signal = -1;

  return {
    signal: signal,
    clarity: wp.clarity,
    targetY: wp.bestY,
    corridorTop: wp.corridorTop,
    corridorBot: wp.corridorBot,
    aliveScouts: wp.aliveScouts
  };
}


// ================================================================
// CORRIDOR VISUALIZATION
// ================================================================
// Draws all FABRIK corridor paths with a smooth green-to-orange
// color gradient based on energy ranking:
//   Rank 0 (best)  = bright green  (#00ffaa)
//   Rank N (worst)  = warm orange   (#ff8830)

function renderCorridors(ctx, corridors, resolution) {
  if (!corridors || corridors.length < 2) return;

  ctx.save();

  var paths = corridors.paths || [];

  if (paths.length === 0) {
    _drawSinglePath(ctx, corridors, resolution, "#00ffaa", 0.5);
    ctx.restore();
    return;
  }

  // Color gradient endpoints
  var bestR = 0,   bestG = 255, bestB = 170;  // #00ffaa
  var worstR = 255, worstG = 136, worstB = 48; // #ff8830

  var bestAlpha  = 0.55;
  var worstAlpha = 0.25;
  var bestWidth  = 2.5;
  var worstWidth = 1.5;

  var pathCount = paths.length;

  // Draw worst-to-best so best path renders on top
  for (var pi = pathCount - 1; pi >= 0; pi--) {
    var chain = paths[pi].joints;
    if (!chain || chain.length < 2) continue;

    // t: 0 = best, 1 = worst
    var t = (pathCount > 1) ? pi / (pathCount - 1) : 0;

    var r, g, b, color, alpha, lineW;

    // Contrarian path gets a distinct blue-purple color so it's
    // immediately recognizable as the "odd duck" on the chart.
    if (paths[pi].source === "contra") {
      r = 100; g = 160; b = 255;  // #64a0ff — cool blue
      color = "rgb(100,160,255)";
      alpha = 0.50;
      lineW = 2.0;
    } else {
      r = Math.round(bestR + (worstR - bestR) * t);
      g = Math.round(bestG + (worstG - bestG) * t);
      b = Math.round(bestB + (worstB - bestB) * t);
      color = "rgb(" + r + "," + g + "," + b + ")";
      alpha = bestAlpha + (worstAlpha - bestAlpha) * t;
      lineW = bestWidth + (worstWidth - bestWidth) * t;
    }

    // -- Corridor boundary fill --
    ctx.globalAlpha = alpha * 0.15;
    ctx.fillStyle = color;
    for (var fi = 0; fi < chain.length; fi++) {
      var fj = chain[fi];
      var fx = fj.gx * resolution;
      var fy = fj.corridorTop * resolution;
      var fh = (fj.corridorBot - fj.corridorTop + 1) * resolution;
      ctx.fillRect(fx, fy, resolution, fh);
    }

    // -- Path line (dashed) --
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineW;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (var li = 0; li < chain.length; li++) {
      var lj = chain[li];
      var lx = lj.gx * resolution + resolution / 2;
      var ly = lj.gy * resolution;
      if (li === 0) ctx.moveTo(lx, ly);
      else ctx.lineTo(lx, ly);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // -- Clarity dots every 3rd joint --
    for (var di = 0; di < chain.length; di += 3) {
      var dj = chain[di];
      var ddx = dj.gx * resolution + resolution / 2;
      var ddy = dj.gy * resolution;
      var dClarity = dj.clarity || 0.5;
      var dAlpha = (0.2 + dClarity * 0.5) * (1.0 - t * 0.4);
      var dRad = 2 + dClarity * 3 - t * 1.5;
      if (dRad < 1) dRad = 1;
      ctx.globalAlpha = dAlpha;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(ddx, ddy, dRad, 0, Math.PI * 2);
      ctx.fill();
    }

    // -- Target diamond at endpoint --
    if (chain.length > 0) {
      var lastJ = chain[chain.length - 1];
      var tdx = lastJ.gx * resolution + resolution / 2;
      var tdy = lastJ.gy * resolution;
      var diamondSize = 5 - t * 1.5;
      if (diamondSize < 3) diamondSize = 3;

      ctx.globalAlpha = alpha + 0.15;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(tdx, tdy - diamondSize);
      ctx.lineTo(tdx + diamondSize, tdy);
      ctx.lineTo(tdx, tdy + diamondSize);
      ctx.lineTo(tdx - diamondSize, tdy);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.3 + (1 - t) * 0.2;
      ctx.stroke();
    }

    // -- Energy label near target --
    if (pathCount > 1 && chain.length > 0) {
      var eLast = chain[chain.length - 1];
      var ex = eLast.gx * resolution - 2;
      var ey = eLast.gy * resolution - 7;
      ctx.globalAlpha = 0.4 + (1 - t) * 0.35;
      ctx.fillStyle = color;
      ctx.font = "9px monospace";
      ctx.textAlign = "right";
      var eLabel = (paths[pi].source === "contra")
        ? "alt:" + paths[pi].score.totalEnergy.toFixed(0)
        : "E:" + paths[pi].score.totalEnergy.toFixed(0);
      ctx.fillText(eLabel, ex, ey);
    }
  }

  ctx.restore();
}


// Fallback: draw a single green path from raw waypoints.
function _drawSinglePath(ctx, waypoints, resolution, color, alpha) {
  ctx.globalAlpha = alpha * 0.15;
  ctx.fillStyle = color;
  for (var fi = 0; fi < waypoints.length; fi++) {
    var fw = waypoints[fi];
    ctx.fillRect(fw.gx * resolution, fw.corridorTop * resolution,
                 resolution, (fw.corridorBot - fw.corridorTop + 1) * resolution);
  }

  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  for (var ci = 0; ci < waypoints.length; ci++) {
    var cw = waypoints[ci];
    var cx = cw.gx * resolution + resolution / 2;
    var cy = cw.bestY * resolution;
    if (ci === 0) ctx.moveTo(cx, cy);
    else ctx.lineTo(cx, cy);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}


// ================================================================
// POOL DEBUG VISUALIZATION
// ================================================================
// Draws the discovered pools as colored rectangles on the chart.
// Cyan = low pressure pool, Yellow = medium pool, Red = high pressure.
// Also draws graph route edges as thin lines connecting pools.
//
// Call this after renderCorridors. Controlled by state.showCorridors.

function renderPoolDebug(ctx, corridors, resolution) {
  if (!corridors || !corridors.poolDebug) return;

  var scanColumns = corridors.poolDebug;
  ctx.save();

  // Draw each discovered pool as a semi-transparent vertical bar
  for (var ci = 0; ci < scanColumns.length; ci++) {
    var sc = scanColumns[ci];
    var pools = sc.pools;

    for (var pi = 0; pi < pools.length; pi++) {
      var pool = pools[pi];
      var x = pool.scanGx * resolution;
      var yTop = pool.top * resolution;
      var yBot = (pool.bot + 1) * resolution;
      var h = yBot - yTop;

      // Color by pressure: low = bright cyan, high = dim amber
      var p = pool.pressure;  // already normalized 0..1
      var r, g, b;
      if (p < 0.15) {
        // Very low pressure: bright cyan — ideal corridor
        r = 0; g = 255; b = 220;
      } else if (p < 0.30) {
        // Low-medium: teal
        r = 40; g = 200; b = 180;
      } else {
        // Medium-high: amber (barely qualifies)
        r = 200; g = 160; b = 60;
      }

      ctx.globalAlpha = 0.3;
      ctx.fillStyle = "rgb(" + r + "," + g + "," + b + ")";
      ctx.fillRect(x, yTop, resolution * 2, h);

      // Center dot
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = "rgb(" + r + "," + g + "," + b + ")";
      ctx.beginPath();
      ctx.arc(x + resolution, pool.gy * resolution, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw edges to next scan column's pools
    if (ci < scanColumns.length - 1) {
      var nextSc = scanColumns[ci + 1];
      ctx.globalAlpha = 0.15;
      ctx.strokeStyle = "rgba(100, 200, 255, 0.4)";
      ctx.lineWidth = 0.5;

      for (var a = 0; a < pools.length; a++) {
        for (var b2 = 0; b2 < nextSc.pools.length; b2++) {
          var ax = pools[a].scanGx * resolution + resolution;
          var ay = pools[a].gy * resolution;
          var bx = nextSc.pools[b2].scanGx * resolution + resolution;
          var by = nextSc.pools[b2].gy * resolution;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
        }
      }
    }
  }

  ctx.restore();
}
