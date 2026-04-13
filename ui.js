/*
 * ================================================================
 * ui.js  —  UI Event Handlers & Toolbar/Legend Updates
 * ================================================================
 * Depends on: config.js (CONFIG, state, all caches)
 *
 * Called by the onclick handlers in index.html.
 * Each handler updates state, clears caches as needed, and redraws.
 * Also includes toolbar button state management and legend text.
 * ================================================================
 */

// ================================================================
// UI EVENT HANDLERS
// ================================================================

function setMode(newMode) {
  state.mode = newMode;
  heatmapCache   = {};
  sightLineCache = {};
  particles      = {};
  cancelAnim();
  updateToolbar();
  updateLegend();
  drawFrame();
}

function setAsset(newAsset) {
  state.asset      = newAsset;
  state.multiAsset = false;
  heatmapCache   = {};
  sightLineCache = {};
  particles      = {};
  cancelAnim();
  updateToolbar();
  drawFrame();
}

function toggleOverlay() {
  state.multiAsset = !state.multiAsset;
  heatmapCache   = {};
  sightLineCache = {};
  particles      = {};
  cancelAnim();
  updateToolbar();
  updateLegend();
  drawFrame();
}

function toggleCandles() {
  state.showCandles = !state.showCandles;
  heatmapCache   = {};
  sightLineCache = {};
  cancelAnim();
  updateToolbar();
  drawFrame();
}

// Toggle indicator overlay lines (just visual, doesn't affect predictions)
function toggleOverlayLine(which) {
  var key = "show" + which;
  state[key] = !state[key];
  cancelAnim();
  updateToolbar();
  drawFrame();
}

function toggleProjection() {
  state.showProjection = !state.showProjection;
  // Price range changes (more padding when projection is on)
  heatmapCache   = {};
  sightLineCache = {};
  particles      = {};
  cancelAnim();
  updateToolbar();
  drawFrame();
}

function setResolution(val) {
  state.heatmapRes = val;
  heatmapCache = {};
  cancelAnim();
  drawFrame();
}

// Set candle body opacity from slider (0..100 -> 0..1).
// 0% = fully transparent (light passes through unimpeded).
// 100% = fully opaque (candle body blocks all light, hard shadows).
function setTranslucency(pct) {
  state.translucency = pct / 100;
  var valEl = document.getElementById("translucency-val");
  if (valEl) valEl.textContent = pct + "%";
  heatmapCache = {};
  cancelAnim();
  drawFrame();
}

// Beam length -> glow: longer beams get brighter.
// 0% = all beams same brightness. 100% = long beams dominate.
function setBeamLenBoost(pct) {
  state.beamLenBoost = pct / 100;
  var valEl = document.getElementById("beam-len-val");
  if (valEl) valEl.textContent = pct + "%";
  heatmapCache = {};
  cancelAnim();
  drawFrame();
}

// Set beam spread angle (degrees). Each extended ray fans out into
// multiple sub-rays spanning this angle. 0 = single line, 45 = wide cone.
function setBeamSpread(deg) {
  state.beamSpread = deg;
  var valEl = document.getElementById("beam-spread-val");
  if (valEl) valEl.textContent = deg + "°";
  // Spread changes the rays, which changes both sight line cache and heatmap
  sightLineCache = {};
  heatmapCache = {};
  cancelAnim();
  drawFrame();
}

// Toggle "Rays Only" mode for the raycast heatmap.
// When on, the base sight-line beams (source tip → destination tip)
// are hidden. Only the extended rays (continuing past the destination
// until they hit another candle or leave the chart) are painted.
// This isolates the projected momentum lines from the connections.
function toggleRaysOnly() {
  state.raysOnly = !state.raysOnly;
  heatmapCache = {};
  cancelAnim();
  updateToolbar();
  drawFrame();
}

// Set a color force property: direction or strength.
// color: "green", "yellow", "blue", "red"
// prop: "dir" or "str"
// value: string from the HTML control (parsed to number)
function setColorForce(color, prop, value) {
  var num = parseFloat(value);
  if (prop === "dir") {
    state.colorForce[color].dir = num;  // 1 or -1
  } else {
    state.colorForce[color].str = num / 100;  // slider 0..200 -> 0..2.0
    // Update the display label
    var valEl = document.getElementById("cf-" + color + "-val");
    if (valEl) valEl.textContent = (num / 100).toFixed(1);
  }
  // Projection reads from state.colorForce; no heatmap cache to clear
  // since the light grids don't change — only the force interpretation.
  // But calibration should reset since the physics changed.
  calibration = {};
  cancelAnim();
  drawFrame();
}


// Set a particle physics parameter from the wind tunnel controls.
// param: "candleAttract", "repulsion", or "size"
// value: string from the HTML slider (0..200 for forces, 10..120 for size)
function setParticleParam(param, value) {
  var num = parseFloat(value);
  if (param === "repulsion") {
    // Slider 0..200 → 0..2.0
    var scaled = num / 100;
    var valEl = document.getElementById("particle-repulse-val");
    if (valEl) valEl.textContent = scaled.toFixed(2);
    if (window.gpuParticles && window.gpuParticles.setParam) {
      window.gpuParticles.setParam("repulsion", scaled);
    }
  } else if (param === "size") {
    // Slider 10..120 → 1.0..12.0
    var scaled = num / 10;
    var valEl = document.getElementById("particle-size-val");
    if (valEl) valEl.textContent = scaled.toFixed(1);
    if (window.gpuParticles && window.gpuParticles.setParam) {
      window.gpuParticles.setParam("size", scaled);
    }
  } else if (param === "candleAttract") {
    // Slider 0..200 → 0..2.0
    var scaled = num / 100;
    var valEl = document.getElementById("candle-attract-val");
    if (valEl) valEl.textContent = scaled.toFixed(2);
    if (window.gpuParticles && window.gpuParticles.setParam) {
      window.gpuParticles.setParam("candleAttract", scaled);
    }
  }
}

// Toggle the attractor debug overlay on/off.
// When on, draws the exact attractor zones that the particle
// physics step uses — so you can verify alignment with candles.
function toggleAttractorDebug() {
  state.showAttractorDebug = !state.showAttractorDebug;
  setActive("btn-show-attractors", state.showAttractorDebug);
  drawFrame();
}

// Toggle a prediction model component on/off.
// name: "Light", "MA", "RSI", "Vol", "LSR"
function togglePred(name) {
  var key = "pred" + name;
  state[key] = !state[key];
  calibration = {};  // physics changed, reset calibration
  heatmapCache = {};  // force heatmap rebuild (V.Beams affects grid cloning path)
  sightLineCache = {};  // in case intensity weights changed
  cancelAnim();
  updateToolbar();
  drawFrame();
}

// Set VBeam intensity from slider (0..100 -> 0..1).
// Controls how strongly virtual candle beams paint into the
// light field. 0% = off, 100% = full intensity.
function setVBeamStr(pct) {
  state.predVBeamStr = pct / 100;
  var valEl = document.getElementById("vbeam-str-val");
  if (valEl) valEl.textContent = pct + "%";
  heatmapCache = {};
  calibration = {};
  cancelAnim();
  drawFrame();
}

// Set Color Bias Force from slider (0..100 -> 0..1).
// Controls how strongly the S/R color polarity pushes particles
// and corridor paths vertically. 0% = terrain only (no color
// influence). 100% = maximum directional push from light color.
function setColorBiasForce(pct) {
  state.colorBiasForce = pct / 100;
  var valEl = document.getElementById("color-bias-val");
  if (valEl) valEl.textContent = pct + "%";
  heatmapCache = {};
  cancelAnim();
  drawFrame();
}

// Toggle the contour overlay (visual verification of topology).
// Does NOT affect prediction — purely a rendering overlay.
function toggleContours() {
  state.showContours = !state.showContours;
  updateToolbar();
  drawFrame();
}

// Toggle greyscale topographic elevation fill.
function toggleContourFill() {
  state.contourFill = !state.contourFill;
  updateToolbar();
  drawFrame();
}

// Toggle corridor pathfinding visualization overlay
function toggleCorridorViz() {
  state.showCorridors = !state.showCorridors;
  updateToolbar();
  drawFrame();
}

// Toggle the silly cannon mode — little cannons fire cannonballs between candles
function toggleCannons() {
  state.showCannons = !state.showCannons;
  if (!state.showCannons && !state.showCannonZones && !state.predCannon) {
    // Clear cache only when ALL cannon features are off
    initCannonballs();
  }
  updateToolbar();
  drawFrame();
}

// Toggle cannon exhaustion zone bands (visual only, separate from signal)
function toggleCannonZones() {
  state.showCannonZones = !state.showCannonZones;
  updateToolbar();
  drawFrame();
}

// Toggle projection info text overlay (direction, target, accuracy, etc.)
function toggleProjInfo() {
  state.showProjInfo = !state.showProjInfo;
  updateToolbar();
  drawFrame();
}

// Set the intensity weighting mode (MA or RSI based).
function setIntensityMode(mode) {
  state.intensityMode = mode;
  heatmapCache   = {};
  sightLineCache = {};  // intensity weights affect sight line strengths
  cancelAnim();
  drawFrame();
}

// Toggle one of the three sight line layers on/off.
function toggleSL(which) {
  if (which === "base")  state.slShowBase  = !state.slShowBase;
  if (which === "rays")  state.slShowRays  = !state.slShowRays;
  if (which === "macro") state.slShowMacro = !state.slShowMacro;
  sightLineCache = {};
  cancelAnim();
  updateToolbar();
  drawFrame();
}

// Set the max angle tolerance for macro trend chaining.
function setMacroAngle(deg) {
  state.slMacroAngle = deg;
  var valEl = document.getElementById("macro-angle-val");
  if (valEl) valEl.textContent = deg + "°";
  sightLineCache = {};
  cancelAnim();
  drawFrame();
}

// Set how much line length amplifies brightness/thickness.
function setMomentum(pct) {
  state.slMomentum = pct / 100;
  var valEl = document.getElementById("momentum-val");
  if (valEl) valEl.textContent = pct + "%";
  cancelAnim();
  drawFrame();
}

// Cancel any running animation frame
function cancelAnim() {
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
}


// ================================================================
// TOOLBAR & LEGEND UI UPDATES
// ================================================================

function updateToolbar() {
  // Mode buttons
  setActive("btn-raycast",    state.mode === "raycast");
  setActive("btn-particle",   state.mode === "particle");
  setActive("btn-sightlines", state.mode === "sightlines");

  // Asset buttons
  setActive("btn-SOL", state.asset === "SOL" && !state.multiAsset);
  setActive("btn-ETH", state.asset === "ETH" && !state.multiAsset);
  setActive("btn-BTC", state.asset === "BTC" && !state.multiAsset);
  setActive("btn-overlay", state.multiAsset);

  // Candles toggle
  var candleBtn = document.getElementById("btn-candles");
  setActive("btn-candles", state.showCandles);
  candleBtn.textContent = state.showCandles ? "◼ Candles" : "◻ Candles";

  // Projection toggle
  var projBtn = document.getElementById("btn-projection");
  if (projBtn) {
    setActive("btn-projection", state.showProjection);
    projBtn.textContent = state.showProjection ? "◉ Projection" : "◎ Projection";
  }

  // Indicator overlay toggles
  setActive("btn-show-ma",  state.showMA);
  setActive("btn-show-rsi", state.showRSI);
  setActive("btn-show-lsr", state.showLSR);

  // Color force controls (only when projection is on)
  var cfBar = document.getElementById("color-force-bar");
  if (cfBar) {
    cfBar.style.display = state.showProjection ? "flex" : "none";
  }

  // Particle physics controls (only in wind tunnel mode)
  var particleBar = document.getElementById("particle-controls-bar");
  if (particleBar) {
    particleBar.style.display = (state.mode === "particle") ? "flex" : "none";
  }

  // Prediction model toggles (only when projection is on)
  var predBar = document.getElementById("pred-model-bar");
  if (predBar) {
    predBar.style.display = state.showProjection ? "flex" : "none";
  }
  var predDisplayBar = document.getElementById("pred-display-bar");
  if (predDisplayBar) {
    predDisplayBar.style.display = state.showProjection ? "flex" : "none";
  }
  setActive("btn-pred-light", state.predLight);
  setActive("btn-pred-ma",    state.predMA);
  setActive("btn-pred-rsi",   state.predRSI);
  setActive("btn-pred-vol",   state.predVol);
  setActive("btn-pred-lsr",   state.predLSR);
  setActive("btn-pred-calib",   state.predCalib);
  setActive("btn-pred-vbeam",   state.predVBeam);
  // Show/hide VBeam intensity slider based on toggle state
  var vbeamStrGroup = document.getElementById("vbeam-str-group");
  if (vbeamStrGroup) {
    vbeamStrGroup.style.display = state.predVBeam ? "flex" : "none";
  }
  setActive("btn-pred-topo",    state.predTopo);
  setActive("btn-pred-corridor", state.predCorridor);
  setActive("btn-pred-cannon",   state.predCannon);
  setActive("btn-pred-intrev",   state.predIntRev);
  setActive("btn-pred-minstep",  state.predMinStep);

  // Contours button (visible whenever projection bar is shown)
  var contoursBtn = document.getElementById("btn-contours");
  if (contoursBtn) {
    setActive("btn-contours", state.showContours);
    contoursBtn.textContent = state.showContours ? "◉ Contours" : "◎ Contours";
  }
  var fillBtn = document.getElementById("btn-contour-fill");
  if (fillBtn) {
    setActive("btn-contour-fill", state.contourFill);
    fillBtn.textContent = state.contourFill ? "▣ Topo Fill" : "▦ Topo Fill";
  }
  var corrVizBtn = document.getElementById("btn-corridors");
  if (corrVizBtn) {
    setActive("btn-corridors", state.showCorridors);
  }
  var cannonBtn = document.getElementById("btn-cannons");
  if (cannonBtn) {
    setActive("btn-cannons", state.showCannons);
    cannonBtn.textContent = state.showCannons ? "💣 Cannons" : "💣 Cannons";
  }
  var projInfoBtn = document.getElementById("btn-proj-info");
  if (projInfoBtn) {
    setActive("btn-proj-info", state.showProjInfo);
  }
  var cannonZoneBtn = document.getElementById("btn-cannon-zones");
  if (cannonZoneBtn) {
    setActive("btn-cannon-zones", state.showCannonZones);
  }

  // Show/hide raycast-specific controls (only in raycast mode)
  var isRaycast = state.mode === "raycast";
  var resGroup = document.getElementById("res-group");
  resGroup.style.display = isRaycast ? "flex" : "none";
  var transGroup = document.getElementById("translucency-group");
  transGroup.style.display = isRaycast ? "flex" : "none";
  var beamLenGroup = document.getElementById("beam-len-group");
  beamLenGroup.style.display = isRaycast ? "flex" : "none";
  // Rays Only toggle (only in raycast mode)
  var raysOnlyBtn = document.getElementById("btn-rays-only");
  if (raysOnlyBtn) {
    raysOnlyBtn.style.display = isRaycast ? "inline-block" : "none";
    setActive("btn-rays-only", state.raysOnly);
    raysOnlyBtn.textContent = state.raysOnly ? "◉ Rays Only" : "◎ Rays Only";
  }
  // Beam spread slider (only in raycast mode)
  var spreadGroup = document.getElementById("beam-spread-group");
  if (spreadGroup) {
    spreadGroup.style.display = isRaycast ? "flex" : "none";
  }
  var intGroup = document.getElementById("intensity-group");
  intGroup.style.display = "flex";  // visible in all modes

  // Show/hide sight line toggles (only in sightlines mode)
  var isSL = state.mode === "sightlines";
  var slToggles = document.getElementById("sl-toggles");
  slToggles.style.display = isSL ? "flex" : "none";
  if (isSL) {
    setActive("btn-sl-base",  state.slShowBase);
    setActive("btn-sl-rays",  state.slShowRays);
    setActive("btn-sl-macro", state.slShowMacro);
  }

  // Animation play button
  var playBtn = document.getElementById("btn-play");
  if (playBtn) {
    setActive("btn-play", state.animating);
    playBtn.textContent = state.animating ? "⏸ Pause" : "▶ Play";
  }
}

function updateLegend() {
  var legend = document.getElementById("legend");
  var html = "";

  if (state.mode === "raycast") {
    html += '<span style="color:#1edc5a">■ Green = from highs (strong resistance)</span>';
    html += '<span style="color:#f0c828">■ Yellow = from highs (weak resistance)</span>';
    html += '<span style="color:#288cff">■ Blue = from lows (weak support)</span>';
    html += '<span style="color:#f03232">■ Red = from lows (strong support)</span>';
    if (state.raysOnly) {
      html += "<span>⤳ RAYS ONLY: base connections hidden</span>";
    }
  } else if (state.mode === "sightlines") {
    html += '<span style="color:#ff9040">— Warm = H↔H resistance</span>';
    html += '<span style="color:#00c880">— Cool = L↔L support</span>';
    html += "<span>Highs connect to highs • lows connect to lows</span>";
  } else {
    html += "<span>→ Particles flow forward through the pressure terrain</span>";
    html += "<span>Ridges deflect • valleys channel • momentum crests hills</span>";
    html += '<span style="color:#00d4ff">■ Cool = valley (low pressure)</span>';
    html += '<span style="color:#ff8020">■ Warm = ridge (S/R zone)</span>';
  }

  if (state.multiAsset) {
    html += '<span class="legend-multi">⊕ Multi-asset: mcap-weighted gravitational coupling active</span>';
  }

  legend.innerHTML = html;
}

// ================================================================
// SYNC UI TO STATE ON LOAD
// ================================================================
// Called once at startup to push all state values into the HTML
// controls (sliders, dropdowns, labels). State in config.js is
// the single source of truth — this ensures the UI matches.

function syncUIToState() {
  // Opacity (state 0..1, slider 0..100)
  var opSlider = document.getElementById("translucency-slider");
  if (opSlider) opSlider.value = Math.round(state.translucency * 100);
  var opVal = document.getElementById("translucency-val");
  if (opVal) opVal.textContent = Math.round(state.translucency * 100) + "%";

  // Length→Glow (state 0..1, slider 0..100)
  var lgSlider = document.getElementById("beam-len-slider");
  if (lgSlider) lgSlider.value = Math.round(state.beamLenBoost * 100);
  var lgVal = document.getElementById("beam-len-val");
  if (lgVal) lgVal.textContent = Math.round(state.beamLenBoost * 100) + "%";

  // Beam spread (degrees)
  var spSlider = document.getElementById("beam-spread-slider");
  if (spSlider) spSlider.value = state.beamSpread;
  var spVal = document.getElementById("beam-spread-val");
  if (spVal) spVal.textContent = state.beamSpread + "°";

  // Resolution
  var resSlider = document.getElementById("res-slider");
  if (resSlider) resSlider.value = state.heatmapRes;

  // Animation speed
  var speedSlider = document.getElementById("speed-slider");
  if (speedSlider) speedSlider.value = state.animSpeed;
  var speedVal = document.getElementById("speed-val");
  if (speedVal) speedVal.textContent = state.animSpeed + "/s";

  // Intensity mode dropdown
  var intSelect = document.getElementById("intensity-select");
  if (intSelect) intSelect.value = state.intensityMode;

  // Sight line sliders
  var macroSlider = document.getElementById("macro-angle-slider");
  if (macroSlider) macroSlider.value = state.slMacroAngle;
  var macroVal = document.getElementById("macro-angle-val");
  if (macroVal) macroVal.textContent = state.slMacroAngle + "°";

  var momSlider = document.getElementById("momentum-slider");
  if (momSlider) momSlider.value = Math.round(state.slMomentum * 100);
  var momVal = document.getElementById("momentum-val");
  if (momVal) momVal.textContent = Math.round(state.slMomentum * 100) + "%";

  // Color force sliders + direction dropdowns
  var colors = ["green", "yellow", "blue", "red"];
  for (var i = 0; i < colors.length; i++) {
    var c = colors[i];
    var cf = state.colorForce[c];
    var dirEl = document.getElementById("cf-" + c + "-dir");
    if (dirEl) dirEl.value = String(cf.dir);
    var strEl = document.getElementById("cf-" + c + "-str");
    if (strEl) strEl.value = Math.round(cf.str * 100);
    var valEl = document.getElementById("cf-" + c + "-val");
    if (valEl) valEl.textContent = cf.str.toFixed(1);
  }

  // VBeam intensity slider (state 0..1, slider 0..100)
  var vbSlider = document.getElementById("vbeam-str-slider");
  if (vbSlider) vbSlider.value = Math.round(state.predVBeamStr * 100);
  var vbVal = document.getElementById("vbeam-str-val");
  if (vbVal) vbVal.textContent = Math.round(state.predVBeamStr * 100) + "%";

  // Color Bias Force slider (state 0..1, slider 0..100)
  var cbSlider = document.getElementById("color-bias-slider");
  if (cbSlider) cbSlider.value = Math.round(state.colorBiasForce * 100);
  var cbVal = document.getElementById("color-bias-val");
  if (cbVal) cbVal.textContent = Math.round(state.colorBiasForce * 100) + "%";

  // Let updateToolbar() handle all button active states
  updateToolbar();
}


// Helper: add or remove the "active" class on a button
function setActive(elementId, isActive) {
  var el = document.getElementById(elementId);
  if (!el) return;
  if (isActive) {
    el.classList.add("active");
  } else {
    el.classList.remove("active");
  }
}


// ================================================================
// ZOOM INDICATOR
// ================================================================
// Shows/hides the toolbar zoom level indicator. Called from drawFrame
// and from the zoom/pan event handlers so the UI stays in sync.

function updateZoomIndicator() {
  var el = document.getElementById("zoom-indicator");
  var levelEl = document.getElementById("zoom-level");
  if (!el) return;

  var home = (typeof getHomeOffset === "function") ? getHomeOffset() : { x: 0, y: 0 };
  var isAtHome = state.viewScale === 1.0
              && Math.abs(state.viewOffsetX - home.x) < 1
              && Math.abs(state.viewOffsetY - home.y) < 1;

  el.style.display = isAtHome ? "none" : "";
  if (!isAtHome && levelEl) {
    levelEl.textContent = state.viewScale.toFixed(1) + "×";
  }
}

// ================================================================
// NEW: Data source UI handler
// ================================================================
function onDataSourceChange() {
  const src = document.getElementById("data-source-select").value;
  const yahooArea = document.getElementById("yahoo-ticker-area");
  
  if (src === "yahoo") {
    yahooArea.style.display = "flex";
    // Disable multi-asset for stocks (only one ticker at a time)
    if (state.multiAsset) toggleOverlay();
  } else {
    yahooArea.style.display = "none";
  }
  
  // Clear old data when source changes
  candleData = {};
  heatmapCache = {};
  sightLineCache = {};
  particles = {};
}

function loadCustomTicker() {
  // Called by the Load button or Enter key
  fetchLiveRouter();
}
