/*
 * ================================================================
 * sightlines.js  —  Sight Lines Engine
 * ================================================================
 * Depends on: config.js (CONFIG, state, ctx),
 *             coords.js (priceToY, indexToX, getPriceRange),
 *             data.js   (calcVolumeWeights, calcIntensityWeights)
 *
 * Three layers of line-of-sight analysis, each toggleable:
 *
 * 1. BASE LINES: Direct tip-to-tip connections where no candle
 *    blocks the path between them.
 *
 * 2. EXTENDED RAYS: Each base line continues past its endpoint
 *    along the same trajectory until it hits a candle.
 *
 * 3. MACRO TRENDS: Consecutive base line segments whose angles
 *    differ by less than the threshold are chained together.
 * ================================================================
 */

// Build everything: base lines, ray extensions, and macro chains.
// Returns { baseLines, rays, macroLines }.
function buildSightLines(candles, dims, lockedRange) {
  var chartLeft   = dims.chartLeft;
  var chartWidth  = dims.chartWidth;
  var chartTop    = dims.chartTop;
  var chartHeight = dims.chartHeight;

  var range    = lockedRange || getPriceRange(candles);
  var priceMin = range.priceMin;
  var priceMax = range.priceMax;
  var count    = candles.length;
  var candleW  = chartWidth / CONFIG.CANDLE_COUNT;

  // Compute per-candle volume weights (0..1, sqrt-scaled)
  var volWeights = calcVolumeWeights(candles);

  // Compute per-candle MA/RSI intensity weights (0..1)
  var intensityWeights = calcIntensityWeights(candles, state.intensityMode);

  // Pre-compute tip positions and candle extents (pixel coords)
  var tips = [];
  var extents = [];

  for (var i = 0; i < count; i++) {
    var c  = candles[i];
    var cx = indexToX(i, count, chartLeft, chartWidth);
    var hy = priceToY(c.h, priceMin, priceMax, chartTop, chartHeight);
    var ly = priceToY(c.l, priceMin, priceMax, chartTop, chartHeight);

    tips.push({ hx: cx, hy: hy, lx: cx, ly: ly });
    extents.push({ x: cx, highY: hy, lowY: ly });
  }

  // ---- PHASE 1: Build base sight lines ----
  // Highs connect to highs, lows to lows.
  // Volume of source and destination candles affects line strength.
  var baseLines = [];

  for (var i = 0; i < count; i++) {
    var srcTips = [
      { x: tips[i].hx, y: tips[i].hy, label: "h" },
      { x: tips[i].lx, y: tips[i].ly, label: "l" },
    ];

    for (var si = 0; si < 2; si++) {
      var src = srcTips[si];

      for (var j = i + 1; j < count; j++) {
        var dst;
        if (src.label === "h") {
          dst = { x: tips[j].hx, y: tips[j].hy, label: "h" };
        } else {
          dst = { x: tips[j].lx, y: tips[j].ly, label: "l" };
        }

        var blocked = false;
        for (var k = i + 1; k < j; k++) {
          var ext = extents[k];
          var t = (ext.x - src.x) / (dst.x - src.x);
          var lineY = src.y + t * (dst.y - src.y);
          if (lineY >= ext.highY && lineY <= ext.lowY) {
            blocked = true;
            break;
          }
        }

        if (!blocked) {
          var pxSlope = (dst.y - src.y) / (dst.x - src.x);
          var angleDeg = Math.atan(pxSlope) * (180 / Math.PI);

          // Volume weight: average of source and destination candle volumes.
          var vw = (volWeights[i] + volWeights[j]) / 2;
          // Intensity weight: average of MA/RSI weights at both endpoints.
          var iw = (intensityWeights[i] + intensityWeights[j]) / 2;

          baseLines.push({
            x1: src.x, y1: src.y,
            x2: dst.x, y2: dst.y,
            slope: pxSlope,
            angleDeg: angleDeg,
            span: j - i,
            srcIdx: i,
            dstIdx: j,
            srcType: src.label,
            dstType: dst.label,
            volWeight: vw,         // 0..1: volume-based significance
            intensityWeight: iw,   // 0..1: MA/RSI-based significance
          });
        }
      }
    }
  }

  // ---- PHASE 2: Extend rays past endpoints ----
  // Each base line continues from its endpoint (x2,y2) along the
  // same slope until it collides with a candle body/wick.
  // The extension distance = "momentum" (longer = stronger).
  //
  // OPTIMIZATION: Only extend from local peaks (for H-H lines) and
  // local troughs (for L-L lines). A non-peak high has a taller
  // neighbor right next to it, so the ray would immediately collide
  // with that neighbor — wasted work and visual noise.
  //
  // Peak: candle's high >= both neighbors' highs
  // Trough: candle's low <= both neighbors' lows
  // First and last candles are always considered peaks/troughs
  // (they have no neighbor on one side to block the ray).

  var isPeak   = [];  // true if candle[i].h is a local maximum
  var isTrough = [];  // true if candle[i].l is a local minimum

  for (var pi = 0; pi < count; pi++) {
    var prevH = (pi > 0)         ? candles[pi - 1].h : -Infinity;
    var nextH = (pi < count - 1) ? candles[pi + 1].h : -Infinity;
    isPeak.push(candles[pi].h >= prevH && candles[pi].h >= nextH);

    var prevL = (pi > 0)         ? candles[pi - 1].l : Infinity;
    var nextL = (pi < count - 1) ? candles[pi + 1].l : Infinity;
    isTrough.push(candles[pi].l <= prevL && candles[pi].l <= nextL);
  }

  // If a candle is BOTH a peak and a trough, it's just a small candle
  // squeezed between bigger ones — not a meaningful emitter. Rays from
  // both its top and bottom look like light refracting through it.
  // Disqualify from both to prevent this visual confusion.
  for (var pi2 = 0; pi2 < count; pi2++) {
    if (isPeak[pi2] && isTrough[pi2]) {
      isPeak[pi2] = false;
      isTrough[pi2] = false;
    }
  }

  var rays = [];

  // Beam spread: number of sub-rays per base line.
  // 0° = 1 ray (center only). At 5° default, emit 5 sub-rays
  // spanning ±spreadDeg around the main direction.
  var spreadDeg = state.beamSpread || 0;
  var spreadRad = spreadDeg * (Math.PI / 180);
  // Sub-ray count: 1 for no spread, then 2 per degree up to a cap
  var subRayCount = spreadDeg < 0.5 ? 1 : Math.min(1 + Math.round(spreadDeg * 0.8), 15);

  for (var ri = 0; ri < baseLines.length; ri++) {
    var bl = baseLines[ri];

    // Only extend from peaks (H-H lines) or troughs (L-L lines).
    if (bl.dstType === "h" && !isPeak[bl.dstIdx])   continue;
    if (bl.dstType === "l" && !isTrough[bl.dstIdx]) continue;

    var dx = bl.x2 - bl.x1;
    var dy = bl.y2 - bl.y1;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) continue;

    // Base angle of the incoming beam
    var baseAngle = Math.atan2(dy, dx);

    // Normalize direction (center ray)
    var ndx = dx / len;
    var ndy = dy / len;

    // No direction constraint needed here. The ray starts at the
    // candle tip and goes rightward along the incoming beam's
    // trajectory. skipSrc (dstIdx) prevents self-occlusion.
    // Downward H-H rays from peaks in downtrends are valid — they
    // produce YELLOW beams. Upward L-L rays from troughs in uptrends
    // are valid — they produce BLUE beams.

    // Emit sub-rays across the spread angle
    for (var sri = 0; sri < subRayCount; sri++) {
      var subAngle;
      if (subRayCount === 1) {
        subAngle = baseAngle;  // no spread, just the center ray
      } else {
        // Spread from -spreadRad/2 to +spreadRad/2 around baseAngle
        var t = sri / (subRayCount - 1);  // 0..1
        subAngle = baseAngle + spreadRad * (t - 0.5);
      }

      var sndx = Math.cos(subAngle);
      var sndy = Math.sin(subAngle);

      // Intensity falloff from center: center ray is full strength,
      // edge rays are dimmer
      var spreadFalloff = 1.0;
      if (subRayCount > 1) {
        var offCenter = Math.abs(t - 0.5) * 2;  // 0 at center, 1 at edge
        spreadFalloff = 1.0 - offCenter * 0.5;  // edge is 50% brightness
      }

      // March forward from the endpoint
      var stepSize = 2;
      var rx = bl.x2 + sndx * stepSize;
      var ry = bl.y2 + sndy * stepSize;
      var extDist = 0;
      var maxDist = Math.sqrt(dims.width * dims.width + dims.height * dims.height);
      var hit = false;

      while (extDist < maxDist) {
        if (rx < 0 || rx >= dims.width || ry < 0 || ry >= dims.height) break;

        var candleIdx = ((rx - chartLeft) / candleW) | 0;
        for (var ci = Math.max(0, candleIdx - 1); ci <= Math.min(count - 1, candleIdx + 1); ci++) {
          if (ci <= bl.dstIdx) continue;
          var ext = extents[ci];
          var candleX = tips[ci].hx;
          if (Math.abs(rx - candleX) < candleW * 0.5 &&
              ry >= ext.highY && ry <= ext.lowY) {
            hit = true;
            break;
          }
        }

        if (hit) break;

        rx += sndx * stepSize;
        ry += sndy * stepSize;
        extDist += stepSize;
      }

      if (extDist > 2) {
        rays.push({
          x1: bl.x2, y1: bl.y2,
          x2: rx, y2: ry,
          momentum: extDist,
          hit: hit,
          slope: bl.slope,
          angleDeg: subAngle * (180 / Math.PI),
          srcIdx: bl.srcIdx,
          dstIdx: bl.dstIdx,
          srcType: bl.srcType,
          dstType: bl.dstType,
          parentSpan: bl.span,
          spreadFalloff: spreadFalloff,  // 0.5..1.0 (edge to center brightness)
        });
      }
    }
  }

  // ---- PHASE 3: Build macro trend lines ----
  // Find sequences of base lines that form nearly-straight chains.
  // Rules:
  //   a) Segments must be same type (H-H chains with H-H, L-L with L-L)
  //   b) One segment's dstIdx matches the next segment's srcIdx
  //   c) Their angles differ by less than the threshold

  var macroLines = [];
  var angleTolerance = state.slMacroAngle;  // degrees

  // Sort base lines by srcIdx for efficient chaining
  var sorted = baseLines.slice().sort(function(a, b) {
    return a.srcIdx - b.srcIdx || a.dstIdx - b.dstIdx;
  });

  // Build an index: for each (candle index + tip type), which lines START there?
  var linesByStartAndType = {};
  for (var mi = 0; mi < sorted.length; mi++) {
    var skey = sorted[mi].srcIdx + "-" + sorted[mi].srcType;
    if (!linesByStartAndType[skey]) linesByStartAndType[skey] = [];
    linesByStartAndType[skey].push(sorted[mi]);
  }

  // Track which lines have already been used in a macro chain
  var usedInMacro = {};

  for (var mi = 0; mi < sorted.length; mi++) {
    if (usedInMacro[mi]) continue;

    var chain = [sorted[mi]];
    var current = sorted[mi];

    // Try to extend this chain forward
    var searching = true;
    while (searching) {
      searching = false;
      var nextKey = current.dstIdx + "-" + current.dstType;
      var nextCandidates = linesByStartAndType[nextKey];
      if (!nextCandidates) break;

      for (var ni = 0; ni < nextCandidates.length; ni++) {
        var next = nextCandidates[ni];
        // Check angle similarity
        var angleDiff = Math.abs(current.angleDeg - next.angleDeg);
        if (angleDiff <= angleTolerance) {
          var sortedIdx = sorted.indexOf(next);
          if (sortedIdx >= 0 && !usedInMacro[sortedIdx]) {
            chain.push(next);
            usedInMacro[sortedIdx] = true;
            current = next;
            searching = true;
            break;
          }
        }
      }
    }

    // A macro trend needs at least 2 connected segments
    if (chain.length >= 2) {
      usedInMacro[mi] = true;

      // Build the polyline: collect every vertex along the chain.
      var points = [{ x: chain[0].x1, y: chain[0].y1 }];
      for (var ci2 = 0; ci2 < chain.length; ci2++) {
        points.push({ x: chain[ci2].x2, y: chain[ci2].y2 });
      }

      // Average angle of all segments
      var avgAngle = 0;
      for (var ci3 = 0; ci3 < chain.length; ci3++) {
        avgAngle += chain[ci3].angleDeg;
      }
      avgAngle /= chain.length;

      macroLines.push({
        points: points,
        segments: chain.length,
        totalSpan: chain[chain.length - 1].dstIdx - chain[0].srcIdx,
        avgAngle: avgAngle,
        tipType: chain[0].srcType,     // "h" or "l" (all same in chain)
      });
    }
  }

  return {
    baseLines: baseLines,
    rays: rays,
    macroLines: macroLines,
  };
}


// Render the sight lines layers onto the canvas.
// The LENGTH→STRENGTH slider controls how much a line's pixel
// length affects its brightness and thickness.
function renderSightLines(data, accentColor) {
  ctx.save();

  var mom = state.slMomentum;  // 0..1

  // Helper: pixel length of a line
  function pxLen(x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Find the max pixel length across ALL visible layers for normalization.
  var maxLen = 1;
  if (state.slShowBase) {
    for (var i = 0; i < data.baseLines.length; i++) {
      var bl = data.baseLines[i];
      var l = pxLen(bl.x1, bl.y1, bl.x2, bl.y2);
      if (l > maxLen) maxLen = l;
    }
  }
  if (state.slShowRays) {
    for (var i = 0; i < data.rays.length; i++) {
      var rl = pxLen(data.rays[i].x1, data.rays[i].y1, data.rays[i].x2, data.rays[i].y2);
      if (rl > maxLen) maxLen = rl;
    }
  }
  if (state.slShowMacro) {
    for (var i = 0; i < data.macroLines.length; i++) {
      var ml = data.macroLines[i];
      var total = 0;
      for (var p = 1; p < ml.points.length; p++) {
        total += pxLen(ml.points[p-1].x, ml.points[p-1].y, ml.points[p].x, ml.points[p].y);
      }
      if (total > maxLen) maxLen = total;
    }
  }

  // Helper: compute length-based multiplier.
  // At mom=0: always returns 1 (no effect).
  // At mom=1: ranges from 0.05 (shortest) to 2.0 (longest).
  function lengthBoost(lineLen) {
    if (mom < 0.01) return 1.0;
    var norm = lineLen / maxLen;  // 0..1
    var boosted = 0.05 + norm * 1.95;  // 0.05..2.0
    return 1.0 + (boosted - 1.0) * mom;
  }

  // Helper: get line color
  function getColor(srcType, slope, accent) {
    if (accent) {
      return {
        r: parseInt(accent.slice(1, 3), 16),
        g: parseInt(accent.slice(3, 5), 16),
        b: parseInt(accent.slice(5, 7), 16),
      };
    }
    if (srcType === "h") {
      if (slope > 0.01)      return { r: 255, g: 100, b: 60 };
      else if (slope < -0.01) return { r: 255, g: 180, b: 50 };
      else                    return { r: 255, g: 140, b: 80 };
    } else {
      if (slope < -0.01)     return { r: 0, g: 200, b: 120 };
      else if (slope > 0.01) return { r: 0, g: 160, b: 200 };
      else                   return { r: 60, g: 180, b: 160 };
    }
  }

  // ---- Layer 1: Base sight lines ----
  if (state.slShowBase) {
    for (var i = 0; i < data.baseLines.length; i++) {
      var ln = data.baseLines[i];
      var c = getColor(ln.srcType, ln.slope, accentColor);
      var ll = pxLen(ln.x1, ln.y1, ln.x2, ln.y2);
      var boost = lengthBoost(ll);

      var vw = 0.5 + (ln.volWeight || 0.5) * 0.5;
      var iw = 0.5 + (ln.intensityWeight || 0.5) * 0.5;

      var spanFade = Math.min(1.0, ln.span / 8);
      var alpha = (0.08 + spanFade * 0.25) * boost * vw * iw;
      var lineW = (0.5 + Math.min(1.0, ln.span / 15) * 1.0) * boost * vw * iw;

      if (alpha < 0.01) continue;
      alpha = Math.min(alpha, 0.9);

      ctx.strokeStyle = "rgba(" + c.r + "," + c.g + "," + c.b + "," + alpha.toFixed(3) + ")";
      ctx.lineWidth = lineW;
      ctx.beginPath();
      ctx.moveTo(ln.x1, ln.y1);
      ctx.lineTo(ln.x2, ln.y2);
      ctx.stroke();
    }
  }

  // ---- Layer 2: Extended rays ----
  if (state.slShowRays) {
    for (var ri = 0; ri < data.rays.length; ri++) {
      var ray = data.rays[ri];
      var rc = getColor(ray.srcType, ray.slope, accentColor);
      var rl2 = pxLen(ray.x1, ray.y1, ray.x2, ray.y2);
      var rboost = lengthBoost(rl2);

      var momNorm = Math.min(1.0, ray.momentum / 200);
      var rayAlpha = (0.06 + momNorm * 0.45) * rboost;
      var rayW = (0.5 + momNorm * 2.5) * rboost;

      if (rayAlpha < 0.01) continue;
      rayAlpha = Math.min(rayAlpha, 0.9);

      ctx.strokeStyle = "rgba(" + rc.r + "," + rc.g + "," + rc.b + "," + rayAlpha.toFixed(3) + ")";
      ctx.lineWidth = rayW;
      ctx.setLineDash([4 + momNorm * 4, 3]);
      ctx.beginPath();
      ctx.moveTo(ray.x1, ray.y1);
      ctx.lineTo(ray.x2, ray.y2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ---- Layer 3: Macro trend lines (polylines) ----
  if (state.slShowMacro) {
    for (var mi = 0; mi < data.macroLines.length; mi++) {
      var ml = data.macroLines[mi];

      var totalLen = 0;
      for (var pl = 1; pl < ml.points.length; pl++) {
        totalLen += pxLen(ml.points[pl-1].x, ml.points[pl-1].y, ml.points[pl].x, ml.points[pl].y);
      }
      var mboost = lengthBoost(totalLen);

      var mr, mg, mb;
      if (accentColor) {
        mr = parseInt(accentColor.slice(1, 3), 16);
        mg = parseInt(accentColor.slice(3, 5), 16);
        mb = parseInt(accentColor.slice(5, 7), 16);
      } else if (ml.tipType === "h") {
        mr = 255; mg = 160; mb = 60;
      } else {
        mr = 0; mg = 230; mb = 140;
      }

      var segStrength = Math.min(1.0, ml.segments / 5);
      var macroAlpha = (0.3 + segStrength * 0.5) * mboost;
      var macroW = (1.5 + segStrength * 3.0) * mboost;

      macroAlpha = Math.min(macroAlpha, 0.95);

      ctx.strokeStyle = "rgba(" + mr + "," + mg + "," + mb + "," + macroAlpha.toFixed(3) + ")";
      ctx.lineWidth = macroW;
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(ml.points[0].x, ml.points[0].y);
      for (var pi = 1; pi < ml.points.length; pi++) {
        ctx.lineTo(ml.points[pi].x, ml.points[pi].y);
      }
      ctx.stroke();

      var midPtIdx = Math.floor(ml.points.length / 2);
      var midX = ml.points[midPtIdx].x;
      var midY = ml.points[midPtIdx].y;
      ctx.fillStyle = "rgba(" + mr + "," + mg + "," + mb + "," + (macroAlpha * 0.8).toFixed(3) + ")";
      ctx.font = "bold 9px monospace";
      ctx.textAlign = "center";
      ctx.fillText(ml.segments + "×", midX, midY - 6);
    }
  }

  ctx.restore();
}


// ================================================================
// INCREMENTAL ANIMATION: Pre-compute Visibility Pairs
// ================================================================
// The O(n³) occlusion check runs ONCE on the full candle dataset.
// Works entirely in price/index space — no pixel coordinates —
// so the result is valid regardless of chart dimensions or zoom.
//
// Returns an array of { srcIdx, dstIdx, srcType, volWeight, intensityWeight }
// objects representing every clear H-H and L-L sight line in the dataset.
//
// During animation, we filter this list to pairs where dstIdx < visibleCount,
// then convert to pixel space. This turns O(n³) per frame into O(n) per frame.

function precomputeVisibilityPairs(candles) {
  var count = candles.length;
  var pairs = [];

  // Pre-compute volume and intensity weights for all candles.
  // These are properties of the candle itself, not of the chart layout.
  var volWeights       = calcVolumeWeights(candles);
  var intensityWeights = calcIntensityWeights(candles, state.intensityMode);

  for (var i = 0; i < count; i++) {
    // Two tip types: high-to-high and low-to-low
    for (var tipIdx = 0; tipIdx < 2; tipIdx++) {
      var srcType  = tipIdx === 0 ? "h" : "l";
      var srcPrice = srcType === "h" ? candles[i].h : candles[i].l;

      for (var j = i + 1; j < count; j++) {
        var dstPrice = srcType === "h" ? candles[j].h : candles[j].l;

        // Occlusion check in price space:
        // For each candle k between i and j, interpolate the line
        // price at position k. If it falls inside candle k's range,
        // the sight line is blocked.
        var blocked = false;
        for (var k = i + 1; k < j; k++) {
          var t = (k - i) / (j - i);
          var linePrice = srcPrice + t * (dstPrice - srcPrice);
          // In price space: blocked if line passes through [low, high]
          if (linePrice <= candles[k].h && linePrice >= candles[k].l) {
            blocked = true;
            break;
          }
        }

        if (!blocked) {
          pairs.push({
            srcIdx:  i,
            dstIdx:  j,
            srcType: srcType,
            volWeight:       (volWeights[i] + volWeights[j]) / 2,
            intensityWeight: (intensityWeights[i] + intensityWeights[j]) / 2,
          });
        }
      }
    }
  }

  return pairs;
}


// ================================================================
// INCREMENTAL ANIMATION: Build Sight Lines from Cached Pairs
// ================================================================
// Takes pre-computed visibility pairs and converts the visible
// subset into full sight-line data (pixel coords, rays, macros).
//
// This replaces the expensive buildSightLines() during animation.
// The O(n³) occlusion work was already done in precomputeVisibilityPairs.
// Here we just do O(visible_pairs) coordinate conversion + ray extension.

function buildSightLinesFromPairs(pairs, candles, dims, visibleCount, lockedRange) {
  var chartLeft   = dims.chartLeft;
  var chartWidth  = dims.chartWidth;
  var chartTop    = dims.chartTop;
  var chartHeight = dims.chartHeight;

  var range    = lockedRange || getPriceRange(candles);
  var priceMin = range.priceMin;
  var priceMax = range.priceMax;
  var count    = candles.length;  // visible count
  var candleW  = chartWidth / CONFIG.CANDLE_COUNT;

  // ---- RECOMPUTE WEIGHTS FROM VISIBLE CANDLES ONLY ----
  // The precomputed pairs store volWeight and intensityWeight that
  // were calculated from ALL candles (including future ones during
  // animation). Recomputing from visible candles only ensures no
  // future data leaks through beam brightness.
  var freshVolWeights = calcVolumeWeights(candles);
  var freshIntWeights = calcIntensityWeights(candles, state.intensityMode);

  // Pre-compute tip positions and extents for visible candles
  var tips    = [];
  var extents = [];
  for (var i = 0; i < count; i++) {
    var c  = candles[i];
    var cx = indexToX(i, count, chartLeft, chartWidth);
    var hy = priceToY(c.h, priceMin, priceMax, chartTop, chartHeight);
    var ly = priceToY(c.l, priceMin, priceMax, chartTop, chartHeight);
    tips.push({ hx: cx, hy: hy, lx: cx, ly: ly });
    extents.push({ x: cx, highY: hy, lowY: ly });
  }

  // ---- Convert visible pairs to pixel-space base lines ----
  var baseLines = [];
  for (var pi = 0; pi < pairs.length; pi++) {
    var p = pairs[pi];
    // Skip pairs beyond visible range
    if (p.dstIdx >= visibleCount) continue;

    var srcTip = tips[p.srcIdx];
    var dstTip = tips[p.dstIdx];
    var srcX = p.srcType === "h" ? srcTip.hx : srcTip.lx;
    var srcY = p.srcType === "h" ? srcTip.hy : srcTip.ly;
    var dstX = p.srcType === "h" ? dstTip.hx : dstTip.lx;
    var dstY = p.srcType === "h" ? dstTip.hy : dstTip.ly;

    var pxSlope  = (dstY - srcY) / (dstX - srcX);
    var angleDeg = Math.atan(pxSlope) * (180 / Math.PI);

    // Use FRESH weights from visible candles, not pre-stored ones
    var freshVW = (freshVolWeights[p.srcIdx] + freshVolWeights[p.dstIdx]) / 2;
    var freshIW = (freshIntWeights[p.srcIdx] + freshIntWeights[p.dstIdx]) / 2;

    baseLines.push({
      x1: srcX, y1: srcY,
      x2: dstX, y2: dstY,
      slope:    pxSlope,
      angleDeg: angleDeg,
      span:     p.dstIdx - p.srcIdx,
      srcIdx:   p.srcIdx,
      dstIdx:   p.dstIdx,
      srcType:  p.srcType,
      dstType:  p.srcType,
      volWeight:       freshVW,
      intensityWeight: freshIW,
    });
  }

  // ---- Compute peaks and troughs for ray extension ----
  var isPeak   = [];
  var isTrough = [];
  for (var pi2 = 0; pi2 < count; pi2++) {
    var prevH = (pi2 > 0)         ? candles[pi2 - 1].h : -Infinity;
    var nextH = (pi2 < count - 1) ? candles[pi2 + 1].h : -Infinity;
    isPeak.push(candles[pi2].h >= prevH && candles[pi2].h >= nextH);

    var prevL = (pi2 > 0)         ? candles[pi2 - 1].l : Infinity;
    var nextL = (pi2 < count - 1) ? candles[pi2 + 1].l : Infinity;
    isTrough.push(candles[pi2].l <= prevL && candles[pi2].l <= nextL);
  }
  // Disqualify candles that are both peak and trough
  for (var pi3 = 0; pi3 < count; pi3++) {
    if (isPeak[pi3] && isTrough[pi3]) {
      isPeak[pi3] = false;
      isTrough[pi3] = false;
    }
  }

  // ---- Extend rays past endpoints (same logic as buildSightLines) ----
  var rays = [];
  var spreadDeg = state.beamSpread || 0;
  var spreadRad = spreadDeg * (Math.PI / 180);
  var subRayCount = spreadDeg < 0.5 ? 1 : Math.min(1 + Math.round(spreadDeg * 0.8), 15);

  for (var ri = 0; ri < baseLines.length; ri++) {
    var bl = baseLines[ri];

    // Only extend from peaks (H-H) or troughs (L-L)
    if (bl.dstType === "h" && !isPeak[bl.dstIdx])   continue;
    if (bl.dstType === "l" && !isTrough[bl.dstIdx]) continue;

    var dx = bl.x2 - bl.x1;
    var dy = bl.y2 - bl.y1;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) continue;

    var baseAngle = Math.atan2(dy, dx);

    // Emit sub-rays across the spread angle
    for (var sri = 0; sri < subRayCount; sri++) {
      var subAngle, t;
      if (subRayCount === 1) {
        subAngle = baseAngle;
        t = 0.5;
      } else {
        t = sri / (subRayCount - 1);
        subAngle = baseAngle + spreadRad * (t - 0.5);
      }

      var sndx = Math.cos(subAngle);
      var sndy = Math.sin(subAngle);

      var spreadFalloff = 1.0;
      if (subRayCount > 1) {
        var offCenter = Math.abs(t - 0.5) * 2;
        spreadFalloff = 1.0 - offCenter * 0.5;
      }

      // March forward from the endpoint
      var stepSize = 2;
      var rx = bl.x2 + sndx * stepSize;
      var ry = bl.y2 + sndy * stepSize;
      var extDist = 0;
      var maxDist = Math.sqrt(dims.width * dims.width + dims.height * dims.height);
      var hit = false;

      while (extDist < maxDist) {
        if (rx < 0 || rx >= dims.width || ry < 0 || ry >= dims.height) break;

        var candleIdx = ((rx - chartLeft) / candleW) | 0;
        for (var ci = Math.max(0, candleIdx - 1); ci <= Math.min(count - 1, candleIdx + 1); ci++) {
          if (ci <= bl.dstIdx) continue;
          var ext = extents[ci];
          var candleX = tips[ci].hx;
          if (Math.abs(rx - candleX) < candleW * 0.5 &&
              ry >= ext.highY && ry <= ext.lowY) {
            hit = true;
            break;
          }
        }
        if (hit) break;

        rx += sndx * stepSize;
        ry += sndy * stepSize;
        extDist += stepSize;
      }

      if (extDist > 2) {
        rays.push({
          x1: bl.x2, y1: bl.y2,
          x2: rx, y2: ry,
          momentum: extDist,
          hit: hit,
          slope: bl.slope,
          angleDeg: subAngle * (180 / Math.PI),
          srcIdx: bl.srcIdx,
          dstIdx: bl.dstIdx,
          srcType: bl.srcType,
          dstType: bl.dstType,
          parentSpan: bl.span,
          spreadFalloff: spreadFalloff,
        });
      }
    }
  }

  // ---- Build macro trend lines (same logic as buildSightLines) ----
  var macroLines = [];
  var angleTolerance = state.slMacroAngle;

  var sorted = baseLines.slice().sort(function(a, b) {
    return a.srcIdx - b.srcIdx || a.dstIdx - b.dstIdx;
  });

  var linesByStartAndType = {};
  for (var mi = 0; mi < sorted.length; mi++) {
    var skey = sorted[mi].srcIdx + "-" + sorted[mi].srcType;
    if (!linesByStartAndType[skey]) linesByStartAndType[skey] = [];
    linesByStartAndType[skey].push(sorted[mi]);
  }

  var usedInMacro = {};
  for (var mi2 = 0; mi2 < sorted.length; mi2++) {
    if (usedInMacro[mi2]) continue;

    var chain = [sorted[mi2]];
    var current = sorted[mi2];
    var searching = true;

    while (searching) {
      searching = false;
      var nextKey = current.dstIdx + "-" + current.dstType;
      var nextCandidates = linesByStartAndType[nextKey];
      if (!nextCandidates) break;

      for (var ni = 0; ni < nextCandidates.length; ni++) {
        var next = nextCandidates[ni];
        var angleDiff = Math.abs(current.angleDeg - next.angleDeg);
        if (angleDiff <= angleTolerance) {
          var sortedIdx = sorted.indexOf(next);
          if (sortedIdx >= 0 && !usedInMacro[sortedIdx]) {
            chain.push(next);
            usedInMacro[sortedIdx] = true;
            current = next;
            searching = true;
            break;
          }
        }
      }
    }

    if (chain.length >= 2) {
      usedInMacro[mi2] = true;
      var points = [{ x: chain[0].x1, y: chain[0].y1 }];
      for (var ci2 = 0; ci2 < chain.length; ci2++) {
        points.push({ x: chain[ci2].x2, y: chain[ci2].y2 });
      }
      var avgAngle = 0;
      for (var ci3 = 0; ci3 < chain.length; ci3++) {
        avgAngle += chain[ci3].angleDeg;
      }
      avgAngle /= chain.length;

      macroLines.push({
        points:    points,
        segments:  chain.length,
        totalSpan: chain[chain.length - 1].dstIdx - chain[0].srcIdx,
        avgAngle:  avgAngle,
        tipType:   chain[0].srcType,
      });
    }
  }

  return {
    baseLines:  baseLines,
    rays:       rays,
    macroLines: macroLines,
  };
}


// ================================================================
// BACKGROUND S/R RAYCASTING (Daily Context)
// ================================================================
// Runs the SAME sight-line engine on the 200-day candle data,
// positioned off-screen to the left. The resulting beams project
// rightward into the visible chart area.
//
// The daily candles themselves are not drawn, but their beams are.

function buildBackgroundSightLines(bgCandles, dims, priceMin, priceMax) {
  if (!bgCandles || bgCandles.length < 5) return null;

  var chartLeft   = dims.chartLeft;
  var chartWidth  = dims.chartWidth;
  var chartTop    = dims.chartTop;
  var chartHeight = dims.chartHeight;
  var bgCount     = bgCandles.length;

  // Position daily candles to the LEFT of the visible chart.
  var candleW = chartWidth / CONFIG.CANDLE_COUNT;
  var bgWidth = bgCount * candleW;
  var bgLeft  = chartLeft - bgWidth;  // starts off-screen left

  // Pre-compute tip positions in pixel space
  var tips = [];
  var extents = [];

  for (var i = 0; i < bgCount; i++) {
    var c  = bgCandles[i];
    var cx = bgLeft + (i + 0.5) * candleW;
    var hy = priceToY(c.h, priceMin, priceMax, chartTop, chartHeight);
    var ly = priceToY(c.l, priceMin, priceMax, chartTop, chartHeight);

    tips.push({ hx: cx, hy: hy, lx: cx, ly: ly });
    extents.push({ x: cx, highY: hy, lowY: ly });
  }

  // Build H-H and L-L sight lines (same rules as visible candles).
  // Limit connection distance to 60 days for performance.
  var maxSpan = 60;
  var baseLines = [];

  for (var i = 0; i < bgCount; i++) {
    var srcTips = [
      { x: tips[i].hx, y: tips[i].hy, label: "h" },
      { x: tips[i].lx, y: tips[i].ly, label: "l" },
    ];

    for (var si = 0; si < 2; si++) {
      var src = srcTips[si];
      var jMax = Math.min(bgCount, i + maxSpan);

      for (var j = i + 1; j < jMax; j++) {
        var dst;
        if (src.label === "h") {
          dst = { x: tips[j].hx, y: tips[j].hy, label: "h" };
        } else {
          dst = { x: tips[j].lx, y: tips[j].ly, label: "l" };
        }

        var blocked = false;
        for (var k = i + 1; k < j; k++) {
          var ext = extents[k];
          var t = (ext.x - src.x) / (dst.x - src.x);
          var lineY = src.y + t * (dst.y - src.y);
          if (lineY >= ext.highY && lineY <= ext.lowY) {
            blocked = true;
            break;
          }
        }

        if (!blocked) {
          baseLines.push({
            x1: src.x, y1: src.y,
            x2: dst.x, y2: dst.y,
            slope: (dst.y - src.y) / (dst.x - src.x),
            span: j - i,
            srcIdx: i,
            dstIdx: j,
            srcType: src.label,
            dstType: dst.label,
          });
        }
      }
    }
  }

  // Extend each base line rightward past its endpoint
  var rays = [];

  for (var ri = 0; ri < baseLines.length; ri++) {
    var bl = baseLines[ri];
    var dx = bl.x2 - bl.x1;
    var dy = bl.y2 - bl.y1;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) continue;

    var ndx = dx / len;
    var ndy = dy / len;

    // Only extend rightward
    if (ndx <= 0) continue;

    var stepSize = candleW;
    var rx = bl.x2 + ndx * stepSize;
    var ry = bl.y2 + ndy * stepSize;
    var extDist = 0;
    var maxDist = bgWidth + chartWidth + 200;
    var hit = false;

    while (extDist < maxDist) {
      if (rx > chartLeft + chartWidth + 50) break;
      if (ry < chartTop - 50 || ry > chartTop + chartHeight + 50) break;

      var candleIdx = Math.floor((rx - bgLeft) / candleW);
      for (var ci = Math.max(0, candleIdx - 1); ci <= Math.min(bgCount - 1, candleIdx + 1); ci++) {
        if (ci <= bl.dstIdx) continue;
        var ext = extents[ci];
        if (Math.abs(rx - tips[ci].hx) < candleW * 0.5 &&
            ry >= ext.highY && ry <= ext.lowY) {
          hit = true;
          break;
        }
      }
      if (hit) break;

      rx += ndx * stepSize;
      ry += ndy * stepSize;
      extDist += stepSize;
    }

    if (rx > chartLeft - candleW * 2 && extDist > candleW) {
      rays.push({
        x1: bl.x2, y1: bl.y2,
        x2: rx, y2: ry,
        slope: bl.slope,
        srcType: bl.srcType,
        dstType: bl.dstType,
        momentum: extDist,
        parentSpan: bl.span,
      });
    }
  }

  return { baseLines: baseLines, rays: rays, macroLines: [] };
}
