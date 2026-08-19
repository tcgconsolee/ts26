/**
 * galaxy-handzoom.js — webcam hand-gesture zoom for the desktop galaxy map.
 *
 * Gesture: hold both hands up to the camera and spread them apart to expand
 * (zoom in) or bring them together to shorten (zoom out) — like stretching
 * the galaxy between your palms.
 *
 * Desktop only. Uses MediaPipe Tasks-Vision HandLandmarker (loaded lazily from
 * CDN on first activation, so the page costs nothing unless you turn it on).
 * Zoom is applied by dispatching synthetic wheel events at the canvas centre,
 * so it reuses OrbitControls' own damping, limits and zoom-to-cursor logic.
 */

const MP_VER = '0.10.14'
const MP_MODULE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}`
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/wasm`
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

export function initHandZoom ({ canvas, controls, camera, renderer, wrap }) {
  // Computer only — skip touch / coarse-pointer devices.
  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return

  const mono = "9px 'JetBrains Mono', monospace"

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.innerHTML = '&#9995; HAND ZOOM'
  Object.assign(btn.style, {
    position: 'absolute', right: '10px', bottom: '40px', zIndex: '8',
    padding: '8px 10px', border: '1px solid #262626', background: 'rgba(0,0,0,0.78)',
    color: '#757575', font: mono, letterSpacing: '1.5px', cursor: 'pointer',
    textTransform: 'uppercase'
  })
  wrap.appendChild(btn)

  const panel = document.createElement('div')
  Object.assign(panel.style, {
    position: 'absolute', right: '10px', bottom: '76px', zIndex: '8',
    width: '168px', border: '1px solid rgba(255,211,7,0.4)', background: 'rgba(0,0,0,0.82)',
    display: 'none', padding: '0'
  })
  const video = document.createElement('video')
  video.autoplay = true
  video.playsInline = true
  video.muted = true
  Object.assign(video.style, {
    width: '100%', height: '112px', objectFit: 'cover', display: 'block',
    transform: 'scaleX(-1)', filter: 'grayscale(0.4) contrast(1.1)'
  })
  const status = document.createElement('div')
  Object.assign(status.style, {
    font: mono, color: '#ffd307', letterSpacing: '1px', padding: '5px 7px',
    borderTop: '1px solid rgba(255,211,7,0.25)', textAlign: 'center'
  })
  status.textContent = 'IDLE'
  panel.appendChild(video)
  panel.appendChild(status)
  wrap.appendChild(panel)

  let landmarker = null
  let running = false
  let raf = 0
  let prevD = null
  let smoothD = null
  let lastTs = -1

  async function ensureModel () {
    if (landmarker) return
    status.textContent = 'LOADING MODEL...'
    const vision = await import(/* @vite-ignore */ MP_MODULE)
    const fileset = await vision.FilesetResolver.forVisionTasks(MP_WASM)
    landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MP_MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 2
    })
  }

  async function start () {
    try {
      status.textContent = 'REQUESTING CAMERA...'
      panel.style.display = 'block'
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240, facingMode: 'user' }, audio: false
      })
      video.srcObject = stream
      await ensureModel()
      running = true
      btn.style.color = '#000'
      btn.style.background = '#ffd307'
      btn.style.borderColor = '#ffd307'
      status.textContent = 'SHOW BOTH HANDS'
      loop()
    } catch (e) {
      status.textContent = 'CAMERA / MODEL UNAVAILABLE'
      console.warn('[handzoom]', e)
      stopStream()
    }
  }

  function stopStream () {
    const s = video.srcObject
    if (s) s.getTracks().forEach(t => t.stop())
    video.srcObject = null
  }

  function stop () {
    running = false
    cancelAnimationFrame(raf)
    stopStream()
    panel.style.display = 'none'
    btn.style.color = '#757575'
    btn.style.background = 'rgba(0,0,0,0.78)'
    btn.style.borderColor = '#262626'
    prevD = smoothD = null
  }

  btn.addEventListener('click', () => (running ? stop() : start()))

  function dispatchZoom (deltaY) {
    const r = canvas.getBoundingClientRect()
    canvas.dispatchEvent(new WheelEvent('wheel', {
      deltaY,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      bubbles: true,
      cancelable: true
    }))
  }

  function loop () {
    if (!running) return
    raf = requestAnimationFrame(loop)
    if (renderer.xr.isPresenting) return          // desktop mode only
    if (!video.videoWidth || video.readyState < 2) return

    const ts = performance.now()
    if (ts === lastTs) return                      // MediaPipe rejects duplicate timestamps
    lastTs = ts

    let res
    try { res = landmarker.detectForVideo(video, ts) } catch { return }
    const hands = (res && res.landmarks) || []

    if (hands.length >= 2) {
      const a = hands[0][0]                         // wrist landmark, hand A
      const b = hands[1][0]                         // wrist landmark, hand B
      const d = Math.hypot(a.x - b.x, a.y - b.y)    // normalised 0..~1
      smoothD = smoothD == null ? d : smoothD + (d - smoothD) * 0.5
      if (prevD != null) {
        const delta = smoothD - prevD
        if (Math.abs(delta) > 0.004) {
          // spread apart (delta>0) → zoom in → negative wheel deltaY
          dispatchZoom(-Math.max(-0.25, Math.min(0.25, delta)) * 4200)
        }
      }
      prevD = smoothD
      status.textContent = 'TRACKING · SPREAD / PINCH'
      status.style.color = '#ffd307'
    } else {
      prevD = null
      status.textContent = hands.length === 1 ? 'SHOW BOTH HANDS' : 'NO HANDS DETECTED'
      status.style.color = '#757575'
    }
  }

  window.addEventListener('beforeunload', stopStream)
}
