/*
 * ================================================================
 * gl-particles-instanced.js  —  Point Sprites + Motion Blur
 * ================================================================
 * Depends on: config.js (CONFIG)
 *
 * ACCUMULATION BUFFER MOTION BLUR:
 *
 * Instead of clearing the framebuffer each frame, we:
 *   1. Draw a fullscreen fade quad that dims the previous frame
 *   2. Draw new point sprites at current positions (bright)
 *
 * Old positions persist and gradually fade out over several frames,
 * creating natural motion trails. Zero CPU cost — no trail history
 * buffers, no velocity lines, no instanced quads. Just one extra
 * fullscreen quad draw per frame.
 *
 * The fade alpha controls trail length:
 *   0.10 = long comet tails (~10 frames of persistence)
 *   0.20 = medium trails (~5 frames)
 *   0.35 = short trails (~3 frames)
 *
 * ================================================================
 */

var _glpInst = {
  ready:     false,
  gl:        null,
  canvas:    null,
  // Point sprite program
  progPts:   null,
  vaoPts:    null,
  instBuf:   null,
  instData:  null,
  capacity:  0,
  uPtsRes:   null,
  uPtsOff:   null,
  uPtsScale: null,
  // Fade quad program
  progFade:  null,
  vaoFade:   null,
  uFadeAlpha: null,
  // Canvas size
  lastW:     0,
  lastH:     0,
};

// Per-instance data: x, y, r, g, b, a, size = 7 floats
var INST_FLOATS = 7;

// Trail length: lower = longer tails. Range 0.05 (very long) to 0.5 (very short).
var MOTION_BLUR_FADE = 0.15;


// ================================================================
// SHADERS — Point Sprites (same as the proven working version)
// ================================================================

var _ptsVertSrc = [
  "#version 300 es",
  "precision highp float;",
  "layout(location = 0) in vec2 aPos;",
  "layout(location = 1) in vec4 aColor;",
  "layout(location = 2) in float aSize;",
  "uniform vec2 uRes;",
  "uniform vec2 uOff;",
  "uniform float uScale;",
  "out vec4 vColor;",
  "void main() {",
  "  vec2 sc = aPos * uScale + uOff;",
  "  vec2 cl = (sc / uRes) * 2.0 - 1.0;",
  "  cl.y = -cl.y;",
  "  gl_Position = vec4(cl, 0.0, 1.0);",
  "  gl_PointSize = aSize * uScale;",
  "  vColor = aColor;",
  "}",
].join("\n");

var _ptsFragSrc = [
  "#version 300 es",
  "precision highp float;",
  "in vec4 vColor;",
  "out vec4 fragColor;",
  "void main() {",
  "  vec2 pc = gl_PointCoord * 2.0 - 1.0;",
  "  float d = dot(pc, pc);",
  "  if (d > 1.0) discard;",
  "  float edge = 1.0 - smoothstep(0.5, 1.0, d);",
  "  fragColor = vec4(vColor.rgb, vColor.a * edge);",
  "}",
].join("\n");


// ================================================================
// SHADERS — Fullscreen Fade Quad
// ================================================================
// Covers the entire screen using gl_VertexID (no vertex buffer).
// Outputs black with configurable alpha. When blended with
// DST_COLOR mode, it darkens the existing framebuffer content.

var _fadeVertSrc = [
  "#version 300 es",
  "void main() {",
  "  // Fullscreen triangle from vertex ID (covers clip space)",
  "  float fx = float(gl_VertexID & 1) * 4.0 - 1.0;",
  "  float fy = float(gl_VertexID & 2) * 2.0 - 1.0;",
  "  gl_Position = vec4(fx, fy, 0.0, 1.0);",
  "}",
].join("\n");

var _fadeFragSrc = [
  "#version 300 es",
  "precision highp float;",
  "uniform float uAlpha;",
  "out vec4 fragColor;",
  "void main() {",
  "  fragColor = vec4(0.0, 0.0, 0.0, uAlpha);",
  "}",
].join("\n");


// ================================================================
// HELPER: compile + link a shader program
// ================================================================

function _buildProgram(gl, vsSrc, fsSrc, label) {
  var vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, vsSrc);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    console.warn("[gl-particles] " + label + " VS:", gl.getShaderInfoLog(vs));
    return null;
  }
  var fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, fsSrc);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    console.warn("[gl-particles] " + label + " FS:", gl.getShaderInfoLog(fs));
    return null;
  }
  var prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn("[gl-particles] " + label + " link:", gl.getProgramInfoLog(prog));
    return null;
  }
  return prog;
}


// ================================================================
// INITIALIZATION
// ================================================================

function initGLParticlesInstanced() {
  try {
    var c = document.createElement("canvas");
    var gl = c.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      // CRITICAL: preserve content between frames for accumulation
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      console.warn("[gl-particles] WebGL2 not available");
      return false;
    }

    // ---- Build point sprite program ----
    var progPts = _buildProgram(gl, _ptsVertSrc, _ptsFragSrc, "points");
    if (!progPts) return false;

    // ---- Build fade quad program ----
    var progFade = _buildProgram(gl, _fadeVertSrc, _fadeFragSrc, "fade");
    if (!progFade) return false;

    // ---- Point sprite VAO ----
    var vaoPts = gl.createVertexArray();
    gl.bindVertexArray(vaoPts);

    var instBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);

    var stride = INST_FLOATS * 4;  // 28 bytes

    // Attr 0: aPos (vec2) — offset 0
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(0, 1);

    // Attr 1: aColor (vec4) — offset 8
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(1, 1);

    // Attr 2: aSize (float) — offset 24
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 24);
    gl.vertexAttribDivisor(2, 1);

    gl.bindVertexArray(null);

    // ---- Fade quad VAO (no buffers — uses gl_VertexID) ----
    var vaoFade = gl.createVertexArray();
    // Empty VAO — the shader generates positions from gl_VertexID

    // ---- Store uniforms ----
    _glpInst.uPtsRes   = gl.getUniformLocation(progPts, "uRes");
    _glpInst.uPtsOff   = gl.getUniformLocation(progPts, "uOff");
    _glpInst.uPtsScale = gl.getUniformLocation(progPts, "uScale");
    _glpInst.uFadeAlpha = gl.getUniformLocation(progFade, "uAlpha");

    // ---- Store state ----
    _glpInst.gl       = gl;
    _glpInst.canvas   = c;
    _glpInst.progPts  = progPts;
    _glpInst.progFade = progFade;
    _glpInst.vaoPts   = vaoPts;
    _glpInst.vaoFade  = vaoFade;
    _glpInst.instBuf  = instBuf;
    _glpInst.capacity = 0;
    _glpInst.instData = null;
    _glpInst.ready    = true;

    // Start with a black canvas
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    console.log("[gl-particles] Motion-blur point-sprite renderer ready");
    return true;
  } catch (e) {
    console.warn("[gl-particles] Init failed:", e);
    return false;
  }
}


// ================================================================
// RENDER
// ================================================================
// Each frame:
//   1. Fade previous frame (dim old particle positions)
//   2. Draw new point sprites (bright at current positions)
//   3. Composite onto main 2D canvas

function renderParticlesInstanced(pool, ctx, mainCanvas, viewScale, viewOffsetX, viewOffsetY) {
  if (!_glpInst.ready) return false;

  var n = pool.count;
  if (n === 0) return true;

  var gl = _glpInst.gl;
  var c  = _glpInst.canvas;

  // Resize (clears accumulated trails — fine, they rebuild in a few frames)
  var w = mainCanvas.logicalWidth  || mainCanvas.clientWidth;
  var h = mainCanvas.logicalHeight || mainCanvas.clientHeight;
  if (w !== _glpInst.lastW || h !== _glpInst.lastH) {
    c.width  = w;
    c.height = h;
    gl.viewport(0, 0, w, h);
    _glpInst.lastW = w;
    _glpInst.lastH = h;
  }

  // Grow instance buffer if needed
  if (n > _glpInst.capacity) {
    var newCap = Math.ceil(n * 1.5);
    _glpInst.instData = new Float32Array(newCap * INST_FLOATS);
    _glpInst.capacity = newCap;
    gl.bindBuffer(gl.ARRAY_BUFFER, _glpInst.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, _glpInst.instData.byteLength, gl.DYNAMIC_DRAW);
  }

  var data = _glpInst.instData;

  // ---- Fill instance data from SoA arrays ----
  var ppx = pool.px, ppy = pool.py;
  var pvx = pool.vx, pvy = pool.vy;
  var pFade = pool.fade, pTopoI = pool.topoI;

  for (var i = 0; i < n; i++) {
    var off = i * INST_FLOATS;

    var ti = pTopoI[i];
    var t = ti * 3.0;
    if (t > 1.0) t = 1.0;
    t = t * t;

    var r = (200 + 55 * t) / 255;
    var g = (240 - 100 * t) / 255;
    var b = (255 - 215 * t) / 255;

    var vxi = pvx[i], vyi = pvy[i];
    var speed = Math.sqrt(vxi * vxi + vyi * vyi);
    var bright = speed * 0.5;
    if (bright > 1.0) bright = 1.0;
    var alpha = (0.7 + bright * 0.3) * pFade[i];
    var size = 2.8 + bright * 0.8;

    data[off]     = ppx[i];
    data[off + 1] = ppy[i];
    data[off + 2] = r;
    data[off + 3] = g;
    data[off + 4] = b;
    data[off + 5] = alpha;
    data[off + 6] = size;
  }

  // ================================================================
  // PASS 1: Fade previous frame
  // ================================================================
  // Draw a fullscreen black quad with alpha = MOTION_BLUR_FADE.
  // Blend: multiply existing framebuffer RGB by (1 - alpha).
  // This dims old particle positions so they gradually disappear.

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(
    gl.ZERO, gl.ONE_MINUS_SRC_ALPHA,   // RGB: dst * (1 - srcA)
    gl.ZERO, gl.ONE_MINUS_SRC_ALPHA    // A:   dst * (1 - srcA)
  );

  gl.useProgram(_glpInst.progFade);
  gl.uniform1f(_glpInst.uFadeAlpha, MOTION_BLUR_FADE);

  gl.bindVertexArray(_glpInst.vaoFade);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);

  // ================================================================
  // PASS 2: Draw new point sprites
  // ================================================================
  // Additive blend: new particles add brightness on top of the
  // faded trails. This gives a bright head with dimming tail.

  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);  // additive

  gl.useProgram(_glpInst.progPts);
  gl.uniform2f(_glpInst.uPtsRes, w, h);
  gl.uniform2f(_glpInst.uPtsOff, viewOffsetX || 0, viewOffsetY || 0);
  gl.uniform1f(_glpInst.uPtsScale, viewScale || 1.0);

  gl.bindBuffer(gl.ARRAY_BUFFER, _glpInst.instBuf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, n * INST_FLOATS));

  gl.bindVertexArray(_glpInst.vaoPts);
  gl.drawArraysInstanced(gl.POINTS, 0, 1, n);
  gl.bindVertexArray(null);

  // ================================================================
  // Composite onto main 2D canvas
  // ================================================================
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  var dpr = Math.max(2, window.devicePixelRatio || 1);
  ctx.scale(dpr, dpr);
  ctx.globalCompositeOperation = "lighter";
  ctx.drawImage(c, 0, 0, w, h, 0, 0, w, h);
  ctx.restore();

  return true;
}

window.initGLParticlesInstanced  = initGLParticlesInstanced;
window.renderParticlesInstanced  = renderParticlesInstanced;
