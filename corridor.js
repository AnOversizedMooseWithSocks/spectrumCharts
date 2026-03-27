/*
 * ================================================================
 * corridor.js  —  FABRIK Corridor Pathfinder (v2)
 * ================================================================
 * Depends on: topology.js (signed elevation field)
 *
 * PURPOSE:
 *   Find the paths of least resistance through the signed topology
 *   (from computeTopology). Resistance = positive elevation
 *   (mountains), support = negative elevation (wells). Price flows
 *   through the dark zones between them.
 *
 * APPROACH: FABRIK (Forward And Backward Reaching Inverse Kinematics)
 *
 *   1. IDENTIFY TARGETS: Scan the far end of the projection zone
 *      for optimal destinations — Y positions where average terrain
 *      elevation is lowest. Pick up to 4 well-separated targets.
 *
 *   2. INITIALIZE CHAINS: For each target, lay a straight-line
 *      chain of joints (one per column, X fixed, Y free).
 *
 *   3. FABRIK RELAXATION — two-step per joint, per pass:
 *
 *      BACKWARD PASS (target → start):
 *        Lock target. Walk toward start. For each joint:
 *          a) REACH: move toward forward neighbor (propagates
 *             target info backward through the chain)
 *          b) SEEK: from the reached position, find the nearest
 *             low-elevation valley and pull into it
 *
 *      FORWARD PASS (start → target):
 *        Lock start. Walk toward target. For each joint:
 *          a) REACH: move toward backward neighbor (propagates
 *             entry info forward through the chain)
 *          b) SEEK: from the reached position, find the nearest
 *             low-elevation valley and pull into it
 *
 *      The key insight: valley search is centered on the REACHED
 *      position, not the old position. This means both passes
 *      genuinely explore the terrain from each endpoint's
 *      perspective, rather than just wiggling locally.
 *
 *   4. SCORE & RANK: Sum |elevation| along each path. The lowest-
 *      energy path becomes the primary corridor signal.
 *
 * OUTPUT:
 *   Same waypoint array format as before (backward compatible).
 *   Plus .paths with all ranked FABRIK chains for visualization.
 * ================================================================
 */


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
  var ref = topo.refIntensity || 1;

  // Scan the final ~35% of the projection zone.
  // Averaging over a window avoids picking a target that only
  // exists in one fragile column.
  var scanStart = Math.floor(startGx + steps * 0.65);
  var scanEnd   = Math.min(startGx + steps, cols - 1);
  if (scanStart >= scanEnd) scanStart = Math.max(0, scanEnd - 3);
  if (scanStart < 0) scanStart = 0;
  var scanWidth = scanEnd - scanStart + 1;
  if (scanWidth < 1) scanWidth = 1;

  // -- Step 1: Build averaged |elevation| profile --
  // Each row gets the mean |elevation| across the scan window.
  var profile = new Float32Array(rows);
  for (var r = 0; r < rows; r++) {
    var sum = 0;
    for (var c = scanStart; c <= scanEnd; c++) {
      sum += Math.abs(elevation[r * cols + c]);
    }
    profile[r] = sum / scanWidth;
  }

  // -- Step 1b: Smooth the profile (3-cell box blur) --
  // Removes tiny noise spikes that create false local minima.
  var smooth = new Float32Array(rows);
  smooth[0] = profile[0];
  smooth[rows - 1] = profile[rows - 1];
  for (var si = 1; si < rows - 1; si++) {
    smooth[si] = (profile[si - 1] + profile[si] + profile[si + 1]) / 3;
  }

  // -- Step 2: Find qualifying rows (below threshold) --
  // Threshold: 40% of the reference intensity. Rows below this
  // have genuinely low resistance.
  var threshold = ref * 0.40;

  // -- Step 3: Cluster adjacent qualifying rows into zones --
  // Each zone represents a continuous valley.
  var zones = [];
  var inZone = false;
  var zStart = 0;

  for (var zy = 0; zy < rows; zy++) {
    if (smooth[zy] < threshold) {
      if (!inZone) {
        inZone = true;
        zStart = zy;
      }
    } else {
      if (inZone) {
        _addZone(zones, smooth, zStart, zy - 1);
        inZone = false;
      }
    }
  }
  // Close final zone if it extends to the bottom
  if (inZone) {
    _addZone(zones, smooth, zStart, rows - 1);
  }

  // If clustering found nothing (terrain is uniformly high),
  // fall back: find the row with the absolute lowest elevation.
  if (zones.length === 0) {
    var fallbackBest = 0;
    var fallbackVal = Infinity;
    for (var fb = 1; fb < rows - 1; fb++) {
      if (smooth[fb] < fallbackVal) {
        fallbackVal = smooth[fb];
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
  // Quality = low average elevation + decent width
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

function fabrikRelax(topo, chain, entryGy, targetGy, iterations, searchRadius) {
  if (!iterations) iterations = 12;
  if (!searchRadius) searchRadius = 10;

  var n = chain.length;
  if (n < 3) return;

  var rows = topo.rows;

  // Lock endpoints
  chain[0].gy = entryGy;
  chain[n - 1].gy = targetGy;

  // Reach strength: how strongly a joint pulls toward its neighbor.
  // Higher = smoother path but less terrain-responsive.
  // Lower = more terrain-responsive but potentially jagged.
  var reachStr = 0.4;

  // Terrain pull: after reaching, how strongly the joint seeks
  // the valley found near the reached position.
  var terrainPull = 0.7;

  for (var iter = 0; iter < iterations; iter++) {

    // ---- BACKWARD PASS (from target toward start) ----
    // Lock the last joint at targetGy. Walk backward.
    // Each joint reaches toward its FORWARD neighbor (closer to
    // target, already updated this pass), then seeks a valley
    // from that reached position. This propagates target info
    // backward through the chain.
    chain[n - 1].gy = targetGy;

    for (var bi = n - 2; bi >= 1; bi--) {
      var bCurrent  = chain[bi].gy;
      var bNeighbor = chain[bi + 1].gy;  // forward neighbor (already updated)

      // Step 1: REACH toward forward neighbor
      var bReachY = bCurrent + (bNeighbor - bCurrent) * reachStr;

      // Step 2: SEEK valley from the REACHED position
      // (NOT from bCurrent — this is the critical fix)
      var bValleyY = findNearestValley(topo, chain[bi].gx, bReachY, searchRadius);

      // Final position: blend reached + valley
      var bNewY = bReachY + (bValleyY - bReachY) * terrainPull;

      if (bNewY < 1) bNewY = 1;
      if (bNewY > rows - 2) bNewY = rows - 2;
      chain[bi].gy = bNewY;
    }

    // ---- FORWARD PASS (from start toward target) ----
    // Lock the first joint at entryGy. Walk forward.
    // Each joint reaches toward its BACKWARD neighbor (closer to
    // start, already updated this pass), then seeks a valley
    // from that reached position. This propagates entry info
    // forward through the chain.
    chain[0].gy = entryGy;

    for (var fi = 1; fi < n - 1; fi++) {
      var fCurrent  = chain[fi].gy;
      var fNeighbor = chain[fi - 1].gy;  // backward neighbor (already updated)

      // Step 1: REACH toward backward neighbor
      var fReachY = fCurrent + (fNeighbor - fCurrent) * reachStr;

      // Step 2: SEEK valley from the REACHED position
      var fValleyY = findNearestValley(topo, chain[fi].gx, fReachY, searchRadius);

      // Final position: blend reached + valley
      var fNewY = fReachY + (fValleyY - fReachY) * terrainPull;

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
// PATH ENERGY SCORING
// ================================================================
// Sum absolute elevation along a chain. Lower = better path.
// Also computes per-joint metadata (elevation, corridor width).

function scoreChainEnergy(topo, chain) {
  var cols = topo.cols;
  var rows = topo.rows;
  var elevation = topo.intensity;
  var ref = topo.refIntensity || 1;

  var totalEnergy = 0;
  var maxEnergy = 0;

  for (var i = 0; i < chain.length; i++) {
    var gx = chain[i].gx;
    var gy = Math.round(chain[i].gy);
    if (gy < 0) gy = 0;
    if (gy >= rows) gy = rows - 1;
    if (gx < 0 || gx >= cols) continue;

    var absE = Math.abs(elevation[gy * cols + gx]);
    totalEnergy += absE;
    if (absE > maxEnergy) maxEnergy = absE;

    chain[i].elevation = elevation[gy * cols + gx];
    chain[i].absElev = absE;

    // Measure corridor width: scan up/down for walls
    var wallThresh = ref * 0.3;
    var corrTop = gy;
    var corrBot = gy;
    for (var ct = gy - 1; ct >= 0; ct--) {
      if (Math.abs(elevation[ct * cols + gx]) > wallThresh) break;
      corrTop = ct;
    }
    for (var cb = gy + 1; cb < rows; cb++) {
      if (Math.abs(elevation[cb * cols + gx]) > wallThresh) break;
      corrBot = cb;
    }
    chain[i].corridorTop = corrTop;
    chain[i].corridorBot = corrBot;
    chain[i].corridorWidth = corrBot - corrTop + 1;

    var width = corrBot - corrTop + 1;
    chain[i].clarity = Math.min(1.0, width / 20)
                     * (1.0 - Math.min(1.0, absE / ref));
  }

  return {
    totalEnergy: totalEnergy,
    maxEnergy: maxEnergy,
    avgEnergy: chain.length > 0 ? totalEnergy / chain.length : 0
  };
}


// ================================================================
// MAIN ENTRY: traceCorridors (FABRIK v2)
// ================================================================
// Same signature and output as before — projection.js is unchanged.

function traceCorridors(topo, entryGx, entryGy, steps, numScouts, spreadPx) {
  var cols = topo.cols;
  var rows = topo.rows;
  var ref = topo.refIntensity || 1;

  // ---- STEP 1: Find up to 4 optimal targets ----
  var maxTargets = 4;
  var targets = findCorridorTargets(topo, entryGx, steps, maxTargets);

  // ---- STEP 2: Build initial straight-line chains ----
  var chains = [];
  for (var ti = 0; ti < targets.length; ti++) {
    var targetGy = targets[ti].gy;
    var chain = [];

    for (var step = 0; step < steps; step++) {
      var gx = entryGx + step + 1;
      if (gx >= cols) break;

      var t = (step + 1) / steps;
      var initGy = entryGy + (targetGy - entryGy) * t;

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

    chains.push({
      targetGy: targetGy,
      targetInfo: targets[ti],
      joints: chain
    });
  }

  // ---- STEP 3: FABRIK relaxation ----
  var iters = Math.min(18, Math.max(10, Math.floor(steps / 2)));
  var searchRad = Math.max(8, Math.min(15, Math.floor(rows * 0.08)));

  for (var ci = 0; ci < chains.length; ci++) {
    fabrikRelax(
      topo,
      chains[ci].joints,
      entryGy,
      chains[ci].targetGy,
      iters,
      searchRad
    );
  }

  // ---- STEP 4: Score and rank ----
  for (var si = 0; si < chains.length; si++) {
    chains[si].score = scoreChainEnergy(topo, chains[si].joints);
  }

  chains.sort(function(a, b) {
    return a.score.totalEnergy - b.score.totalEnergy;
  });

  // ---- STEP 5: Build output waypoints from best chain ----
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
  return waypoints;
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

    var r = Math.round(bestR + (worstR - bestR) * t);
    var g = Math.round(bestG + (worstG - bestG) * t);
    var b = Math.round(bestB + (worstB - bestB) * t);
    var color = "rgb(" + r + "," + g + "," + b + ")";

    var alpha = bestAlpha + (worstAlpha - bestAlpha) * t;
    var lineW = bestWidth + (worstWidth - bestWidth) * t;

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
      var eLabel = "E:" + paths[pi].score.totalEnergy.toFixed(0);
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
