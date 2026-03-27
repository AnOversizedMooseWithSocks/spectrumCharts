/*
 * ================================================================
 * coords.js  —  Coordinate Mapping Helpers
 * ================================================================
 * Depends on: config.js (CONFIG, state, canvas)
 *
 * Functions to convert between price values and pixel positions,
 * compute chart dimensions, and handle the projection zone layout.
 *
 * ---- WORLD COORDINATES & EXPLORATION ----
 *
 * The chart is drawn in a "world" coordinate space that can be
 * LARGER than the screen in both dimensions, maintaining the screen
 * aspect ratio. When projection is on, the world extends:
 *   - Rightward: more room for beams, topology, light field
 *   - Vertically: more price range for the light field above/below
 *
 * At zoom=1.0, the view is positioned so the chart looks identical
 * to the original (candles centered, projection visible). Zooming
 * out reveals the extended light field in all directions. Pan and
 * zoom are clamped so the world always fills the screen — no black
 * edges ever appear.
 *
 * Key relationships:
 *   worldW = screenW * EXPLORE_MULTIPLIER
 *   worldH = screenH * EXPLORE_MULTIPLIER
 *   minZoom = 1.0 / EXPLORE_MULTIPLIER  (world exactly fills screen)
 *   maxZoom = uncapped (zoom in as far as you want)
 *
 * ================================================================
 */

// How much larger the world is than the screen (both dimensions).
// At 2.0, zooming all the way out shows 4× the area (2× width,
// 2× height). The extra width is projection space; the extra
// height is additional price range with visible light field.
// Set to 1.0 to disable world expansion entirely.
//
// Performance note: beam computation scales with world area, so
// M=2.0 is roughly 4× the work. This is a one-time cached cost.
var EXPLORE_MULTIPLIER = 2.0;


// Convert a price value to a Y pixel position on the chart.
// Higher prices = lower Y values (canvas Y increases downward).
function priceToY(price, priceMin, priceMax, chartTop, chartHeight) {
  var ratio = (price - priceMin) / (priceMax - priceMin);
  return chartTop + chartHeight * (1 - ratio);
}

// Convert a candle index to its X center pixel.
// Always uses CONFIG.CANDLE_COUNT for spacing so candles don't
// change size during animation — they just fill in from the left.
function indexToX(i, count, chartLeft, chartWidth) {
  var totalCount = CONFIG.CANDLE_COUNT;
  var candleWidth = chartWidth / totalCount;
  return chartLeft + i * candleWidth + candleWidth / 2;
}

// Get the min/max price range for a set of candles (with padding).
//
// When projection is on, padding scales with EXPLORE_MULTIPLIER so
// that the full world height has meaningful price data (light field
// above and below). The math ensures that at zoom=1.0, the visible
// price range around the candles looks identical to the original:
//
//   basePad = 0.40 → original total = 1.8 × candleRange
//   At zoom=1.0, you see 1/M of the world height = 1.8 × candleRange
//   Total mapped range = M × 1.8 × candleRange
//   Effective padPct = (M × 1.8 - 1) / 2
//
function getPriceRange(candles) {
  var min = Infinity;
  var max = -Infinity;
  for (var i = 0; i < candles.length; i++) {
    if (candles[i].l < min) min = candles[i].l;
    if (candles[i].h > max) max = candles[i].h;
  }
  var range = max - min;

  var padPct;
  if (state.showProjection && EXPLORE_MULTIPLIER > 1.0) {
    // Scale padding so candles look the same at zoom=1.0, but the
    // full world height is covered with price data for the light field.
    var M = EXPLORE_MULTIPLIER;
    padPct = (M * 1.8 - 1) / 2;  // M=2 → 1.3, M=1 → 0.4
  } else if (state.showProjection) {
    padPct = 0.40;
  } else {
    padPct = 0.05;
  }

  var pad = range * padPct;
  return { priceMin: min - pad, priceMax: max + pad };
}

// Get the chart drawing area dimensions.
//
// When projection is on, the world is larger than the screen in
// BOTH dimensions (same aspect ratio). The candle area stays at
// screen-proportional width. All extra width goes to projection.
// All extra height goes to expanded price range (light field).
//
// When projection is off, world = screen (no performance cost).
function getChartDims() {
  var screenW = canvas.logicalWidth  || canvas.width;
  var screenH = canvas.logicalHeight || canvas.height;
  var priceAxisW = 65;

  // ---- WORLD DIMENSIONS ----
  // Both dimensions scale by the same factor to maintain aspect ratio.
  var worldW = screenW;
  var worldH = screenH;
  if (state.showProjection && EXPLORE_MULTIPLIER > 1.0) {
    worldW = Math.floor(screenW * EXPLORE_MULTIPLIER);
    worldH = Math.floor(screenH * EXPLORE_MULTIPLIER);
  }

  // ---- CANDLE AREA WIDTH ----
  // Based on SCREEN width (not world width) so candle sizes stay
  // consistent. All extra world width goes to the projection zone.
  var candleAreaW = worldW - priceAxisW;
  if (state.showProjection) {
    candleAreaW = Math.floor((screenW - priceAxisW) * 0.70);
  }

  return {
    width:       worldW,        // world width (may be > screen)
    height:      worldH,        // world height (may be > screen)
    screenW:     screenW,       // actual screen width
    screenH:     screenH,       // actual screen height
    chartLeft:   10,
    chartWidth:  candleAreaW,
    chartTop:    10,
    chartHeight: worldH - 30,   // spans full world height
    totalCandles: CONFIG.CANDLE_COUNT,
  };
}

// Compute projection zone: starts right after the last visible candle.
//
// projWidth is screen-proportional (not world-width) because the
// prediction engine generates a fixed number of candle steps.
// The BEAMS and TOPOLOGY extend across the full world via the
// heatmap grid regardless, so panning right shows the light field
// that extends into the future.
function getProjectionDims(dims, visibleCount) {
  if (!state.showProjection) return null;

  var candleW = dims.chartWidth / CONFIG.CANDLE_COUNT;
  // Start right after the last visible candle
  var projLeft = dims.chartLeft + visibleCount * candleW;
  // projWidth based on SCREEN width, not world width
  var screenW = dims.screenW || dims.width;
  var projRight = screenW - 65;
  var projWidth = projRight - projLeft;

  if (projWidth < 20) return null;

  return {
    projLeft:  projLeft,
    projWidth: projWidth,
    candleW:   candleW,
  };
}


// ================================================================
// ZOOM / PAN CLAMPING
// ================================================================
// These functions enforce two rules:
//   1. You can't zoom out past the point where the world fills
//      the screen (no black edges).
//   2. You can't pan past the world boundaries (no black edges).
//
// Called after any zoom or pan change.

// Returns the minimum zoom level: the scale at which the world
// exactly fills the screen. Since aspect ratio is maintained,
// this is simply 1 / EXPLORE_MULTIPLIER.
function getMinZoom() {
  if (state.showProjection && EXPLORE_MULTIPLIER > 1.0) {
    return 1.0 / EXPLORE_MULTIPLIER;
  }
  return 1.0;  // no world expansion → can't zoom out
}

// Clamp viewOffset so the visible viewport (screen / scale) stays
// entirely within world bounds. Call after any zoom or pan change.
//
// The visible rectangle in world coords:
//   topLeft  = (-offsetX / scale, -offsetY / scale)
//   size     = (screenW / scale,  screenH / scale)
//
// We clamp topLeft so the rect doesn't go outside [0, worldW] × [0, worldH].
function clampPan() {
  if (!canvas) return;
  var screenW = canvas.logicalWidth  || canvas.width;
  var screenH = canvas.logicalHeight || canvas.height;

  var worldW = screenW;
  var worldH = screenH;
  if (state.showProjection && EXPLORE_MULTIPLIER > 1.0) {
    worldW = Math.floor(screenW * EXPLORE_MULTIPLIER);
    worldH = Math.floor(screenH * EXPLORE_MULTIPLIER);
  }

  var s = state.viewScale;
  // Visible area size in world coords
  var visW = screenW / s;
  var visH = screenH / s;

  // Current top-left in world coords
  var wx = -state.viewOffsetX / s;
  var wy = -state.viewOffsetY / s;

  // Clamp to world bounds
  if (wx < 0)              wx = 0;
  if (wy < 0)              wy = 0;
  if (wx + visW > worldW)  wx = worldW - visW;
  if (wy + visH > worldH)  wy = worldH - visH;

  // Convert back to offset
  state.viewOffsetX = -wx * s;
  state.viewOffsetY = -wy * s;
}

// "Home" position: zoom=1.0, candles at left, vertically centered
// in the world so the candle price range is centered on screen.
function getHomeOffset() {
  var ox = 0;
  var oy = 0;
  if (canvas && state.showProjection && EXPLORE_MULTIPLIER > 1.0) {
    var screenH = canvas.logicalHeight || canvas.height;
    var worldH  = Math.floor(screenH * EXPLORE_MULTIPLIER);
    // Center the world vertically on the screen
    oy = -(worldH - screenH) / 2;
  }
  return { x: ox, y: oy };
}
