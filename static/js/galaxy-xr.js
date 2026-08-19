/**
 * galaxy-xr.js  —  WebXR support for the Imperial Terminal galaxy map.
 *
 * Zoom: both thumbsticks move the camera forward/backward along the
 * headset's gaze direction.  Push stick up = zoom in, pull down = zoom out.
 * Works on either hand.
 */

import * as THREE from 'three'

// ── constants ──────────────────────────────────────────────────────────────────
const ZOOM_SPEED    = 12.0   // world-units per second at full deflection
const ZOOM_DEADZONE = 0.15   // ignore stick values inside this radius (drift)
const ZOOM_MIN      = 1.2    // closest the camera can get to scene origin
const ZOOM_MAX      = 340    // furthest allowed (matches OrbitControls.maxDistance)
const FOVEATION     = 0.5    // 0=quality … 1=perf; 0.5 is Quest's sweet-spot

// ── state ──────────────────────────────────────────────────────────────────────
let _renderer, _scene, _camera, _controls
let _vrButton  = null
let _xrActive  = false
let _session   = null
let _prevTime  = null

// The "base pose" offset we apply each frame to simulate movement.
// We accumulate dolly into this Vector3 and pass it to
// renderer.xr.getCamera().position (which Three.js exposes as the XR camera
// group's position when renderer.xr.enabled = true).
let _offset = new THREE.Vector3()

// ── public init ────────────────────────────────────────────────────────────────
export async function initXR ({ renderer, scene, camera, controls }) {
  _renderer = renderer
  _scene    = scene
  _camera   = camera
  _controls = controls

  _renderer.xr.enabled = true
  _renderer.xr.setFoveation(FOVEATION)

  await _setupVRButton()
}

// ── VR button ──────────────────────────────────────────────────────────────────
async function _setupVRButton () {
  const wrap = document.getElementById('galaxyWrap')
  if (!wrap) return

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
    _session && await _session.end().catch(() => {})
    return
  }

  try {
    const session = await navigator.xr.requestSession('immersive-vr', {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['bounded-floor', 'hand-tracking'],
    })

    _session  = session
    _xrActive = true
    _prevTime = null
    _offset.set(0, 0, 0)

    if (_vrButton) _vrButton.textContent = '⬡ EXIT VR'
    if (_controls) _controls.enabled = false

    await _renderer.xr.setSession(session)
    session.addEventListener('end', _onSessionEnd)

    _renderer.setAnimationLoop(_xrFrame)
  } catch (err) {
    console.error('[galaxy-xr] session failed:', err)
    _xrActive = false
    if (_vrButton) _vrButton.textContent = '⬡ ENTER VR'
  }
}

// ── session end ────────────────────────────────────────────────────────────────
function _onSessionEnd () {
  _xrActive = false
  _session  = null
  _prevTime = null
  _offset.set(0, 0, 0)

  if (_vrButton) _vrButton.textContent = '⬡ ENTER VR'
  if (_controls) _controls.enabled = true

  // Restore the galaxy's original desktop animation loop
  const gx = window.__gx
  if (gx && gx.clock && gx.frame) {
    _renderer.setAnimationLoop(() => gx.frame(gx.clock.getElapsedTime()))
  }
}

// ── per-frame XR loop ──────────────────────────────────────────────────────────
function _xrFrame (timestamp, frame) {
  const now = timestamp / 1000
  const dt  = (_prevTime === null) ? 0 : Math.min(now - _prevTime, 0.1)
  _prevTime = now

  // Keep the galaxy scene animated (rotation, tweens, etc.)
  const gx = window.__gx
  if (gx && gx.clock && gx.frame) {
    gx.frame(gx.clock.getElapsedTime())
  }

  if (frame && dt > 0) {
    _applyThumbstickZoom(dt, frame)
  }

  _renderer.render(_scene, _camera)
}

// ── thumbstick zoom ────────────────────────────────────────────────────────────
/**
 * Quest Touch Plus gamepad layout (each inputSource has its own gamepad):
 *   axes[0] = thumbstick X
 *   axes[1] = thumbstick Y   ← we use this
 *   axes[2] = touchpad X     (unused here)
 *   axes[3] = touchpad Y     (unused here)
 *
 * axes[1]: -1 = stick pushed forward/up, +1 = pulled back/down
 * We invert: forward push → positive zoom (move toward scene).
 *
 * Both controllers are checked; first one outside the deadzone wins.
 */
function _applyThumbstickZoom (dt, frame) {
  let stickY = 0

  for (const src of frame.session.inputSources) {
    const gp = src.gamepad
    if (!gp || !gp.axes || gp.axes.length < 2) continue
    const y = gp.axes[1]
    if (Math.abs(y) > ZOOM_DEADZONE) {
      stickY = y
      break   // first active stick wins
    }
  }

  if (stickY === 0) return

  // -stickY: forward push (negative axis) becomes positive (zoom in)
  const direction = -stickY

  // Get the XR camera group that Three.js manages
  const xrCam = _renderer.xr.getCamera()

  // Current distance from scene origin — used for clamping
  const dist = xrCam.position.length()

  // How far to move this frame
  let step = ZOOM_SPEED * Math.abs(direction) * dt
  if (direction > 0) {
    // Zoom in — clamp to minimum distance
    step = Math.min(step, Math.max(0, dist - ZOOM_MIN))
  } else {
    // Zoom out — clamp to maximum distance
    step = Math.min(step, Math.max(0, ZOOM_MAX - dist))
  }

  if (step <= 0) return

  // Move along the headset's forward axis (camera looks down -Z in camera space)
  const forward = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(xrCam.quaternion)
    .normalize()

  // Apply the movement directly to the XR camera group position
  xrCam.position.addScaledVector(forward, direction > 0 ? step : -step)
}
