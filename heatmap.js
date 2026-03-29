/*
 * ================================================================
 * heatmap.js  —  Raycast Heatmap Engine (Color-Coded Beams)
 * ================================================================
 * Depends on: config.js    (CONFIG, state, ctx, backgroundData)
 *             coords.js    (priceToY, indexToX, getPriceRange)
 *             data.js      (calcIntensityWeights)
 *             sightlines.js (buildSightLines)
 *
 * BEAM RULES (important, do not change):
 *   - Beams travel forever at full intensity. NO distance decay.
 *   - The ONLY thing that attenuates a beam is passing through
 *     a candle body/wick (controlled by opacity/translucency).
 *   - LENGTH→GLOW: longer total distance = brighter beam.
 *
 * BEAM COLORS — determined by two properties:
 *   1. Which side of the candle the beam originates from (H or L)
 *   2. Whether the beam angles up or down in price terms
 *
 *   GREEN  = top side (high), angled up    — strong resistance signal
 *   YELLOW = top side (high), angled down  — weak resistance signal
 *   BLUE   = bottom side (low), angled up  — weak support signal
 *   RED    = bottom side (low), angled down — strong support signal
 *
 *   Top-side beams (green + yellow) push price DOWN (resistance).
 *   Bottom-side beams (blue + red) push price UP (support).
 *   Green & red are momentum-aligned = stronger force.
 *   Yellow & blue are counter-trend = weaker force.
 *
 * Four separate grids accumulate each color independently.
 * Additive blending stacks them on the canvas so overlapping
 * colors mix naturally (e.g. green + blue = cyan in support zones).
 * ================================================================
 */

// Grid indices — used throughout this file
var GRID_GREEN  = 0;  // top, up
var GRID_YELLOW = 1;  // top, down
var GRID_BLUE   = 2;  // bottom, up
var GRID_RED    = 3;  // bottom, down

// Pick the right grid index from source side and slope direction.
//   side: "h" (top/high) or "l" (bottom/low)
//   y1, y2: pixel Y coords (canvas Y increases downward, so
//           y2 < y1 means the beam angles UP in price terms)
function beamGridIdx(side, y1, y2) {
  var goingUp = y2 < y1;  // price is rising (Y is decreasing)
  if (side === "h") {
    return goingUp ? GRID_GREEN : GRID_YELLOW;
  } else {
    return goingUp ? GRID_BLUE : GRID_RED;
  }
}


// O(n) percentile computation using histogram binning.
// Replaces the O(n log n) sort that used to run EVERY FRAME in
// renderHeatmap. Now called once at build time, result cached.
function _computeRefVal(grids, cellCount) {
  var BIN_COUNT = 1024;

  // Pass 1: find max across all 4 grids
  var maxVal = 0;
  for (var gi = 0; gi < 4; gi++) {
    var g = grids[gi];
    for (var i = 0; i < cellCount; i++) {
      if (g[i] > maxVal) maxVal = g[i];
    }
  }
  if (maxVal < 0.01) return 1.0;

  // Pass 2: bin all non-zero values into histogram
  var bins = new Uint32Array(BIN_COUNT);
  var scale = (BIN_COUNT - 1) / maxVal;
  var totalNonZero = 0;

  for (var gi2 = 0; gi2 < 4; gi2++) {
    var g2 = grids[gi2];
    for (var i2 = 0; i2 < cellCount; i2++) {
      var v = g2[i2];
      if (v > 0.01) {
        bins[(v * scale) | 0]++;
        totalNonZero++;
      }
    }
  }
  if (totalNonZero === 0) return 1.0;

  // Walk bins to find 85th percentile
  var target = Math.floor(totalNonZero * 0.85);
  var cumulative = 0;
  for (var b = 0; b < BIN_COUNT; b++) {
    cumulative += bins[b];
    if (cumulative >= target) {
      var refVal = (b + 0.5) / scale;
      return refVal * 2.0;  // include 2× display dimming factor
    }
  }
  return maxVal * 2.0;
}


function buildHeatmap(candles, dims, resolution, assetKey, precomputedSlData, lockedRange) {
  var t0 = performance.now();
  var w = dims.width;
  var h = dims.height;

  var slData = precomputedSlData || buildSightLines(candles, dims);

  // Four downsampled grids, one per beam color category
  var cols = Math.ceil(w / resolution);
  var rows = Math.ceil(h / resolution);
  var cellCount = cols * rows;
  var grids = [
    new Float32Array(cellCount),  // [0] GREEN:  top, up
    new Float32Array(cellCount),  // [1] YELLOW: top, down
    new Float32Array(cellCount),  // [2] BLUE:   bottom, up
    new Float32Array(cellCount),  // [3] RED:    bottom, down
  ];

  var beamHalfWidth = 3;

  var weights = calcIntensityWeights(candles, state.intensityMode);

  var maxBeamLen = Math.sqrt(w * w + h * h);
  var lenBoost = state.beamLenBoost;

  var chartLeft   = dims.chartLeft;
  var chartWidth  = dims.chartWidth;
  var chartTop    = dims.chartTop;
  var chartHeight = dims.chartHeight;
  var range       = lockedRange || getPriceRange(candles);
  var count       = candles.length;
  var candleW     = chartWidth / CONFIG.CANDLE_COUNT;
  var opacity     = state.translucency;


  // ================================================================
  // BUILD OCCLUSION GRID
  // ================================================================

  var occGrid = new Uint16Array(cellCount);

  for (var ogi = 0; ogi < count; ogi++) {
    var ogc = candles[ogi];
    var slotLeftPx  = chartLeft + ogi * candleW;
    var slotRightPx = chartLeft + (ogi + 1) * candleW;
    var ogHighY = priceToY(ogc.h, range.priceMin, range.priceMax, chartTop, chartHeight);
    var ogLowY  = priceToY(ogc.l, range.priceMin, range.priceMax, chartTop, chartHeight);

    var gxMin = Math.floor(slotLeftPx / resolution);
    var gxMax = Math.ceil(slotRightPx / resolution);
    var gyMin = Math.floor(ogHighY / resolution);
    var gyMax = Math.ceil(ogLowY / resolution);
    if (gxMin < 0) gxMin = 0;
    if (gxMax >= cols) gxMax = cols - 1;
    if (gyMin < 0) gyMin = 0;
    if (gyMax >= rows) gyMax = rows - 1;

    var candleId = ogi + 1;
    for (var ogy = gyMin; ogy <= gyMax; ogy++) {
      for (var ogx = gxMin; ogx <= gxMax; ogx++) {
        occGrid[ogy * cols + ogx] = candleId;
      }
    }
  }

  // Bridge gaps between adjacent candles
  for (var bi = 0; bi < count - 1; bi++) {
    var cA = candles[bi];
    var cB = candles[bi + 1];
    var bridgeHighPrice = Math.min(cA.h, cB.h);
    var bridgeLowPrice  = Math.max(cA.l, cB.l);
    var bridgeTopY  = priceToY(bridgeHighPrice, range.priceMin, range.priceMax, chartTop, chartHeight);
    var bridgeBotY  = priceToY(bridgeLowPrice, range.priceMin, range.priceMax, chartTop, chartHeight);
    if (bridgeTopY > bridgeBotY) { var tmp = bridgeTopY; bridgeTopY = bridgeBotY; bridgeBotY = tmp; }

    var bridgeLeftPx  = chartLeft + (bi + 1) * candleW - candleW * 0.5;
    var bridgeRightPx = chartLeft + (bi + 1) * candleW + candleW * 0.5;
    var bgxMin = Math.floor(bridgeLeftPx / resolution);
    var bgxMax = Math.ceil(bridgeRightPx / resolution);
    var bgyMin = Math.floor(bridgeTopY / resolution);
    var bgyMax = Math.ceil(bridgeBotY / resolution);
    if (bgxMin < 0) bgxMin = 0;
    if (bgxMax >= cols) bgxMax = cols - 1;
    if (bgyMin < 0) bgyMin = 0;
    if (bgyMax >= rows) bgyMax = rows - 1;

    var bridgeId = bi + 1;
    for (var bgy = bgyMin; bgy <= bgyMax; bgy++) {
      for (var bgx = bgxMin; bgx <= bgxMax; bgx++) {
        if (occGrid[bgy * cols + bgx] === 0) {
          occGrid[bgy * cols + bgx] = bridgeId;
        }
      }
    }
  }


  // ================================================================
  // paintBeam  —  the core beam renderer
  // ================================================================
  // Now takes a target grid (one of the four color grids) so each
  // beam deposits light into the correct color channel.
  //
  // No distance decay. Intensity stays constant unless the beam
  // passes through a candle slot, which attenuates by (1 - opacity).

  function paintBeam(targetGrid, x1, y1, x2, y2, intensity, skipSrc) {
    var dx = x2 - x1;
    var dy = y2 - y1;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;

    // LENGTH→GLOW: longer beams get brighter
    if (lenBoost > 0.01) {
      var norm = len / maxBeamLen;
      var mult = 0.1 + norm * 2.9;
      intensity *= (1 - lenBoost) + lenBoost * mult;
    }

    var stepSize = Math.max(1, resolution);
    var steps = Math.ceil(len / stepSize);
    var sx = dx / steps;
    var sy = dy / steps;

    var currentIntensity = intensity;
    var lastOccCandle = -1;
    var skipSrcId = (skipSrc >= 0) ? skipSrc + 1 : -1;

    for (var s = 0; s <= steps; s++) {
      var px = x1 + sx * s;
      var py = y1 + sy * s;

      var gcx = (px / resolution) | 0;
      var gcy = (py / resolution) | 0;

      if (gcx >= 0 && gcx < cols && gcy >= 0 && gcy < rows) {
        var centerCandle = occGrid[gcy * cols + gcx];
        if (centerCandle > 0 && centerCandle !== skipSrcId && centerCandle !== lastOccCandle) {
          currentIntensity *= (1.0 - opacity);
          lastOccCandle = centerCandle;
          if (currentIntensity < 0.01) return;
        }
      }

      for (var offset = -beamHalfWidth; offset <= beamHalfWidth; offset++) {
        var perpX = gcx + Math.round((-dy / len) * offset);
        var perpY = gcy + Math.round((dx / len) * offset);

        if (perpX >= 0 && perpX < cols && perpY >= 0 && perpY < rows) {
          var cellCandle = occGrid[perpY * cols + perpX];
          if (cellCandle > 0 && cellCandle !== skipSrcId) continue;

          var distFromCenter = Math.abs(offset) / (beamHalfWidth + 1);
          var falloff = 1.0 - distFromCenter * distFromCenter;
          targetGrid[perpY * cols + perpX] += currentIntensity * falloff;
        }
      }
    }
  }


  // ================================================================
  // BUILD BACKGROUND SIGHT-LINE PAIRS
  // ================================================================
  // The O(n²) pair computation is cached independently of painting.
  // Both the GPU (Phase 2) and CPU (Phase 1) paths reuse these pairs.

  var bgCacheKey = null;
  var bgGridKey  = null;
  var bgCandles  = backgroundData[assetKey];
  var hasBgPairs = false;

  if (bgCandles && bgCandles.length >= 3) {
    var bgCount   = bgCandles.length;
    var bgCandleW = chartWidth / CONFIG.CANDLE_COUNT;
    var bgWidth   = bgCount * bgCandleW;
    var bgLeft    = chartLeft - bgWidth;

    // Quantize the price range for the cache key. During animation,
    // priceMin/priceMax shift by tiny amounts each frame (new candle
    // changes the visible range). Without quantization, the cache key
    // changes every frame → 23,760 bg beams repainted = 3-5 seconds.
    //
    // Quantize to 2% of the total range. This means the bg grid is
    // reused until the price range shifts by more than 2%, at which
    // point it rebuilds. Visual error: ~1-2 pixels of beam offset,
    // imperceptible at background opacity levels.
    var priceSpan = range.priceMax - range.priceMin;
    var quantStep = Math.max(0.01, priceSpan * 0.02);  // 2% of range
    var qMin = Math.floor(range.priceMin / quantStep) * quantStep;
    var qMax = Math.ceil(range.priceMax / quantStep) * quantStep;

    bgCacheKey = assetKey + "-" + bgCount + "-"
      + qMin.toFixed(2) + "-" + qMax.toFixed(2)
      + "-" + chartLeft + "-" + chartWidth + "-" + chartTop + "-" + chartHeight;

    bgGridKey = bgCacheKey + "-r" + resolution
      + "-o" + opacity.toFixed(4)
      + "-lb" + lenBoost.toFixed(4);
      // NOTE: foreground candle count (-n) intentionally excluded.
      // Background beams don't depend on how many foreground candles
      // are visible. Including count caused cache misses every
      // animation frame (23,760 bg beams repainted = 3-5 seconds).

    // Build sight-line pairs if not cached (expensive O(n²), done once)
    if (!bgSightLineCache[bgCacheKey]) {
      var bgTips = [];
      for (var bti = 0; bti < bgCount; bti++) {
        var bc = bgCandles[bti];
        var bx = bgLeft + (bti + 0.5) * bgCandleW;
        bgTips.push({
          x:  bx,
          hy: priceToY(bc.h, range.priceMin, range.priceMax, chartTop, chartHeight),
          ly: priceToY(bc.l, range.priceMin, range.priceMax, chartTop, chartHeight),
          h:  bc.h,
          l:  bc.l,
        });
      }

      var bgPairs = [];
      var bgMaxSpan = Math.min(60, bgCount);

      for (var bi2 = 0; bi2 < bgCount; bi2++) {
        var bgSrc = bgTips[bi2];
        var bjMax = Math.min(bgCount, bi2 + bgMaxSpan);

        for (var bj = bi2 + 1; bj < bjMax; bj++) {
          var bgDst = bgTips[bj];

          // --- H-H sight line ---
          var hhOcc = false;
          for (var bk = bi2 + 1; bk < bj; bk++) {
            var bm = bgTips[bk];
            var bt = (bm.x - bgSrc.x) / (bgDst.x - bgSrc.x);
            var bLineP = bgSrc.h + bt * (bgDst.h - bgSrc.h);
            if (bLineP <= bm.h && bLineP >= bm.l) { hhOcc = true; break; }
          }

          if (!hhOcc) {
            var hhSpan = bj - bi2;
            var hhInt = (0.5 + Math.min(1.0, hhSpan / 10) * 0.5) * 0.5;
            var hhDx = bgDst.x - bgSrc.x;
            var hhDy = bgDst.hy - bgSrc.hy;
            var hhLen = Math.sqrt(hhDx * hhDx + hhDy * hhDy);

            var pair = {
              type: "h", int: hhInt,
              srcX: bgSrc.x, srcY: bgSrc.hy,
              dstX: bgDst.x, dstY: bgDst.hy,
              extX: 0, extY: 0, hasExt: false,
            };

            if (hhLen > 1) {
              var hhNdx = hhDx / hhLen;
              var hhNdy = hhDy / hhLen;
              if (hhNdx > 0) {
                pair.hasExt = true;
                pair.extX = bgDst.x + hhNdx * (w + bgWidth);
                pair.extY = bgDst.hy + hhNdy * (w + bgWidth);
              }
            }
            bgPairs.push(pair);
          }

          // --- L-L sight line ---
          var llOcc = false;
          for (var bk2 = bi2 + 1; bk2 < bj; bk2++) {
            var bm2 = bgTips[bk2];
            var bt2 = (bm2.x - bgSrc.x) / (bgDst.x - bgSrc.x);
            var bLineP2 = bgSrc.l + bt2 * (bgDst.l - bgSrc.l);
            if (bLineP2 <= bm2.h && bLineP2 >= bm2.l) { llOcc = true; break; }
          }

          if (!llOcc) {
            var llSpan = bj - bi2;
            var llInt = (0.5 + Math.min(1.0, llSpan / 10) * 0.5) * 0.5;
            var llDx = bgDst.x - bgSrc.x;
            var llDy = bgDst.ly - bgSrc.ly;
            var llLen = Math.sqrt(llDx * llDx + llDy * llDy);

            var lpair = {
              type: "l", int: llInt,
              srcX: bgSrc.x, srcY: bgSrc.ly,
              dstX: bgDst.x, dstY: bgDst.ly,
              extX: 0, extY: 0, hasExt: false,
            };

            if (llLen > 1) {
              var llNdx = llDx / llLen;
              var llNdy = llDy / llLen;
              if (llNdx > 0) {
                lpair.hasExt = true;
                lpair.extX = bgDst.x + llNdx * (w + bgWidth);
                lpair.extY = bgDst.ly + llNdy * (w + bgWidth);
              }
            }
            bgPairs.push(lpair);
          }
        }
      }

      bgSightLineCache[bgCacheKey] = bgPairs;
    }

    hasBgPairs = true;
  }


  // ================================================================
  // PHASE 2: GPU BEAM ACCUMULATION
  // ================================================================
  // Collect ALL beams (background + visible) into a flat typed array,
  // then render them all in one GPU pass with instanced quads.
  // Each fragment marches along its beam checking the occlusion grid
  // texture and writes to the correct color channel with additive
  // blending. Result is read back into the 4 CPU grid arrays.
  //
  // Falls back to CPU Phase 1 path if GPU isn't available or fails.

  var gpuDone = false;

  if (typeof gpuAccumBeams === "function" && glPipeline && glPipeline.ready) {

    // ---- Helper: apply LENGTH→GLOW to a raw intensity ----
    // Same formula as inside paintBeam, extracted so we can
    // pre-compute it for each beam before uploading to GPU.
    function applyLenGlow(rawIntensity, x1, y1, x2, y2) {
      if (lenBoost <= 0.01) return rawIntensity;
      var dx2 = x2 - x1, dy2 = y2 - y1;
      var len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
      var norm2 = len2 / maxBeamLen;
      var mult2 = 0.1 + norm2 * 2.9;
      return rawIntensity * ((1 - lenBoost) + lenBoost * mult2);
    }

    // ---- Count total beams to pre-allocate ----
    var totalBeams = 0;

    // Background beams: each pair = 1 base + 1 extension (if hasExt)
    var bgPairList = hasBgPairs ? bgSightLineCache[bgCacheKey] : [];
    for (var cntI = 0; cntI < bgPairList.length; cntI++) {
      totalBeams++;
      if (bgPairList[cntI].hasExt) totalBeams++;
    }

    // Visible base lines (skip if raysOnly mode)
    if (!state.raysOnly) {
      totalBeams += slData.baseLines.length;
    }

    // Visible extended rays
    totalBeams += slData.rays.length;

    if (totalBeams > 0) {
      // ---- Pack all beams into a Float32Array ----
      // 7 floats per beam: x1_grid, y1_grid, x2_grid, y2_grid,
      //                     intensity (LENGTH→GLOW adjusted),
      //                     gridIdx (0-3), skipSrcId (candleId or -1)
      var beamData = new Float32Array(totalBeams * 7);
      var invRes = 1.0 / resolution;
      var bi = 0;   // beam index (advances as we fill)

      // ---- Background beams ----
      for (var gbi = 0; gbi < bgPairList.length; gbi++) {
        var gbp = bgPairList[gbi];
        var off = bi * 7;
        var gInt = applyLenGlow(gbp.int, gbp.srcX, gbp.srcY, gbp.dstX, gbp.dstY);
        var gIdx = beamGridIdx(gbp.type, gbp.srcY, gbp.dstY);
        beamData[off]     = gbp.srcX * invRes;
        beamData[off + 1] = gbp.srcY * invRes;
        beamData[off + 2] = gbp.dstX * invRes;
        beamData[off + 3] = gbp.dstY * invRes;
        beamData[off + 4] = gInt;
        beamData[off + 5] = gIdx;
        beamData[off + 6] = -1;   // background beams skip no candle
        bi++;

        if (gbp.hasExt) {
          var eOff = bi * 7;
          var eInt = applyLenGlow(gbp.int, gbp.dstX, gbp.dstY, gbp.extX, gbp.extY);
          var eIdx = beamGridIdx(gbp.type, gbp.dstY, gbp.extY);
          beamData[eOff]     = gbp.dstX * invRes;
          beamData[eOff + 1] = gbp.dstY * invRes;
          beamData[eOff + 2] = gbp.extX * invRes;
          beamData[eOff + 3] = gbp.extY * invRes;
          beamData[eOff + 4] = eInt;
          beamData[eOff + 5] = eIdx;
          beamData[eOff + 6] = -1;
          bi++;
        }
      }

      // ---- Visible base lines ----
      if (!state.raysOnly) {
        for (var vbi = 0; vbi < slData.baseLines.length; vbi++) {
          var vbl = slData.baseLines[vbi];
          var vOff = bi * 7;
          var vSrcW = weights[vbl.srcIdx] || 1;
          var vSpan = 0.5 + Math.min(1.0, vbl.span / 10) * 0.5;
          var vVol  = 0.4 + (vbl.volWeight || 0.5) * 0.6;
          var vIntW = 0.4 + (vbl.intensityWeight || 0.5) * 0.6;
          var vRaw  = vSpan * vSrcW * vVol * vIntW;
          var vInt  = applyLenGlow(vRaw, vbl.x1, vbl.y1, vbl.x2, vbl.y2);
          var vIdx  = beamGridIdx(vbl.srcType, vbl.y1, vbl.y2);
          var vSkip = (vbl.srcIdx >= 0) ? vbl.srcIdx + 1 : -1;
          beamData[vOff]     = vbl.x1 * invRes;
          beamData[vOff + 1] = vbl.y1 * invRes;
          beamData[vOff + 2] = vbl.x2 * invRes;
          beamData[vOff + 3] = vbl.y2 * invRes;
          beamData[vOff + 4] = vInt;
          beamData[vOff + 5] = vIdx;
          beamData[vOff + 6] = vSkip;
          bi++;
        }
      }

      // ---- Visible extended rays ----
      for (var vri = 0; vri < slData.rays.length; vri++) {
        var vray = slData.rays[vri];
        var rOff = bi * 7;
        var rMom = Math.min(1.0, vray.momentum / 200);
        var rSW  = (vray.srcIdx >= 0 && vray.srcIdx < weights.length) ? weights[vray.srcIdx] : 1;
        var rDW  = (vray.dstIdx >= 0 && vray.dstIdx < weights.length) ? weights[vray.dstIdx] : 1;
        var rIW  = (rSW + rDW) / 2;
        var rRaw = (0.4 + rMom * 0.8) * (vray.spreadFalloff || 1.0) * rIW;
        var rInt = applyLenGlow(rRaw, vray.x1, vray.y1, vray.x2, vray.y2);
        var rIdx = beamGridIdx(vray.srcType, vray.y1, vray.y2);
        var rSkip = (vray.dstIdx >= 0) ? vray.dstIdx + 1 : -1;
        beamData[rOff]     = vray.x1 * invRes;
        beamData[rOff + 1] = vray.y1 * invRes;
        beamData[rOff + 2] = vray.x2 * invRes;
        beamData[rOff + 3] = vray.y2 * invRes;
        beamData[rOff + 4] = rInt;
        beamData[rOff + 5] = rIdx;
        beamData[rOff + 6] = rSkip;
        bi++;
      }

      // ---- Segment beams on CPU ----
      // Walks each beam along its TRUE path, splitting at candle
      // crossings. This is correct for angled beams (the attenuation
      // texture approach only works for horizontal beams).
      // Cost: ~10-25ms at res=1. Combined with all other fixes
      // (cached refVal, contour cache, topology cache, histogram
      // percentiles, pooled arrays), total frame time is acceptable.
      var candleStepHint = (chartWidth / CONFIG.CANDLE_COUNT) / resolution;
      var segResult = segmentBeams(beamData, bi, occGrid, cols, rows, opacity, candleStepHint);

      // ---- Render segments on GPU (trivial fragment shader) ----
      gpuDone = gpuAccumBeams(segResult.segments, segResult.count, occGrid, cols, rows);

      if (gpuDone) {
        gpuReadbackGrids(grids);
        console.log("[Pipeline] " + bi + " beams → " + segResult.count
          + " segments (" + bgPairList.length + " bg pairs)");
      }
    }
  }


  // ================================================================
  // CPU FALLBACK: Phase 1 Cached Background + Visible Beams
  // ================================================================
  // Used when GPU isn't available or fails. Phase 1 caching still
  // provides a big speedup for the background beams.

  if (!gpuDone) {

    // ---- Background beams (Phase 1 cached) ----
    if (hasBgPairs) {
      if (bgGridCache[bgGridKey]) {
        // CACHE HIT: copy pre-computed background grids (~0.1ms)
        var cached = bgGridCache[bgGridKey];
        for (var cgi = 0; cgi < 4; cgi++) {
          grids[cgi].set(cached[cgi]);
        }
      } else {
        // CACHE MISS: paint background beams, then snapshot for next time
        var cachedPairs = bgSightLineCache[bgCacheKey];
        for (var bpi = 0; bpi < cachedPairs.length; bpi++) {
          var bp = cachedPairs[bpi];
          var bpGrid = grids[beamGridIdx(bp.type, bp.srcY, bp.dstY)];
          paintBeam(bpGrid, bp.srcX, bp.srcY, bp.dstX, bp.dstY, bp.int, -1);

          if (bp.hasExt) {
            var bpRGrid = grids[beamGridIdx(bp.type, bp.dstY, bp.extY)];
            paintBeam(bpRGrid, bp.dstX, bp.dstY, bp.extX, bp.extY, bp.int, -1);
          }
        }

        // Snapshot for future frames
        var snapshot = [];
        for (var si = 0; si < 4; si++) {
          snapshot.push(new Float32Array(grids[si]));
        }
        bgGridCache[bgGridKey] = snapshot;
        console.log("[Phase1] BG grid cache MISS — painted " + cachedPairs.length
          + " bg beam pairs, cached " + cellCount + " cells × 4 grids");
      }
    }

    // ---- Visible base lines ----
    if (!state.raysOnly) {
      for (var i = 0; i < slData.baseLines.length; i++) {
        var bl = slData.baseLines[i];
        var srcWeight = weights[bl.srcIdx] || 1;
        var spanBoost = 0.5 + Math.min(1.0, bl.span / 10) * 0.5;
        var volBoost  = 0.4 + (bl.volWeight || 0.5) * 0.6;
        var intBoost  = 0.4 + (bl.intensityWeight || 0.5) * 0.6;
        var bInt = spanBoost * srcWeight * volBoost * intBoost;
        var bGrid = grids[beamGridIdx(bl.srcType, bl.y1, bl.y2)];
        paintBeam(bGrid, bl.x1, bl.y1, bl.x2, bl.y2, bInt, bl.srcIdx);
      }
    }

    // ---- Visible extended rays ----
    for (var ri = 0; ri < slData.rays.length; ri++) {
      var ray = slData.rays[ri];
      var momNorm = Math.min(1.0, ray.momentum / 200);
      var raySrcW = (ray.srcIdx >= 0 && ray.srcIdx < weights.length) ? weights[ray.srcIdx] : 1;
      var rayDstW = (ray.dstIdx >= 0 && ray.dstIdx < weights.length) ? weights[ray.dstIdx] : 1;
      var rayIntW = (raySrcW + rayDstW) / 2;
      var rayInt = (0.4 + momNorm * 0.8) * (ray.spreadFalloff || 1.0) * rayIntW;
      var rGrid = grids[beamGridIdx(ray.srcType, ray.y1, ray.y2)];
      paintBeam(rGrid, ray.x1, ray.y1, ray.x2, ray.y2, rayInt, ray.dstIdx);
    }
  }


  var tEnd = performance.now();
  var pathLabel = gpuDone ? " [GPU]"
    : (bgGridKey && bgGridCache[bgGridKey]) ? " [CPU bg-cached]"
    : " [CPU computed]";
  console.log("[buildHeatmap] " + assetKey + ": " + (tEnd - t0).toFixed(1) + "ms" + pathLabel);

  // Pre-compute refVal (85th percentile for normalization).
  // Cached here so renderHeatmap doesn't sort every frame.
  var refVal = _computeRefVal(grids, cellCount);

  return { grids: grids, cols: cols, rows: rows, occGrid: occGrid, paintBeam: paintBeam, refVal: refVal, resolution: resolution };
}


// ================================================================
// renderHeatmap  —  dispatch to fastest available renderer
// ================================================================
// Tries WebGL first (one texture upload + one GPU quad = ~1ms),
// falls back to ImageData (tight loop + one putImageData = ~5ms),
// never uses the old fillRect approach (~100-300ms).

function renderHeatmap(hm, accentHex) {
  var cols = hm.cols;
  var rows = hm.rows;

  // Use pre-computed refVal from buildHeatmap (cached, zero cost).
  // Only recompute if V.Beams modified the grids after build.
  var refVal = hm.refVal;
  if (!refVal) {
    refVal = _computeRefVal(hm.grids, cols * rows);
    hm.refVal = refVal;
  }

  // Use the resolution the grids were built at (may be capped by
  // PHYSICS_RES_MIN). cols * resolution gives the screen area to cover.
  var resolution = hm.resolution || state.heatmapRes;

  // Try unified GPU pipeline (reads beam FBO directly, no readback)
  if (typeof gpuDisplayHeatmap === "function" && glPipeline && glPipeline.ready) {
    if (!state.predVBeam || !state.showProjection) {
      if (gpuDisplayHeatmap(ctx, cols * resolution, rows * resolution,
                            refVal, accentHex)) return;
    }
  }

  // Try old WebGL path
  if (glHeatmap.ready) {
    if (renderHeatmapGL(hm, accentHex, refVal, ctx)) return;
  }

  // CPU fallback (also used for V.Beams — reads modified CPU grids)
  renderHeatmapImageData(hm, accentHex, refVal, ctx);
}
