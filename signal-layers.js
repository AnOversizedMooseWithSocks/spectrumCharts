/*
 * ================================================================
 * signal-layers.js  —  Layered Signal Processing Pipeline
 * ================================================================
 * Depends on: config.js (CONFIG, state)
 *
 * Provides the same API as the original brain.js-based version
 * but uses simple weighted-sum heuristics instead of neural nets.
 * All function signatures and return values are identical, so
 * projection.js needs zero changes.
 *
 * ARCHITECTURE:
 *   3 domain specialists (terrain, indicator, energy) each produce
 *   a direction signal from their domain's inputs using adaptive
 *   weights learned from training data. A meta layer averages
 *   the specialist outputs weighted by their live accuracy.
 *
 * ================================================================
 */


// ================================================================
// STATE — same globals as the original version
// ================================================================

// Per-layer accuracy tracking (EMA, blame-attributed)
var slLayerAccuracy = {
  terrain:   { dirCorrect: 0.5, sampleCount: 0 },
  indicator: { dirCorrect: 0.5, sampleCount: 0 },
  energy:    { dirCorrect: 0.5, sampleCount: 0 },
  structure: { dirCorrect: 0.5, sampleCount: 0 },
  dynamics:  { dirCorrect: 0.5, sampleCount: 0 },
  meta:      { dirCorrect: 0.5, sampleCount: 0 },
};

// Snapshot of live accuracy for UI display
var slStats = {
  terrainLive:   0.5,
  indicatorLive: 0.5,
  energyLive:    0.5,
  structureLive: 0.5,
  dynamicsLive:  0.5,
  metaLive:      0.5,
};

// Pipeline readiness flag — set true after first training pass
var slReady     = false;
var slCacheKey  = "";

// Learned weights from training data (per-signal accuracy correlations)
var slWeights = {
  light: 0.5, topo: 0.5,      // terrain specialist
  ma: 0.5, rsi: 0.5,          // indicator specialist
  mom: 0.5, vol: 0.5, bp: 0.5 // energy specialist
};

// Backward-compat globals (legacy neural-calibrate.js interface)
var neuralNetReady  = false;
var neuralNetStats  = { samples: 0, accuracy: 0, lightAccuracy: 0, energyAccuracy: 0, trainTime: 0, error: 0, iterations: 0 };
var neuralMaxLight  = 1;
var neuralAvgBody   = 1;
var neuralAvgVolume = 1;
var neuralCacheKey  = "";


// ================================================================
// FEATURE EXTRACTORS (unchanged from original)
// ================================================================
// Rescales raw terrain signals from -1..+1 to 0..1 range.

function extractTerrainFeatures(signals) {
  return {
    light:     (signals.lightSig + 1) * 0.5,
    topo:      (signals.topoSig + 1) * 0.5,
    intensity: signals.lightIntensity || 0
  };
}

function extractIndicatorFeatures(signals) {
  return {
    ma:         (signals.maSig + 1) * 0.5,
    rsi:        (signals.rsiSig + 1) * 0.5,
    maGap:      signals.maGapRanges || 0,
    rsiValue:   (signals.rsiValue !== undefined ? signals.rsiValue : 50) / 100
  };
}

function extractEnergyFeatures_SL(signals) {
  return {
    mom:        (signals.momSig + 1) * 0.5,
    volume:     Math.min(1, (signals.volumeRatio || 0) / 3.0),
    buyP:       Math.max(0, Math.min(1, signals.buyPressure || 0.5)),
    bodySize:   Math.min(1, (signals.bodySize || 0) / 3.0)
  };
}


// ================================================================
// TRAIN — Learn signal weights from historical data
// ================================================================
// Computes per-signal correlation with the actual outcome.
// Signals that correctly predict direction get higher weight.

function trainSignalLayers(samples, assetKey) {

  // ---- Cache check ----
  var cacheKey = assetKey + "_sl_" + samples.length;
  if (samples.length > 0) {
    var first = samples[0];
    var last = samples[samples.length - 1];
    cacheKey += "_" + first.lightSig.toFixed(3) + "_" + last.momSig.toFixed(3);
  }
  if (cacheKey === slCacheKey && slReady) {
    return true;
  }
  if (state.animating && slReady) {
    return true;
  }

  if (!samples || samples.length < 15) {
    slReady = false;
    return false;
  }

  var t0 = performance.now();
  var n = samples.length;

  // ---- Compute per-signal accuracy ----
  // For each signal, count how often its sign matches the label direction.
  // label: { up: 1, down: 0, flat: 0 } means price went up (bullish).
  // Signal convention: negative = bullish push, positive = bearish push.

  var correct = { light: 0, topo: 0, ma: 0, rsi: 0, mom: 0, vol: 0, bp: 0 };
  var total   = 0;

  for (var i = 0; i < n; i++) {
    var s = samples[i];
    // Actual direction: +1 = bearish (down), -1 = bullish (up)
    var actualDir = 0;
    if (s.label.down > s.label.up)  actualDir = 1;
    if (s.label.up > s.label.down)  actualDir = -1;
    if (actualDir === 0) continue;

    total++;

    // Each signal is -1..+1. Same sign as actualDir = correct.
    if (s.lightSig * actualDir > 0) correct.light++;
    if (s.topoSig * actualDir > 0) correct.topo++;
    if (s.maSig * actualDir > 0) correct.ma++;
    if (s.rsiSig * actualDir > 0) correct.rsi++;
    if (s.momSig * actualDir > 0) correct.mom++;

    // Volume: high volume + correct momentum = momentum is trustworthy
    var volHigh = (s.volumeRatio || 0) > 1.0;
    var momRight = (s.momSig * actualDir > 0);
    if (volHigh && momRight) correct.vol++;

    // Buy pressure: > 0.5 = bullish, < 0.5 = bearish
    var bpDir = ((s.buyPressure || 0.5) - 0.5) * -2;
    if (bpDir * actualDir > 0) correct.bp++;
  }

  // Convert to 0..1 accuracy (0.5 = random)
  if (total > 0) {
    slWeights.light = correct.light / total;
    slWeights.topo  = correct.topo / total;
    slWeights.ma    = correct.ma / total;
    slWeights.rsi   = correct.rsi / total;
    slWeights.mom   = correct.mom / total;
    slWeights.vol   = Math.min(1, correct.vol / (total * 0.5 + 1));
    slWeights.bp    = correct.bp / total;
  }

  slReady = true;
  slCacheKey = cacheKey;

  var elapsed = performance.now() - t0;

  // Update backward-compat stats
  neuralNetReady = true;
  neuralNetStats.samples = n;
  neuralNetStats.trainTime = elapsed;
  neuralNetStats.accuracy = (slWeights.light + slWeights.mom + slWeights.ma) / 3;

  return true;
}


// ================================================================
// QUERY — Get direction signal from raw inputs
// ================================================================
// Runs each specialist as a simple weighted sum of its domain
// signals, then combines with accuracy-based trust weights.

function querySignalLayers(signals, activeSpecialists) {
  var neutral = {
    signal: 0, confidence: 0, pipelineConfidence: 0,
    agreement: 0, completeness: 0,
    up: 0.33, down: 0.33, flat: 0.34,
    opinions: null
  };

  if (!slReady) return neutral;

  var active = activeSpecialists || { terrain: true, indicator: true, energy: true };
  var neutralOut = { up: 0.33, down: 0.33, flat: 0.34 };

  var activeCount = (active.terrain ? 1 : 0) + (active.indicator ? 1 : 0) + (active.energy ? 1 : 0);
  var completeness = activeCount / 3.0;

  // ---- Layer 1: Domain specialists (weighted sums) ----

  // Terrain: light and topo signals, weighted by accuracy
  var tOut = neutralOut;
  if (active.terrain) {
    var tSig = signals.lightSig * slWeights.light + signals.topoSig * slWeights.topo;
    tSig /= (slWeights.light + slWeights.topo + 0.001);
    tOut = signalToProbs(tSig);
  }

  // Indicator: MA and RSI signals
  var iOut = neutralOut;
  if (active.indicator) {
    var iSig = signals.maSig * slWeights.ma + signals.rsiSig * slWeights.rsi;
    iSig /= (slWeights.ma + slWeights.rsi + 0.001);
    iOut = signalToProbs(iSig);
  }

  // Energy: momentum + buy pressure, amplified by volume
  var eOut = neutralOut;
  if (active.energy) {
    var bpSig = ((signals.buyPressure || 0.5) - 0.5) * -2;
    var eSig = signals.momSig * slWeights.mom + bpSig * slWeights.bp;
    eSig /= (slWeights.mom + slWeights.bp + 0.001);
    var volAmp = 0.6 + Math.min(0.4, (signals.volumeRatio || 0) * 0.15);
    eSig *= volAmp;
    eOut = signalToProbs(eSig);
  }

  // ---- Meta: accuracy-weighted average of specialists ----
  var trust = getLayerTrustWeights();
  var metaSig = 0;
  var totalW  = 0;

  if (active.terrain) {
    metaSig += (tOut.down - tOut.up) * trust.terrain;
    totalW  += trust.terrain;
  }
  if (active.indicator) {
    metaSig += (iOut.down - iOut.up) * trust.indicator;
    totalW  += trust.indicator;
  }
  if (active.energy) {
    metaSig += (eOut.down - eOut.up) * trust.energy;
    totalW  += trust.energy;
  }

  if (totalW > 0.001) metaSig /= totalW;

  var metaOut = signalToProbs(metaSig);
  var pUp   = metaOut.up;
  var pDown = metaOut.down;
  var pFlat = metaOut.flat;
  var signal = pDown - pUp;

  var maxP = Math.max(pUp, pDown, pFlat);
  var confidence = (maxP - 0.333) / 0.667;
  if (confidence < 0) confidence = 0;

  // Structure and dynamics are synthetic averages for compat
  var sOut = { up: (tOut.up + iOut.up) / 2, down: (tOut.down + iOut.down) / 2, flat: (tOut.flat + iOut.flat) / 2 };
  var dOut = { up: (iOut.up + eOut.up) / 2, down: (iOut.down + eOut.down) / 2, flat: (iOut.flat + eOut.flat) / 2 };

  var opinions = {
    terrain:   slMakeOpinion(tOut),
    indicator: slMakeOpinion(iOut),
    energy:    slMakeOpinion(eOut),
    structure: slMakeOpinion(sOut),
    dynamics:  slMakeOpinion(dOut),
    meta:      { signal: signal, up: pUp, down: pDown, flat: pFlat }
  };

  // ---- Specialist agreement ----
  var tDirS = opinions.terrain.signal;
  var iDirS = opinions.indicator.signal;
  var eDirS = opinions.energy.signal;

  var bullVotes = (tDirS < -0.05 ? 1 : 0) + (iDirS < -0.05 ? 1 : 0) + (eDirS < -0.05 ? 1 : 0);
  var bearVotes = (tDirS > 0.05 ? 1 : 0) + (iDirS > 0.05 ? 1 : 0) + (eDirS > 0.05 ? 1 : 0);
  var maxVotes = Math.max(bullVotes, bearVotes);
  var agreement = maxVotes >= 2 ? (maxVotes - 1) / 2.0 : 0;

  var pipelineConfidence = confidence * (0.4 + agreement * 0.6);
  if (pipelineConfidence > 1) pipelineConfidence = 1;
  if (pipelineConfidence < 0) pipelineConfidence = 0;

  return {
    signal:              signal,
    confidence:          confidence,
    pipelineConfidence:  pipelineConfidence,
    agreement:           agreement,
    completeness:        completeness,
    up:                  pUp,
    down:                pDown,
    flat:                pFlat,
    opinions:            opinions
  };
}


// Convert a -1..+1 signal to { up, down, flat } pseudo-probabilities.
// Negative signal = bullish (up), positive = bearish (down).
function signalToProbs(sig) {
  if (sig > 1) sig = 1;
  if (sig < -1) sig = -1;

  var absSig = Math.abs(sig);
  var dirP   = 0.33 + absSig * 0.50;
  var flatP  = Math.max(0.05, 0.34 - absSig * 0.25);
  var otherP = 1.0 - dirP - flatP;

  if (sig > 0) {
    return { up: otherP, down: dirP, flat: flatP };
  } else {
    return { up: dirP, down: otherP, flat: flatP };
  }
}


// ================================================================
// BLAME-ATTRIBUTED SCORING — scoreLayerPrediction
// ================================================================
// Unchanged — no neural net dependency.

var SL_BLAME_ALPHA = 0.25;

function scoreLayerPrediction(opinions, actualDir) {
  if (!opinions) return;

  var layerNames = ["terrain", "indicator", "energy", "structure", "dynamics", "meta"];

  for (var li = 0; li < layerNames.length; li++) {
    var name = layerNames[li];
    var op = opinions[name];
    if (!op) continue;

    var layerDir = op.signal > 0.02 ? 1 : op.signal < -0.02 ? -1 : 0;
    var dirOk;
    if (layerDir === 0) {
      dirOk = 0.5;
    } else {
      dirOk = (layerDir === actualDir) ? 1.0 : 0.0;
    }

    var acc = slLayerAccuracy[name];
    if (acc.sampleCount === 0) {
      acc.dirCorrect = dirOk;
    } else {
      acc.dirCorrect = acc.dirCorrect * (1 - SL_BLAME_ALPHA) + dirOk * SL_BLAME_ALPHA;
    }
    acc.sampleCount++;
  }

  slStats.terrainLive   = slLayerAccuracy.terrain.dirCorrect;
  slStats.indicatorLive = slLayerAccuracy.indicator.dirCorrect;
  slStats.energyLive    = slLayerAccuracy.energy.dirCorrect;
  slStats.structureLive = slLayerAccuracy.structure.dirCorrect;
  slStats.dynamicsLive  = slLayerAccuracy.dynamics.dirCorrect;
  slStats.metaLive      = slLayerAccuracy.meta.dirCorrect;
}


// ================================================================
// LAYER TRUST WEIGHTS — getLayerTrustWeights
// ================================================================
// Unchanged — no neural net dependency.

function getLayerTrustWeights() {
  var MIN_SAMPLES = 5;
  var FLOOR = 0.2;

  var result = { terrain: 1.0, indicator: 1.0, energy: 1.0 };

  if (slLayerAccuracy.terrain.sampleCount < MIN_SAMPLES &&
      slLayerAccuracy.indicator.sampleCount < MIN_SAMPLES &&
      slLayerAccuracy.energy.sampleCount < MIN_SAMPLES) {
    return result;
  }

  var tAcc = slLayerAccuracy.terrain.dirCorrect;
  var iAcc = slLayerAccuracy.indicator.dirCorrect;
  var eAcc = slLayerAccuracy.energy.dirCorrect;

  result.terrain   = Math.max(FLOOR, tAcc * tAcc);
  result.indicator = Math.max(FLOOR, iAcc * iAcc);
  result.energy    = Math.max(FLOOR, eAcc * eAcc);

  var total = result.terrain + result.indicator + result.energy;
  if (total > 0.01) {
    result.terrain   /= total;
    result.indicator /= total;
    result.energy    /= total;
  }

  return result;
}


// ================================================================
// BACKWARD-COMPATIBLE WRAPPERS
// ================================================================

function extractLightShapeFeatures(env, maxLight) {
  var normLight = 0;
  if (maxLight > 0.01) {
    normLight = env.totalLight / maxLight;
    if (normLight > 1) normLight = 1;
  }
  var total = env.totalLight + 0.001;
  return {
    totalLight:   normLight,
    greenR:       env.green / total,
    yellowR:      env.yellow / total,
    blueR:        env.blue / total,
    redR:         env.red / total,
    resistAbove:  maxLight > 0.01 ? Math.min(1, env.resistAbove / maxLight) : 0,
    supportBelow: maxLight > 0.01 ? Math.min(1, env.supportBelow / maxLight) : 0
  };
}

function extractEnergyFeatures(volRatio, buyPressure, bodySize, momentum) {
  return {
    volume:      Math.min(1, volRatio / 3.0),
    buyPressure: Math.max(0, Math.min(1, buyPressure)),
    bodySize:    Math.min(1, bodySize / 3.0),
    momentum:    momentum
  };
}

// Legacy training wrapper
function trainNeuralFromLight(candles, sampleLightEnvFn,
                               dims, priceMin, priceMax, resolution, assetKey) {
  return slReady;
}

// Legacy query wrapper
function queryNeuralDirection(lightFeatures, energyFeatures) {
  var neutral = {
    signal: 0, confidence: 0,
    up: 0.33, down: 0.33, flat: 0.34,
    lightOpinion: 0, energyOpinion: 0
  };

  if (!slReady) return neutral;

  var result = querySignalLayers({
    lightSig: 0,
    topoSig: 0,
    corrSig: 0,
    corrClarity: 0,
    lightIntensity: lightFeatures.totalLight || 0,
    maSig: 0,
    rsiSig: 0,
    maGapRanges: 0,
    rsiValue: 50,
    lssaSig: 0,
    momSig: (energyFeatures.momentum - 0.5) * 2,
    volumeRatio: (energyFeatures.volume || 0) * 3.0,
    buyPressure: energyFeatures.buyPressure || 0.5,
    bodySize: (energyFeatures.bodySize || 0) * 3.0
  });

  return {
    signal:        result.signal,
    confidence:    result.confidence,
    up:            result.up,
    down:          result.down,
    flat:          result.flat,
    lightOpinion:  result.opinions ? result.opinions.terrain.signal : 0,
    energyOpinion: result.opinions ? result.opinions.energy.signal : 0
  };
}


// ================================================================
// HELPERS
// ================================================================

function slClassifyOutput(output) {
  if (output.up >= output.down && output.up >= output.flat) return "up";
  if (output.down >= output.up && output.down >= output.flat) return "down";
  return "flat";
}

function slMakeOpinion(rawOut) {
  var total = rawOut.up + rawOut.down + rawOut.flat;
  if (total < 0.001) {
    return { signal: 0, up: 0.33, down: 0.33, flat: 0.34 };
  }
  var pUp   = rawOut.up / total;
  var pDown = rawOut.down / total;
  var pFlat = rawOut.flat / total;
  return {
    signal: pDown - pUp,
    up:     pUp,
    down:   pDown,
    flat:   pFlat
  };
}
