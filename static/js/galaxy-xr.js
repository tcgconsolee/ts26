/**
 * galaxy-xr.js  —  WebXR support for the Imperial Terminal galaxy map.
 *
 * Zoom: thumbstick Y on either controller dollies the camera.
 * Push up = zoom in, pull down = zoom out.
 *
 * Locomotion uses XRReferenceSpace.getOffsetReferenceSpace() — the only
 * correct way to move in WebXR. Writing to xrCamera.position is overwritten
 * by the runtime every frame and does nothing.
 */

import * as THREE from 'three'

// ── constants ──────────────────────────────────────────────────────────────────
const ZOOM_SPEED    = 10.0   // world-units per second at full stick deflection
const ZOOM_DEADZONE = 0.15   // ignore axes inside this range (stick drift)
const ZOOM_MIN      = 2      // min distance from origin
const ZOOM_MAX      = 340    // max distance (matches OrbitControls.maxDistance)
const FOVEATION     = 0.5

// ── state ──────────────────────────────────────────────────────────────────────
let _renderer, _scene, _camera, _controls
let _vrButton = null
let _xrActive = false
let _session  = null
let _prevTime = null

// Accumulated dolly offset in the reference space coordinate frame.
// We store it ourselves because getOffsetReferenceSpace is cumulative —
// we need to track where we are to apply incremental steps.
let _dollyOffset = new THREE.Vector3()

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
    if (_session) await _session.end().catch(() => {})
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
    _dollyOffset.set(0, 0, 0)

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
  _dollyOffset.set(0, 0, 0)

  if (_vrButton) _vrButton.textContent = '⬡ ENTER VR'
  if (_controls) _controls.enabled = true

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

  // Keep galaxy scene animated
  const gx = window.__gx
  if (gx && gx.clock && gx.frame) gx.frame(gx.clock.getElapsedTime())

  if (frame && dt > 0) _applyThumbstickZoom(dt, frame)

  _renderer.render(_scene, _camera)
}

// ── thumbstick zoom via XRReferenceSpace offset ────────────────────────────────
//
// WebXR locomotion 101:
//   The XR runtime writes the headset pose into the reference space each frame.
//   You CANNOT move the camera by writing to xrCamera.position — the runtime
//   overwrites it.  The correct pattern is:
//
//     baseRefSpace = renderer.xr.getReferenceSpace()   // set by Three.js
//     newRefSpace  = baseRefSpace.getOffsetReferenceSpace(
//                      new XRRigidTransform({ x, y, z, w:1 }, { x,y,z,w:1 })
//                    )
//     renderer.xr.setReferenceSpace(newRefSpace)
//
//   getOffsetReferenceSpace applies a FIXED offset to the base space.
//   To dolly incrementally we accumulate the total offset ourselves
//   (_dollyOffset) and rebuild the offset reference space from scratch
//   each frame — otherwise the offsets compound incorrectly.

function _applyThumbstickZoom (dt, frame) {
  // ── 1. Read thumbstick Y from any connected controller ────────────────────
  let stickY = 0
  for (const src of frame.session.inputSources) {
    const gp = src.gamepad
    if (!gp || !gp.axes || gp.axes.length < 2) continue
    // axes[1] = thumbstick Y on Quest Touch Plus (per-source gamepad)
    // -1 = pushed forward/up, +1 = pulled back/down
    const y = gp.axes[1]
    if (Math.abs(y) > ZOOM_DEADZONE) {
      stickY = y
      break
    }
  }
  if (stickY === 0) return

  // ── 2. Work out move direction and distance ───────────────────────────────
  // Negate: forward push (axes[1] = -1) → positive zoom-in direction
  const zoomSign = -stickY > 0 ? 1 : -1
  const magnitude = (Math.abs(stickY) - ZOOM_DEADZONE) / (1 - ZOOM_DEADZONE) // remap to 0-1
  const step = ZOOM_SPEED * magnitude * dt

  // ── 3. Get headset forward direction (ignore pitch, move horizontally) ────
  // Three.js XR camera represents the headset. Its world quaternion gives us
  // the viewing direction. We use only the yaw component so we don't fly up
  // when looking at the sky.
  const xrCam = _renderer.xr.getCamera()
  const forward = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(xrCam.quaternion)
  forward.y = 0         // lock vertical — pure horizontal dolly
  if (forward.lengthSq() < 0.0001) forward.set(0, 0, -1)
  forward.normalize()

  // ── 4. Clamp to distance limits ───────────────────────────────────────────
  const proposed = _dollyOffset.clone().addScaledVector(forward, zoomSign * step)
  // Approximate camera world position: dolly offset (reference space has origin
  // near the player's feet at session start, so _dollyOffset ≈ camera movement)
  const approxDist = proposed.length()
  if (approxDist < ZOOM_MIN && zoomSign > 0) return  // too close
  if (approxDist > ZOOM_MAX && zoomSign < 0) return  // too far

  // ── 5. Accumulate offset and rebuild the reference space ──────────────────
  _dollyOffset.copy(proposed)

  const baseSpace = _renderer.xr.getReferenceSpace()
  if (!baseSpace) return

  // XRRigidTransform: position moves the origin, so NEGATE the offset
  // (moving the origin backward shifts the viewer forward).
  const offsetTransform = new XRRigidTransform(
    { x: -_dollyOffset.x, y: 0, z: -_dollyOffset.z, w: 1 },
    { x: 0, y: 0, z: 0, w: 1 }   // no rotation
  )

  const newRefSpace = baseSpace.getOffsetReferenceSpace(offsetTransform)
  _renderer.xr.setReferenceSpace(newRefSpace)
}
