/*
 * ================================================================
 * gl-particles-instanced.js  —  WebGL2 Instanced Particle Renderer
 * ================================================================
 * Depends on: config.js (CONFIG)
 *
 * Renders all particles in a SINGLE draw call using WebGL2 instanced
 * rendering. Each particle is a point sprite with per-instance:
 *   - position (x, y)
 *   - color (r, g, b)
 *   - alpha
 *   - size
 *
 * This replaces both the old Three.js renderer (uniform color only)
 * and the 2D canvas fallback (8000 individual arc() calls per frame).
 *
 * Performance: one draw call for all particles. Buffer updates use
 * Float32Array subData — no object allocation per frame.
 *
 * Composited onto the main 2D canvas via drawImage() from an
 * offscreen WebGL canvas.
 * ================================================================
 */

var _glpInst = {
  ready:     false,
  gl:        null,
  canvas:    null,
  program:   null,
  vao:       null,
  instBuf:   null,     // instance buffer (position + color + alpha + size)
  instData:  null,     // Float32Array backing the instance buffer
  capacity:  0,        // current buffer capacity (particle count)
  lastW:     0,
  lastH:     0,
  uResolution: null,
  uOffset:   null,
  uScale:    null,
};

// Per-instance data layout: x, y, r, g, b, a, size = 7 floats
var INST_FLOATS = 7;

// ================================================================
// SHADERS
// ================================================================

var _glpVertSrc = [
  "#version 300 es",
  "precision highp float;",
  "",
  "// Per-instance attributes",
  "layout(location = 0) in vec2 aPos;",       // x, y in world coords
  "layout(location = 1) in vec4 aColor;",     // r, g, b, a
  "layout(location = 2) in float aSize;",     // point size in world units
  "",
  "uniform vec2 uResolution;",               // screen size in pixels
  "uniform vec2 uOffset;",                   // viewOffsetX, viewOffsetY
  "uniform float uScale;",                   // viewScale
  "",
  "out vec4 vColor;",
  "",
  "void main() {",
  "  // Apply zoom/pan: screen = world * scale + offset",
  "  vec2 screen = aPos * uScale + uOffset;",
  "  // Convert pixel coords to clip space (-1..1)",
  "  vec2 clip = (screen / uResolution) * 2.0 - 1.0;",
  "  clip.y = -clip.y;  // flip Y (canvas Y is top-down)",
  "  gl_Position = vec4(clip, 0.0, 1.0);",
  "  gl_PointSize = aSize * uScale;",        // scale point size with zoom
  "  vColor = aColor;",
  "}",
].join("\n");

var _glpFragSrc = [
  "#version 300 es",
  "precision highp float;",
  "",
  "in vec4 vColor;",
  "out vec4 fragColor;",
  "",
  "void main() {",
  "  // Circular point sprite: discard corners",
  "  vec2 pc = gl_PointCoord * 2.0 - 1.0;",
  "  float d = dot(pc, pc);",
  "  if (d > 1.0) discard;",
  "",
  "  // Soft edge falloff",
  "  float edge = 1.0 - smoothstep(0.5, 1.0, d);",
  "  fragColor = vec4(vColor.rgb, vColor.a * edge);",
  "}",
].join("\n");


// ================================================================
// INITIALIZATION
// ================================================================

function initGLParticlesInstanced() {
  try {
    // Create offscreen canvas for WebGL rendering
    var c = document.createElement("canvas");
    var gl = c.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
    });
    if (!gl) {
      console.warn("[gl-particles-instanced] WebGL2 not available");
      return false;
    }

    // Compile shaders
    var vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, _glpVertSrc);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.warn("[gl-particles-instanced] Vertex shader error:", gl.getShaderInfoLog(vs));
      return false;
    }

    var fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, _glpFragSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.warn("[gl-particles-instanced] Fragment shader error:", gl.getShaderInfoLog(fs));
      return false;
    }

    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("[gl-particles-instanced] Link error:", gl.getProgramInfoLog(prog));
      return false;
    }

    // Get uniform locations
    var uRes    = gl.getUniformLocation(prog, "uResolution");
    var uOffset = gl.getUniformLocation(prog, "uOffset");
    var uScale  = gl.getUniformLocation(prog, "uScale");

    // Create VAO with instance buffer
    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    var instBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);

    // Attribute 0: aPos (vec2) — offset 0, stride 7*4=28
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, INST_FLOATS * 4, 0);
    gl.vertexAttribDivisor(0, 1);  // per instance

    // Attribute 1: aColor (vec4) — offset 2*4=8
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, INST_FLOATS * 4, 2 * 4);
    gl.vertexAttribDivisor(1, 1);

    // Attribute 2: aSize (float) — offset 6*4=24
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, INST_FLOATS * 4, 6 * 4);
    gl.vertexAttribDivisor(2, 1);

    gl.bindVertexArray(null);

    _glpInst.gl        = gl;
    _glpInst.canvas    = c;
    _glpInst.program   = prog;
    _glpInst.vao       = vao;
    _glpInst.instBuf   = instBuf;
    _glpInst.uResolution = uRes;
    _glpInst.uOffset    = uOffset;
    _glpInst.uScale     = uScale;
    _glpInst.ready       = true;

    console.log("[gl-particles-instanced] WebGL2 instanced renderer ready");
    return true;
  } catch (e) {
    console.warn("[gl-particles-instanced] Init failed:", e);
    return false;
  }
}


// ================================================================
// RENDER
// ================================================================
// particleArr:  array of particle objects
// ctx:          the main 2D canvas context to composite onto
// mainCanvas:   the main canvas element (for sizing)
// viewScale:    current zoom level (state.viewScale)
// viewOffsetX:  pan offset X (state.viewOffsetX)
// viewOffsetY:  pan offset Y (state.viewOffsetY)

function renderParticlesInstanced(particleArr, ctx, mainCanvas, viewScale, viewOffsetX, viewOffsetY) {
  if (!_glpInst.ready) return false;

  var n = particleArr.length;
  if (n === 0) return true;

  var gl = _glpInst.gl;
  var c  = _glpInst.canvas;

  // Resize offscreen canvas to match main canvas logical size
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
    console.log("[gl-particles-instanced] Buffer grew to " + newCap);
  }

  var data = _glpInst.instData;

  // ---- Fill instance data ----
  for (var i = 0; i < n; i++) {
    var p = particleArr[i];
    var off = i * INST_FLOATS;
    var fade = (p.fadeMult !== undefined) ? p.fadeMult : 1.0;

    // Color: topology intensity → valley (white-cyan) to ridge (orange)
    var ti = p.topoIntensity || 0;
    var t = Math.min(1.0, ti * 3.0);
    t = t * t;

    var r = (200 + (255 - 200) * t) / 255;
    var g = (240 + (140 - 240) * t) / 255;
    var b = (255 + (40 - 255)  * t) / 255;

    // Alpha: high minimum, speed modulates brightness
    var speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    var bright = Math.min(1.0, speed / 2.0);
    var alpha = (0.7 + bright * 0.3) * fade;

    // Size: slightly smaller for cleaner flow lines at high particle counts
    var size = 2.8 + bright * 0.8;

    data[off]     = p.x;
    data[off + 1] = p.y;
    data[off + 2] = r;
    data[off + 3] = g;
    data[off + 4] = b;
    data[off + 5] = alpha;
    data[off + 6] = size;
  }

  // Upload instance data
  gl.bindBuffer(gl.ARRAY_BUFFER, _glpInst.instBuf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, n * INST_FLOATS));

  // ---- Draw ----
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  gl.useProgram(_glpInst.program);
  gl.uniform2f(_glpInst.uResolution, w, h);
  gl.uniform2f(_glpInst.uOffset, viewOffsetX || 0, viewOffsetY || 0);
  gl.uniform1f(_glpInst.uScale, viewScale || 1.0);

  gl.bindVertexArray(_glpInst.vao);

  // Draw N instances of a single point (gl.POINTS with instancing)
  gl.drawArraysInstanced(gl.POINTS, 0, 1, n);

  gl.bindVertexArray(null);

  // ---- Composite onto 2D canvas ----
  // The main 2D canvas has a zoom/pan transform active (ctx.translate + scale).
  // Since our WebGL shader already applies the viewport transform, we need
  // to temporarily reset the 2D transform to avoid double-transformation.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);  // reset to identity
  // Account for DPR scaling that's always active on the canvas
  var dpr = Math.max(2, window.devicePixelRatio || 1);
  ctx.scale(dpr, dpr);
  ctx.globalCompositeOperation = "lighter";
  ctx.drawImage(c, 0, 0, w, h, 0, 0, w, h);
  ctx.restore();

  return true;
}

// Export to global scope
window.initGLParticlesInstanced  = initGLParticlesInstanced;
window.renderParticlesInstanced  = renderParticlesInstanced;
