/*
 * gpu-particles.js  —  10K Particle System (WebGL2 Point Sprites)
 *
 * 10,000 particles with CPU physics and WebGL2 GPU rendering.
 * Single draw call for all particles. Topology terrain forces,
 * density repulsion, left-edge flow recycling.
 *
 * API (window.gpuParticles):
 *   .init(containerEl)      — creates overlay canvas + WebGL2
 *   .updateTopology(data)   — upload topology intensity grid
 *   .updateDims(dims)       — update chart area coordinates
 *   .setParam(name, value)  — tune physics from UI sliders
 *   .getParam(name)         — read current param value
 *   .render(view)           — physics + render one frame
 *   .setVisible(bool)       — show/hide overlay
 *   .ready                  — true when init complete
 */

var PARTICLE_COUNT = 10000;
var MAX_TOPO_CELLS = 350000;

var _params = {
  repulsion:    0.35,
  size:         6.0,
  candleAttract: 0.80,
};

// ---- Candle attractor data ----
// Updated each frame by main.js via updateCandles().
// Stores the Y-pixel positions of candle highs/lows so the physics
// step can pull particles toward the nearest candle's price range.
var _candleHighY = null;   // Float32Array of high Y coords (screen px)
var _candleLowY  = null;   // Float32Array of low Y coords (screen px)
var _candleCount = 0;      // number of candles with valid data
var _candleSlotW = 0;      // pixel width of one candle slot

// ---- WebGL2 Shaders ----

var VERT_SRC = [
  '#version 300 es',
  'precision highp float;',
  'in vec2 aPos;',
  'in vec4 aColor;',
  'in float aSize;',
  'uniform mat4 uProj;',
  'out vec4 vColor;',
  'void main() {',
  '  gl_Position = uProj * vec4(aPos, 0.0, 1.0);',
  '  gl_PointSize = aSize;',
  '  vColor = aColor;',
  '}',
].join('\n');

var FRAG_SRC = [
  '#version 300 es',
  'precision mediump float;',
  'in vec4 vColor;',
  'out vec4 fragColor;',
  'void main() {',
  '  vec2 pc = gl_PointCoord * 2.0 - 1.0;',
  '  float distSq = dot(pc, pc);',
  '  if (distSq > 1.0) discard;',
  '  float edge = 1.0 - distSq * 0.5;',
  '  fragColor = vec4(vColor.rgb, vColor.a * edge);',
  '}',
].join('\n');

// ---- Module State ----

var _state = {
  canvas: null, gl: null, program: null, vao: null,
  posBuf: null, colorBuf: null, sizeBuf: null,
  posArr: null, velArr: null, colorArr: null, sizeArr: null,
  topoArr: null, topoRes: 10, topoCols: 1, topoRows: 1,
  chartLeft: 0, chartTop: 0, chartW: 800, chartH: 600,
  worldW: 1600, worldH: 600,
  uProj: null, _densityGrid: null,
};

var _frameCount = 0;
var _ready = false;
var _particlesInitialized = false;

// ---- WebGL Helpers ----

function _compileShader(gl, type, src) {
  var s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('[gpu-particles] Shader:', gl.getShaderInfoLog(s));
    return null;
  }
  return s;
}

function _createProgram(gl, vs, fs) {
  var v = _compileShader(gl, gl.VERTEX_SHADER, vs);
  var f = _compileShader(gl, gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return null;
  var p = gl.createProgram();
  gl.attachShader(p, v); gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error('[gpu-particles] Link:', gl.getProgramInfoLog(p));
    return null;
  }
  return p;
}

// ---- Init ----

async function init(containerEl) {
  if (_ready || _state.canvas) return;
  try {
    var canvas = document.createElement('canvas');
    canvas.id = 'gpu-particle-canvas';
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:5;';
    containerEl.appendChild(canvas);
    _state.canvas = canvas;

    var dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;

    var gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false, antialias: false });
    if (!gl) { console.warn('[gpu-particles] No WebGL2'); return; }
    _state.gl = gl;

    var prog = _createProgram(gl, VERT_SRC, FRAG_SRC);
    if (!prog) return;
    _state.program = prog;
    _state.uProj = gl.getUniformLocation(prog, 'uProj');

    _state.posBuf   = gl.createBuffer();
    _state.colorBuf = gl.createBuffer();
    _state.sizeBuf  = gl.createBuffer();

    _state.posArr   = new Float32Array(PARTICLE_COUNT * 2);
    _state.velArr   = new Float32Array(PARTICLE_COUNT * 2);
    _state.colorArr = new Float32Array(PARTICLE_COUNT * 4);
    _state.sizeArr  = new Float32Array(PARTICLE_COUNT);
    _state.topoArr  = new Float32Array(MAX_TOPO_CELLS);

    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    var aPosLoc = gl.getAttribLocation(prog, 'aPos');
    gl.bindBuffer(gl.ARRAY_BUFFER, _state.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, PARTICLE_COUNT * 2 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aPosLoc);
    gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);

    var aColorLoc = gl.getAttribLocation(prog, 'aColor');
    gl.bindBuffer(gl.ARRAY_BUFFER, _state.colorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, PARTICLE_COUNT * 4 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aColorLoc);
    gl.vertexAttribPointer(aColorLoc, 4, gl.FLOAT, false, 0, 0);

    var aSizeLoc = gl.getAttribLocation(prog, 'aSize');
    gl.bindBuffer(gl.ARRAY_BUFFER, _state.sizeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, PARTICLE_COUNT * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aSizeLoc);
    gl.vertexAttribPointer(aSizeLoc, 1, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
    _state.vao = vao;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);  // additive
    gl.disable(gl.DEPTH_TEST);

    _ready = true;
    console.log('[gpu-particles] Ready: ' + PARTICLE_COUNT + ' particles (WebGL2 point sprites)');
  } catch (e) {
    console.warn('[gpu-particles] Init failed:', e);
  }
}

// ---- Particle Init ----

function _initParticles() {
  if (_state.chartH < 10) return false;
  var posArr = _state.posArr;
  var velArr = _state.velArr;
  for (var i = 0; i < PARTICLE_COUNT; i++) {
    var off = i * 2;
    posArr[off]     = _state.chartLeft + Math.random() * (_state.worldW - _state.chartLeft);
    posArr[off + 1] = _state.chartTop + Math.random() * _state.chartH;
    velArr[off]     = 0.6 + Math.random() * 2.0;
    velArr[off + 1] = (Math.random() - 0.5) * 0.5;
  }
  _particlesInitialized = true;
  console.log('[gpu-particles] Initialized ' + PARTICLE_COUNT + ' particles');
  return true;
}

// ---- CPU Physics ----

function _cpuPhysicsStep() {
  var posArr  = _state.posArr;
  var velArr  = _state.velArr;
  var topoArr = _state.topoArr;
  var chartLeft = _state.chartLeft;
  var chartTop  = _state.chartTop;
  var chartH    = _state.chartH;
  var worldW    = _state.worldW;
  var topoRes   = _state.topoRes;
  var topoCols  = _state.topoCols;
  var topoRows  = _state.topoRows;

  var FORWARD_PUSH = 0.40, STEER_FORCE = 0.30, HILL_BRAKE = 0.08;
  var DOWNHILL_BOOST = 0.10, DAMPING_X = 0.99, DAMPING_Y = 0.97;
  var TURBULENCE = 0.15, MIN_VX = 1.0, MAX_SPEED_SQ = 36.0, MAX_SPEED = 6.0;
  var REPULSE_CELL = 20, REPULSE_FORCE = _params.repulsion, REPULSE_THRESH = 3;

  var chartBot = chartTop + chartH;
  var worldRange = worldW - chartLeft;
  var invTopoRes = topoRes > 0 ? 1.0 / topoRes : 0;
  var invRepCell = 1.0 / REPULSE_CELL;

  // Pass 1: density grid
  var densityCols = ((worldRange * invRepCell) | 0) + 3;
  var densityRows = ((chartH * invRepCell) | 0) + 3;
  var densitySize = densityCols * densityRows;
  if (!_state._densityGrid || _state._densityGrid.length < densitySize) {
    _state._densityGrid = new Int32Array(densitySize);
  }
  var density = _state._densityGrid;
  density.fill(0);

  for (var i = 0; i < PARTICLE_COUNT; i++) {
    var off = i * 2;
    var cx = ((posArr[off] - chartLeft) * invRepCell) | 0;
    var cy = ((posArr[off + 1] - chartTop) * invRepCell) | 0;
    if (cx >= 0 && cx < densityCols && cy >= 0 && cy < densityRows) {
      density[cy * densityCols + cx]++;
    }
  }

  // Pass 2: forces
  var rngState = (_frameCount * 2654435761) | 0;

  for (var i = 0; i < PARTICLE_COUNT; i++) {
    var off = i * 2;
    var px = posArr[off], py = posArr[off + 1];
    var vx = velArr[off], vy = velArr[off + 1];

    // Xorshift PRNG
    rngState ^= rngState << 13; rngState ^= rngState >> 17; rngState ^= rngState << 5;
    var randX = (rngState & 0xFFFF) * 0.0000152587890625 - 0.5;
    rngState ^= rngState << 13; rngState ^= rngState >> 17; rngState ^= rngState << 5;
    var randY = (rngState & 0xFFFF) * 0.0000152587890625 - 0.5;

    // Boundary recycling — respawn at left edge for wind tunnel flow
    // Right/left margins: generous so particles fully exit before respawn.
    // Top/bottom: tight (0px) since the post-integration check below
    // handles the exact-edge case. This catches particles that spawn
    // out of bounds or get nudged past the edge by forces.
    if (px > worldW + 10 || px < chartLeft - 40 ||
        py < chartTop || py > chartBot) {
      px = chartLeft + Math.random() * worldRange * 0.15;
      py = chartTop + Math.random() * chartH;
      vx = 0.6 + Math.random() * 2.0;
      vy = (Math.random() - 0.5) * 0.8;
    }

    var fx = FORWARD_PUSH, fy = 0.0;

    // Topology forces
    if (invTopoRes > 0 && topoCols > 0) {
      var gx = ((px - chartLeft) * invTopoRes) | 0;
      var gy = ((py - chartTop) * invTopoRes) | 0;
      if (gx >= 1 && gx < topoCols - 1 && gy >= 1 && gy < topoRows - 1) {
        var ci = gy * topoCols + gx;
        var center = topoArr[ci];
        var gradX = (topoArr[ci + 1] - topoArr[ci - 1]) * 0.5;
        var gradY = (topoArr[ci + topoCols] - topoArr[ci - topoCols]) * 0.5;

        fy += -gradY * STEER_FORCE;
        if (gradX > 0) {
          var brake = gradX * HILL_BRAKE;
          fx -= brake < vx * 0.10 ? brake : vx * 0.10;
        } else {
          fx -= gradX * DOWNHILL_BOOST;
        }
        var gradMagSq = gradX * gradX + gradY * gradY;
        if (gradMagSq > 0.0001 && center > 0.0) {
          fy -= gradY / Math.sqrt(gradMagSq) * 0.40;
        }
        if (center < -0.01) fx += 0.08;
      }
    }

    // Density repulsion
    var cx = ((px - chartLeft) * invRepCell) | 0;
    var cy = ((py - chartTop) * invRepCell) | 0;
    if (cx >= 1 && cx < densityCols - 1 && cy >= 1 && cy < densityRows - 1) {
      var di = cy * densityCols + cx;
      var here = density[di];
      if (here > REPULSE_THRESH) {
        var dgx = (density[di + 1] - density[di - 1]) * 0.5;
        var dgy = (density[di + densityCols] - density[di - densityCols]) * 0.5;
        var dgMagSq = dgx * dgx + dgy * dgy;
        if (dgMagSq > 0.01) {
          var crowding = (here - REPULSE_THRESH) * 0.05;
          if (crowding > 1) crowding = 1;
          var invDgMag = 1.0 / Math.sqrt(dgMagSq);
          fx -= dgx * invDgMag * REPULSE_FORCE * crowding;
          fy -= dgy * invDgMag * REPULSE_FORCE * crowding;
        }
      }
    }

    // ---- Candle vertical attraction ----
    // Each candle creates a vertical "gravity well". Particles are
    // pulled toward the nearest candle's high-low range. Outside the
    // range, force scales with sqrt(distance) so distant particles
    // still feel meaningful pull without close ones being overpowered.
    // Inside the candle's range: no force (free flow zone).
    if (_candleHighY && _candleCount > 0 && _candleSlotW > 0
        && _params.candleAttract > 0) {
      // Which candle slot is this particle in?
      var ci = Math.floor((px - chartLeft) / _candleSlotW);
      if (ci >= 0 && ci < _candleCount) {
        var hY = _candleHighY[ci];  // high price Y (small = higher on screen)
        var lY = _candleLowY[ci];   // low price Y  (large = lower on screen)

        // sqrt(dist) * scale: ~0.13 at 10px, ~0.28 at 50px, ~0.57 at 200px
        var pullBase = 0.04 * _params.candleAttract;
        var pullCap  = 1.2;

        if (py < hY) {
          // Above the candle high — pull down toward it
          var pull = Math.sqrt(hY - py) * pullBase;
          if (pull > pullCap) pull = pullCap;
          fy += pull;
        } else if (py > lY) {
          // Below the candle low — pull up toward it
          var pull = Math.sqrt(py - lY) * pullBase;
          if (pull > pullCap) pull = pullCap;
          fy -= pull;
        }
        // Between hY and lY: no force (free flow zone)
      }
    }

    // Turbulence
    fx += randX * TURBULENCE * 0.5;
    fy += randY * TURBULENCE;

    // Integrate
    vx = (vx + fx) * DAMPING_X;
    vy = (vy + fy) * DAMPING_Y;
    if (vx < MIN_VX) vx = MIN_VX;
    var speedSq = vx * vx + vy * vy;
    if (speedSq > MAX_SPEED_SQ) {
      var scale = MAX_SPEED / Math.sqrt(speedSq);
      vx *= scale; vy *= scale;
    }
    px += vx; py += vy;

    // Top/bottom edge: recycle to left edge instead of clamping.
    // Clamping causes particles to cluster along the boundary.
    // Recycling keeps the flow clean and avoids edge buildup.
    if (py < chartTop || py > chartBot) {
      px = chartLeft + Math.random() * worldRange * 0.15;
      py = chartTop + Math.random() * chartH;
      vx = 0.6 + Math.random() * 2.0;
      vy = (Math.random() - 0.5) * 0.8;
    }

    posArr[off] = px; posArr[off + 1] = py;
    velArr[off] = vx; velArr[off + 1] = vy;
  }
}

// ---- Compute Visuals ----

function _computeVisuals() {
  var posArr = _state.posArr, velArr = _state.velArr;
  var colorArr = _state.colorArr, sizeArr = _state.sizeArr;
  var topoArr = _state.topoArr, topoRes = _state.topoRes;
  var topoCols = _state.topoCols, topoRows = _state.topoRows;
  var chartLeft = _state.chartLeft, chartTop = _state.chartTop;
  var invTopoRes = topoRes > 0 ? 1.0 / topoRes : 0;
  var sizeScale = _params.size;

  for (var i = 0; i < PARTICLE_COUNT; i++) {
    var i2 = i * 2, i4 = i * 4;
    var vx = velArr[i2], vy = velArr[i2 + 1];

    var dirFactor = vy / 2.5;
    if (dirFactor > 1) dirFactor = 1;
    if (dirFactor < -1) dirFactor = -1;
    var dirStr = dirFactor < 0 ? -dirFactor : dirFactor;
    dirStr *= dirStr;
    var isBear = dirFactor > 0 ? 1 : 0;

    var r = 0.75 * (1 - dirStr) + (0.10 * (1 - isBear) + 1.00 * isBear) * dirStr;
    var g = 0.85 * (1 - dirStr) + (0.95 * (1 - isBear) + 0.40 * isBear) * dirStr;
    var b = 1.00 * (1 - dirStr) + (0.70 * (1 - isBear) + 0.15 * isBear) * dirStr;

    var pressure = 0;
    if (invTopoRes > 0) {
      var gx = ((posArr[i2] - chartLeft) * invTopoRes) | 0;
      var gy = ((posArr[i2 + 1] - chartTop) * invTopoRes) | 0;
      if (gx >= 0 && gx < topoCols && gy >= 0 && gy < topoRows) {
        pressure = Math.abs(topoArr[gy * topoCols + gx]) * 4;
        if (pressure > 1) pressure = 1;
      }
    }
    var bright = 0.4 + pressure * 0.6;
    r *= bright; g *= bright; b *= bright;

    var speedSq = vx * vx + vy * vy;
    var speedF = speedSq * 0.09;
    if (speedF > 1) speedF = 1;

    colorArr[i4] = r; colorArr[i4+1] = g; colorArr[i4+2] = b;
    colorArr[i4+3] = 0.3 + speedF * 0.3 + pressure * 0.2;
    sizeArr[i] = (1.0 + speedF * 0.3 + pressure * 1.0) * (sizeScale / 6.0) * 2.0;
  }
}

// ---- WebGL2 Render ----

function _renderGL(viewScale, viewOffsetX, viewOffsetY, screenW, screenH) {
  var gl = _state.gl, canvas = _state.canvas;
  var dpr = window.devicePixelRatio || 1;
  var bw = (canvas.clientWidth * dpr) | 0;
  var bh = (canvas.clientHeight * dpr) | 0;
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw; canvas.height = bh;
  }
  gl.viewport(0, 0, bw, bh);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(_state.program);

  var sx = 2.0 * viewScale / screenW;
  var sy = -2.0 * viewScale / screenH;
  var tx = 2.0 * viewOffsetX / screenW - 1.0;
  var ty = -(2.0 * viewOffsetY / screenH - 1.0);
  gl.uniformMatrix4fv(_state.uProj, false, new Float32Array([
    sx, 0, 0, 0,  0, sy, 0, 0,  0, 0, 1, 0,  tx, ty, 0, 1
  ]));

  gl.bindBuffer(gl.ARRAY_BUFFER, _state.posBuf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, _state.posArr);
  gl.bindBuffer(gl.ARRAY_BUFFER, _state.colorBuf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, _state.colorArr);
  gl.bindBuffer(gl.ARRAY_BUFFER, _state.sizeBuf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, _state.sizeArr);

  gl.bindVertexArray(_state.vao);
  gl.drawArrays(gl.POINTS, 0, PARTICLE_COUNT);
  gl.bindVertexArray(null);
}

// ---- Public API ----

function updateTopology(intensityArray, cols, rows, heatmapRes) {
  if (!_ready) return;
  var dst = _state.topoArr;
  var n = Math.min(intensityArray.length, MAX_TOPO_CELLS);
  for (var i = 0; i < n; i++) dst[i] = intensityArray[i];
  _state.topoRes = heatmapRes;
  _state.topoCols = cols;
  _state.topoRows = rows;
}

function updateDims(chartLeft, chartTop, chartW, chartH, worldW, worldH) {
  if (!_ready) return;
  _state.chartLeft = chartLeft; _state.chartTop = chartTop;
  _state.chartW = chartW; _state.chartH = chartH;
  _state.worldW = worldW; _state.worldH = worldH;
  if (!_particlesInitialized && chartH > 10) _initParticles();
}

function setParam(param, value) {
  if (param === "repulsion") _params.repulsion = value;
  else if (param === "size") _params.size = value;
  else if (param === "candleAttract") _params.candleAttract = value;
}

function getParam(param) { return _params[param]; }

function render(viewScale, viewOffsetX, viewOffsetY, screenW, screenH) {
  if (!_ready) return;
  _frameCount++;
  if (!_particlesInitialized) { _initParticles(); if (!_particlesInitialized) return; }
  _cpuPhysicsStep();
  _computeVisuals();
  _renderGL(viewScale, viewOffsetX, viewOffsetY, screenW, screenH);
}

function setVisible(v) { if (_state.canvas) _state.canvas.style.display = v ? 'block' : 'none'; }
function resize(w, h) {}

// ---- Export ----

window.gpuParticles = {
  init: init, updateTopology: updateTopology, updateDims: updateDims,

  // Receive candle Y-pixel arrays from main.js each frame.
  // highYArr/lowYArr: Float32Arrays of screen-pixel Y positions.
  // count: number of candles, slotW: pixel width of one candle slot.
  updateCandles: function(highYArr, lowYArr, count, slotW) {
    _candleHighY = highYArr;
    _candleLowY  = lowYArr;
    _candleCount = count;
    _candleSlotW = slotW;
  },

  // Return the exact attractor data the physics step uses so
  // the debug overlay can draw from the particle system's POV.
  getCandleDebugData: function() {
    return {
      highY: _candleHighY,
      lowY:  _candleLowY,
      count: _candleCount,
      slotW: _candleSlotW
    };
  },

  setParam: setParam, getParam: getParam,
  render: render, setVisible: setVisible, resize: resize,
  get ready() { return _ready; },
  PARTICLE_COUNT: PARTICLE_COUNT,
};

(async function() {
  var c = document.getElementById("canvas-wrap");
  if (!c) return;
  try {
    await init(c);
    if (_ready) console.log("[gpu-particles] Auto-init OK: " + PARTICLE_COUNT + " particles");
  } catch (e) { console.warn("[gpu-particles] Auto-init failed:", e); }
})();
