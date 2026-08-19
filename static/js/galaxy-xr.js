/**
 * galaxy-xr.js
 * WebXR layer for the Imperial Terminal galaxy map.
 *
 * Responsibilities:
 *   - Feature-detect immersive-vr and show/hide the "Enter VR" button
 *   - Request / end an XRSession
 *   - Switch the Three.js render loop to renderer.setAnimationLoop so
 *     Three.js handles stereo rendering, XRWebGLLayer binding, and
 *     reference-space management internally (renderer.xr.enabled = true)
 *   - Create controller helpers (ray lines + XRControllerModelFactory)
 *   - Per-frame: read right-controller thumbstick Y-axis and dolly the
 *     camera rig toward/away from the controller ray's hit-point in the
 *     scene — replicating the desktop OrbitControls.zoomToCursor dolly
 *   - Disable OrbitControls while XR is active, re-enable on session end
 *   - Foveated rendering hint for Quest 3 native compositor
 *
 * Dependencies (already in vendor/):
 *   three.module.min.js  (r168)
 *
 * Additional modules loaded at runtime via importmap "three" alias:
 *   /static/js/vendor/XRControllerModelFactory.js  (optional, falls back
 *   to a plain ray-line if not present)
 *
 * Usage (called from galaxy.js after scene/renderer/camera are ready):
 *   import { initXR } from '/static/js/galaxy-xr.js'
 *   initXR({ renderer, scene, camera, controls })
 */

import * as THREE from 'three'

// ─── tuneable constants ────────────────────────────────────────────────────────
const ZOOM_SPEED        = 8.0    // world-units per second at full stick deflection
const ZOOM_DEADZONE     = 0.12   // ignore stick values below this (drift prevention)
const ZOOM_MIN_DIST     = 1.2    // minimum camera-to-rig-origin distance (mirrors OrbitControls.minDistance)
const ZOOM_MAX_DIST     = 340    // maximum distance (mirrors OrbitControls.maxDistance)
const FOVEATION_LEVEL   = 0.5    // 0 = quality, 1 = perf; 0.5 is Quest default sweet-spot
const RAY_LENGTH        = 500    // visual ray line length in world-units
const RAY_COLOR_IDLE    = 0x888888
const RAY_COLOR_SELECT  = 0xffd307

// ─── module-level state ────────────────────────────────────────────────────────
let _renderer, _scene, _camera, _controls
let _vrButton        = null
let _xrActive        = false
let _cameraRig       = null      // Group that wraps the camera in XR space
let _controllers     = []        // [leftCtrl, rightCtrl]  XRTargetRaySpace objects
let _controllerGrips = []        // [leftGrip, rightGrip]  XRGripSpace objects
let _rayLines        = []        // Line helpers (one per controller)
let _raycaster       = new THREE.Raycaster()
let _hitMarker       = null      // small sphere shown at raycast hit point
let _prevTime        = null      // for delta-time zoom calculation
let _session         = null

// ─── public entry point ───────────────────────────────────────────────────────
/**
 * initXR({ renderer, scene, camera, controls })
 *
 * Call this once from galaxy.js after the renderer/scene/camera are set up.
 * It injects the "Enter VR" button into #galaxyWrap and wires all XR logic.
 */
export async function initXR ({ renderer, scene, camera, controls }) {
  _renderer = renderer
  _scene    = scene
  _camera   = camera
  _controls = controls

  // Three.js r136+ needs renderer.xr.enabled before any session can start
  _renderer.xr.enabled = true

  // Foveated rendering — Quest 3 compositor honours this for significant GPU savings
  _renderer.xr.setFoveation(FOVEATION_LEVEL)

  // Build a camera rig so we can dolly it without fighting the XR reference space
  _buildCameraRig()

  // Build the hit-point marker (hidden until a ray hits something)
  _buildHitMarker()

  // Try to show the Enter VR button
  await _setupVRButton()
}

// ─── camera rig ──────────────────────────────────────────────────────────────
/**
 * In WebXR the headset's pose drives the camera directly inside the XR
 * reference space.  To "move" the player (dolly / teleport) we parent the
 * camera to a Group and translate that Group instead.
 *
 * Three.js renderer.xr places the camera inside renderer.xr.getCamera()
 * automatically, but we still need a rig Group that our dolly code moves.
 */
function _buildCameraRig () {
  _cameraRig = new THREE.Group()
  _cameraRig.name = 'xrCameraRig'

  // Copy desktop camera's starting world position so VR begins at the same
  // vantage point the desktop view was at.
  _cameraRig.position.copy(_camera.position)

  _scene.add(_cameraRig)
}

// ─── hit-point marker ────────────────────────────────────────────────────────
function _buildHitMarker () {
  const geo = new THREE.SphereGeometry(0.4, 8, 8)
  const mat = new THREE.MeshBasicMaterial({
    color: RAY_COLOR_SELECT,
    transparent: true,
    opacity: 0.6,
    depthWrite: false
  })
  _hitMarker = new THREE.Mesh(geo, mat)
  _hitMarker.visible = false
  _hitMarker.renderOrder = 10
  _scene.add(_hitMarker)
}

// ─── VR button ───────────────────────────────────────────────────────────────
async function _setupVRButton () {
  const wrap = document.getElementById('galaxyWrap')
  if (!wrap) return

  // Feature-detect: only show the button if immersive-vr is actually supported
  const supported = navigator.xr
    ? await navigator.xr.isSessionSupported('immersive-vr').catch(() => false)
    : false

  const btn = document.createElement('button')
  btn.id = 'gxVrBtn'

  if (supported) {
    btn.textContent = '⬡ ENTER VR'
    btn.addEventListener('click', _onVRButtonClick)
  } else {
    btn.textContent = '⬡ VR N/A'
    btn.disabled = true
    btn.title = 'immersive-vr not supported in this browser'
  }

  wrap.appendChild(btn)
  _vrButton = btn
}

async function _onVRButtonClick () {
  if (_xrActive) {
    // User clicked "EXIT VR" — end the session
    if (_session) {
      await _session.end().catch(() => {})
    }
    return
  }

  try {
    const session = await navigator.xr.requestSession('immersive-vr', {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['bounded-floor', 'hand-tracking']
    })

    _session = session
    _xrActive = true
    _vrButton.textContent = '⬡ EXIT VR'

    // Let Three.js manage the XRWebGLLayer, context compatibility check,
    // and the session.requestAnimationFrame loop.
    // setAnimationLoop(null) first to clear any old loop, then re-set with XR.
    await _renderer.xr.setSession(session)

    // Disable OrbitControls so the headset pose is the sole camera authority
    if (_controls) _controls.enabled = false

    // Snap the rig to where the desktop camera was sitting
    const xrCamera = _renderer.xr.getCamera()
    _cameraRig.position.copy(_camera.position)
    _cameraRig.quaternion.identity()

    // Build controller helpers (ray lines + optional model)
    _buildControllers()

    session.addEventListener('end', _onSessionEnd)

    // Three.js setAnimationLoop replaces the plain rAF loop with an XR-aware
    // one that calls session.requestAnimationFrame internally.
    _renderer.setAnimationLoop(_xrFrame)
  } catch (err) {
    console.error('[galaxy-xr] Failed to start XR session:', err)
    _xrActive = false
    if (_vrButton) _vrButton.textContent = '⬡ ENTER VR'
  }
}

// ─── session end ─────────────────────────────────────────────────────────────
function _onSessionEnd () {
  _xrActive  = false
  _session   = null
  _prevTime  = null

  if (_vrButton) _vrButton.textContent = '⬡ ENTER VR'

  // Remove XR controller helpers from scene
  for (const ctrl of _controllers)     { _scene.remove(ctrl) }
  for (const grip of _controllerGrips) { _scene.remove(grip) }
  for (const line of _rayLines)        { _scene.remove(line) }
  _controllers     = []
  _controllerGrips = []
  _rayLines        = []

  if (_hitMarker) _hitMarker.visible = false

  // Hand control back to OrbitControls and restore the desktop loop
  if (_controls) _controls.enabled = true

  // galaxy.js's original loop: renderer.setAnimationLoop(() => frame(clock.getElapsedTime()))
  // We re-assign it via the hook that galaxy.js exposes on window.__gx
  const gx = window.__gx
  if (gx && gx.clock && gx.frame) {
    _renderer.setAnimationLoop(() => gx.frame(gx.clock.getElapsedTime()))
  }
}

// ─── controller setup ────────────────────────────────────────────────────────
function _buildControllers () {
  const xr = _renderer.xr

  for (let i = 0; i < 2; i++) {
    // Target ray space — this is the pointing ray, not the grip
    const ctrl = xr.getController(i)
    ctrl.addEventListener('selectstart', _onSelectStart)
    ctrl.addEventListener('selectend',   _onSelectEnd)
    _scene.add(ctrl)
    _controllers.push(ctrl)

    // Grip space — physical controller body position/orientation
    const grip = xr.getControllerGrip(i)
    _scene.add(grip)
    _controllerGrips.push(grip)

    // Visual ray line — a simple line from origin along -Z in controller space
    const rayLine = _buildRayLine()
    ctrl.add(rayLine)   // child of controller so it tracks automatically
    _rayLines.push(rayLine)
  }
}

function _buildRayLine () {
  // Two-point line: [0,0,0] → [0,0,-RAY_LENGTH]
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -RAY_LENGTH)
  ])
  // Gradient opacity: bright at tip, fading at distance
  const alphas = new Float32Array([1.0, 0.0])
  geo.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1))

  const mat = new THREE.LineBasicMaterial({
    color: RAY_COLOR_IDLE,
    transparent: true,
    opacity: 0.55,
    depthWrite: false
  })
  const line = new THREE.Line(geo, mat)
  line.renderOrder = 9
  return line
}

// ─── select events (trigger press) ───────────────────────────────────────────
function _onSelectStart (event) {
  const ctrl = event.target
  const idx  = _controllers.indexOf(ctrl)
  if (idx < 0) return

  // Highlight ray
  if (_rayLines[idx]) _rayLines[idx].material.color.setHex(RAY_COLOR_SELECT)

  // Raycast into planet points to replicate the desktop click→select behaviour
  const hit = _raycastScene(ctrl)
  if (hit !== null) {
    const gx = window.__gx
    if (gx && gx.select) gx.select(hit.planetIdx)
  }
}

function _onSelectEnd (event) {
  const ctrl = event.target
  const idx  = _controllers.indexOf(ctrl)
  if (idx >= 0 && _rayLines[idx]) {
    _rayLines[idx].material.color.setHex(RAY_COLOR_IDLE)
  }
}

// ─── XR per-frame render loop ─────────────────────────────────────────────────
/**
 * Called by Three.js's setAnimationLoop in XR mode.
 * `timestamp` is the XR timestamp (ms), `frame` is the XRFrame.
 *
 * Three.js r136+ handles:
 *   - Binding the XRWebGLLayer framebuffer
 *   - Setting viewport for each eye
 *   - Applying each view's projection + view matrix to the camera
 * So we just call renderer.render(scene, camera) once and Three.js
 * draws both eyes.
 */
function _xrFrame (timestamp, frame) {
  // Delta time for frame-rate-independent zoom
  const now = timestamp / 1000  // seconds
  const dt  = _prevTime === null ? 0 : Math.min(now - _prevTime, 0.1)
  _prevTime = now

  if (!_xrActive || !frame) {
    // Fallback: just render the desktop scene normally
    _renderer.render(_scene, _camera)
    return
  }

  // Also run the galaxy's own per-frame animation (galaxy rotation, tweens, etc.)
  // This keeps the scene alive in VR — we drive it here rather than from the
  // old setAnimationLoop so there's only one active loop at a time.
  const gx = window.__gx
  if (gx && gx.frame && gx.clock) {
    // Call galaxy.js frame() for scene animation but skip its renderer.render()
    // call — we do the render ourselves below after setting up the XR camera.
    gx.frame(gx.clock.getElapsedTime())
  }

  // ── Thumbstick zoom ────────────────────────────────────────────────────────
  _processThumbstickZoom(dt, frame)

  // ── Raycast hit marker update ─────────────────────────────────────────────
  _updateHitMarker()

  // Three.js renders both eyes; no manual eye-loop needed with renderer.xr.enabled
  _renderer.render(_scene, _camera)
}

// ─── thumbstick dolly zoom ───────────────────────────────────────────────────
/**
 * Quest Touch Plus controller gamepad axes layout (verified against WebXR spec
 * and Meta's controller mapping documentation):
 *
 *   axes[0]  Left  stick X  (left controller)
 *   axes[1]  Left  stick Y  (left controller)
 *   axes[2]  Right stick X  (right controller)
 *   axes[3]  Right stick Y  (right controller)
 *
 * When accessed via session.inputSources[i].gamepad:
 *   Each inputSource has its own gamepad with axes[0]=thumbX, axes[1]=thumbY
 *
 * We use BOTH per-source axes[1] (Y of each controller's own stick), giving
 * the user the choice to use either hand.  Right controller is the primary;
 * left is secondary.  The first non-dead-zone input wins.
 *
 * Y-axis sign convention (WebXR standard): -1 = up/forward, +1 = down/back
 * We invert so "push forward = zoom in".
 */
function _processThumbstickZoom (dt, frame) {
  if (dt <= 0) return

  const referenceSpace = _renderer.xr.getReferenceSpace()
  if (!referenceSpace) return

  const inputSources = Array.from(frame.session.inputSources)

  // Find the right-controller source first, fall back to left
  const rightSrc = inputSources.find(s => s.handedness === 'right')
  const leftSrc  = inputSources.find(s => s.handedness === 'left')

  let rawAxis = 0
  let aimCtrl = null

  // Prefer right controller thumbstick; fall back to left
  for (const src of [rightSrc, leftSrc]) {
    if (!src) continue
    const gp = src.gamepad
    if (!gp || !gp.axes || gp.axes.length < 2) continue
    // axes[1] is thumbstick Y on each controller's own gamepad
    const y = gp.axes[1]
    if (Math.abs(y) > ZOOM_DEADZONE) {
      rawAxis = y
      aimCtrl = _controllers[inputSources.indexOf(src)]
      break
    }
  }

  if (rawAxis === 0 || !aimCtrl) return

  // Invert: push forward (axes[1] = -1) → zoom in (positive movement)
  const zoomDir = -rawAxis  // now +1 = zoom in, -1 = zoom out

  // ── Find the world-space point the controller ray is aimed at ──────────────
  // Use a raycaster from the controller's target-ray pose
  const hitPoint = _getControllerAimPoint(aimCtrl, frame, referenceSpace)

  // ── Dolly the camera rig ──────────────────────────────────────────────────
  const xrCamera = _renderer.xr.getCamera()
  const camWorldPos = new THREE.Vector3()
  xrCamera.getWorldPosition(camWorldPos)

  let targetPoint
  if (hitPoint) {
    targetPoint = hitPoint
    _hitMarker.position.copy(hitPoint)
    _hitMarker.visible = true
  } else {
    // No scene hit: dolly along camera's forward vector (ray direction at ∞)
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCamera.quaternion)
    targetPoint = camWorldPos.clone().add(forward.multiplyScalar(40))
    _hitMarker.visible = false
  }

  // Direction from camera to target
  const toTarget = new THREE.Vector3().subVectors(targetPoint, camWorldPos)
  const dist = toTarget.length()
  if (dist < 0.001) return

  // How far we move this frame
  const step = ZOOM_SPEED * dt  // world-units

  // Guard against overshooting: zoom-in stops at ZOOM_MIN_DIST from target,
  // zoom-out stops at ZOOM_MAX_DIST from scene origin (matches OrbitControls limits)
  const camToOriginDist = camWorldPos.length()

  if (zoomDir > 0) {
    // Zooming in — stop if we'd pass the target (keep ZOOM_MIN_DIST clearance)
    if (dist <= ZOOM_MIN_DIST) return
    const actualStep = Math.min(step, dist - ZOOM_MIN_DIST)
    const moveVec = toTarget.normalize().multiplyScalar(actualStep)
    _cameraRig.position.add(moveVec)
  } else {
    // Zooming out — stop at max distance from origin
    if (camToOriginDist >= ZOOM_MAX_DIST) return
    const actualStep = Math.min(step, ZOOM_MAX_DIST - camToOriginDist)
    const moveVec = toTarget.normalize().multiplyScalar(-actualStep)
    _cameraRig.position.add(moveVec)
  }
}

// ─── raycast helpers ──────────────────────────────────────────────────────────
/**
 * Returns a world-space Vector3 of the controller ray's closest scene
 * intersection, or null if nothing is hit.
 */
function _getControllerAimPoint (ctrl, frame, referenceSpace) {
  // Build a ray from the controller's world position + orientation
  const origin    = new THREE.Vector3()
  const direction = new THREE.Vector3(0, 0, -1)

  ctrl.getWorldPosition(origin)
  ctrl.getWorldQuaternion(_tmpQuat)
  direction.applyQuaternion(_tmpQuat)

  _raycaster.set(origin, direction)
  _raycaster.far = RAY_LENGTH

  // Collect all meshes in the scene for intersection test
  const targets = []
  _scene.traverseVisible(obj => {
    if (obj.isMesh) targets.push(obj)
  })

  const hits = _raycaster.intersectObjects(targets, false)
  if (hits.length > 0) return hits[0].point

  // No mesh hit — intersect with the galaxy plane (y=0) as a fallback
  // so the galaxy floor gives a sensible zoom target
  const t = -origin.y / (direction.y || 1e-9)
  if (t > 0 && t < RAY_LENGTH) {
    return new THREE.Vector3(
      origin.x + direction.x * t,
      0,
      origin.z + direction.z * t
    )
  }

  return null
}

/**
 * Raycast against the scene for planet selection (trigger press).
 * Returns { planetIdx } or null.
 */
function _raycastScene (ctrl) {
  const origin    = new THREE.Vector3()
  const direction = new THREE.Vector3(0, 0, -1)
  ctrl.getWorldPosition(origin)
  ctrl.getWorldQuaternion(_tmpQuat)
  direction.applyQuaternion(_tmpQuat)

  _raycaster.set(origin, direction)
  _raycaster.far = RAY_LENGTH

  const targets = []
  _scene.traverseVisible(obj => {
    // Only test textured sphere meshes (the clickable planet models)
    if (obj.isMesh && obj.userData.idx !== undefined) targets.push(obj)
  })

  const hits = _raycaster.intersectObjects(targets, false)
  if (hits.length > 0) {
    return { planetIdx: hits[0].object.userData.idx }
  }
  return null
}

// Update the hit marker every frame based on the active controller's aim
function _updateHitMarker () {
  if (!_xrActive || _controllers.length === 0) {
    if (_hitMarker) _hitMarker.visible = false
    return
  }
  // Use right controller as primary pointer for the persistent dot
  const primary = _controllers[1] || _controllers[0]
  if (!primary) return

  const origin    = new THREE.Vector3()
  const direction = new THREE.Vector3(0, 0, -1)
  primary.getWorldPosition(origin)
  primary.getWorldQuaternion(_tmpQuat)
  direction.applyQuaternion(_tmpQuat)

  _raycaster.set(origin, direction)
  _raycaster.far = RAY_LENGTH

  const targets = []
  _scene.traverseVisible(obj => { if (obj.isMesh) targets.push(obj) })
  const hits = _raycaster.intersectObjects(targets, false)

  if (hits.length > 0) {
    _hitMarker.position.copy(hits[0].point)
    _hitMarker.visible = true
  } else {
    _hitMarker.visible = false
  }
}

// Reusable quaternion scratch object to avoid per-frame allocation
const _tmpQuat = new THREE.Quaternion()
