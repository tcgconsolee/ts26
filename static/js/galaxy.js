
import * as THREE from 'three'
import { OrbitControls } from '/static/js/vendor/OrbitControls.js'
import { initXR } from '/static/js/galaxy-xr.js'

const wrap = document.getElementById('galaxyWrap')
const canvas = document.getElementById('galaxyCanvas')
if (wrap && canvas) init()

async function init () {
  let DATA = []
  try {
    DATA = await (await fetch('/static/data/planets.json')).json()
  } catch (e) {
    loadingFail('CARTOGRAPHY DATABASE UNREACHABLE')
    return
  }

  const LORE_OVERRIDES = {
    Mustafar: {
      de: "This small garden world's orbit was shifted when Lady Corvax attempted to use the Bright Star artifact to resurrect her husband. When Mustafar ended up in a gravimetric tug-of-war between the gas giants Jestefad and Lefrani, its core was superheated and its surface was transformed into a volcanic hellscape. The arthropodal Mustafarians evolved to survive their changed environment. It was later acquired by the Techno Union for mining purposes, and Black Sun's headquarters were located here. THE HOME OF LORD VADER. HEIL LORD VADER. It was upon this ground that Lord Vader was wronged by traitors to the Galactic Empire - their treachery repaid in fire.",
      sections: [{
        title: 'FORTRESS VADER',
        text: "By decree of the Emperor, the obsidian spire of Fortress Vader rises from the Gahenn Plains above rivers of fire - the seat of Lord Vader and a monument to the Empire's dominion. The fortress and its surrounding exclusion zone are closed to all civilian traffic. Unauthorized approach is punishable by death. ALL HEIL LORD VADER."
      }]
    }
  }
  for (const p of DATA) {
    const o = LORE_OVERRIDES[p.n]
    if (o) Object.assign(p, o)
  }

  const N = DATA.length

  const hash = str => {
    let h = 2166136261
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
    return ((h >>> 0) % 1000) / 1000
  }

  const KIND_DISC = 0, KIND_BLOB = 1, KIND_DIAMOND = 2, KIND_RING = 3

  const kindOf = p => {
    const i = p.i || ''
    if (i.startsWith('nebula') || i.startsWith('phenom') || i.startsWith('clustr')) return KIND_BLOB
    if (i.startsWith('staton')) return KIND_DIAMOND
    if (i.startsWith('blkhle')) return KIND_RING
    return KIND_DISC
  }
  const isFeatured = p => !!(p.de || p.th || (p.i && (p.i.includes('Mov') || p.i === 'movie')))

  const COL = {
    planet: new THREE.Color('#9dabc4'),
    planetAlt: new THREE.Color('#c2d0e8'),
    featured: new THREE.Color('#e6c015'),
    nebula: new THREE.Color('#5f7cb0'),
    station: new THREE.Color('#dbe4f2'),
    blackhole: new THREE.Color('#e87f36')
  }

  const PLANET_SCALE = 0.6
  const sizeOf = p => {
    let s
    if (p.d) s = Math.min(p.d / 10000, 6)
    else {
      s = 0.1 + hash(p.n) * 0.2
      if (isFeatured(p)) s = Math.max(s, 0.45)
    }
    return s * PLANET_SCALE
  }

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', xrCompatible: true })
  renderer.setClearColor(0x000000, 1)
  renderer.xr.enabled = true
  const DPR = () => Math.min(window.devicePixelRatio || 1, 2)

  const scene = new THREE.Scene()
  scene.fog = new THREE.Fog(0x000000, 420, 900)

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000)
  camera.position.set(0, 300, 4)
  const xrRig = new THREE.Group()
  xrRig.add(camera)
  scene.add(xrRig)

  const HOME_TGT = new THREE.Vector3(0, 0, 0)
  const HOME_POS = new THREE.Vector3(88, 52, 84)

  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.dampingFactor = 0.06
  controls.zoomToCursor = true
  controls.rotateSpeed = 0.55
  controls.zoomSpeed = 0.9
  controls.panSpeed = 0.8
  controls.screenSpacePanning = false
  controls.minDistance = 1.2
  controls.maxDistance = 340
  controls.maxPolarAngle = Math.PI * 0.86
  controls.enabled = false

  const clock = new THREE.Clock()

  const xrSaved = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), tgt: new THREE.Vector3() }
  renderer.xr.addEventListener('sessionstart', () => {
    xrSaved.pos.copy(camera.position)
    xrSaved.quat.copy(camera.quaternion)
    xrSaved.tgt.copy(controls.target)
    controls.enabled = false
    xrRig.position.set(0, -9.6, 86)
    xrRig.rotation.set(0, 0, 0)
  })
  renderer.xr.addEventListener('sessionend', () => {
    for (const c of xrCtl) {
      if (c.userData.grab) { xrRig.attach(c.userData.grab); c.userData.grab = null }
    }
    xrRig.position.set(0, 0, 0)
    xrRig.rotation.set(0, 0, 0)
    camera.position.copy(xrSaved.pos)
    camera.quaternion.copy(xrSaved.quat)
    controls.target.copy(xrSaved.tgt)
    controls.enabled = true
  })
  const xrCtl = []
  for (let ci = 0; ci < 2; ci++) {
    const ctl = renderer.xr.getController(ci)
    ctl.userData.on = false
    ctl.userData.hover = -1
    ctl.addEventListener('connected', e => { ctl.userData.on = true; ctl.userData.laser.visible = true; ctl.userData.src = e.data })
    ctl.addEventListener('disconnected', () => {
      ctl.userData.on = false
      ctl.userData.hover = -1
      ctl.userData.laser.visible = false
      if (ctl.userData.grab) { xrRig.attach(ctl.userData.grab); ctl.userData.grab = null }
    })
    ctl.addEventListener('selectstart', () => {
      if (ctl.userData.uiHit) pressVRUi(ctl.userData.uiHit)
      else if (ctl.userData.hover !== -1) {
        if (ctl.userData.hover === selected) approachSelected()
        else select(ctl.userData.hover)
      }
    })
    ctl.addEventListener('squeezestart', () => {
      if (ctl.userData.panelHit) {
        ctl.userData.grab = ctl.userData.panelHit
        ctl.attach(ctl.userData.grab)
      } else {
        deselect()
      }
    })
    ctl.addEventListener('squeezeend', () => {
      if (ctl.userData.grab) {
        xrRig.attach(ctl.userData.grab)
        ctl.userData.grab = null
      }
    })
    const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)])
    const laser = new THREE.Line(lg, new THREE.LineBasicMaterial({
      color: 0xffd307, transparent: true, opacity: 0.45,
      blending: THREE.AdditiveBlending, depthWrite: false
    }))
    laser.scale.z = 60
    laser.visible = false
    ctl.add(laser)
    ctl.userData.laser = laser
    xrRig.add(ctl)
    xrCtl.push(ctl)
  }

  if (navigator.xr && navigator.xr.isSessionSupported) {
    navigator.xr.isSessionSupported('immersive-vr').then(ok => {
      if (!ok) return
      import('/static/js/vendor/VRButton.js').then(m => {
        const btn = m.VRButton.createButton(renderer)
        Object.assign(btn.style, {
          position: 'absolute', left: 'auto', right: '10px', top: 'auto', bottom: '8px',
          width: 'auto', padding: '8px 10px', borderRadius: '0',
          border: '1px solid #262626', background: 'rgba(0,0,0,0.78)',
          color: '#757575', font: "9px 'JetBrains Mono', monospace",
          letterSpacing: '1.5px', opacity: '1', zIndex: '8'
        })
        wrap.appendChild(btn)
      }).catch(() => {})
    }).catch(() => {})
  }

  const orbitGroup = new THREE.Group()
  scene.add(orbitGroup)
  const ORBIT_RATE = 0.03
  let rotC = 1, rotS = 0
  const liveX = i => worldPos[i].x * rotC + worldPos[i].z * rotS
  const liveZ = i => -worldPos[i].x * rotS + worldPos[i].z * rotC

  {
    const n = 2200
    const pos = new Float32Array(n * 3)
    const sc = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const r = 420 + Math.random() * 380
      const th = Math.random() * Math.PI * 2
      const ph = Math.acos(2 * Math.random() - 1)
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th)
      pos[i * 3 + 1] = r * Math.cos(ph)
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th)
      sc[i] = 0.3 + Math.random() * 0.7
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aScale', new THREE.BufferAttribute(sc, 1))
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uDpr: { value: 1 } },
      vertexShader: `
        attribute float aScale; varying float vA;
        uniform float uDpr;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (1.0 + aScale * 1.6) * uDpr;
          vA = aScale;
        }`,
      fragmentShader: `
        varying float vA;
        void main(){
          float d = distance(gl_PointCoord, vec2(.5));
          float a = smoothstep(.5,.15,d) * (.16 + vA * .32);
          gl_FragColor = vec4(vec3(.75,.82,.95), a);
        }`
    })
    const stars = new THREE.Points(g, m)
    stars.renderOrder = 0
    scene.add(stars)
    scene.userData.starMat = m
  }

  const galaxyParams = {
    count: 200000, radius: 74, branches: 3,
    randomness: 0.5, randomnessPower: 3,
    inside: '#f0b466', outside: '#872f21'
  }
  const galaxyBaseAge = 500

  let galaxyMat
  {
    const { count, radius, branches, randomness, randomnessPower } = galaxyParams
    const pos = new Float32Array(count * 3)
    const col = new Float32Array(count * 3)
    const sc = new Float32Array(count)
    const rnd = new Float32Array(count * 3)
    const inC = new THREE.Color(galaxyParams.inside)
    const outC = new THREE.Color(galaxyParams.outside)

    for (let i = 0; i < count; i++) {
      const i3 = i * 3
      const r = Math.random() * radius
      const branchAngle = (i % branches) / branches * Math.PI * 2
      pos[i3] = Math.cos(branchAngle) * r
      pos[i3 + 1] = 0
      pos[i3 + 2] = Math.sin(branchAngle) * r

      const rx = Math.pow(Math.random(), randomnessPower) * (Math.random() < .5 ? 1 : -1) * randomness * r
      const rz = Math.pow(Math.random(), randomnessPower) * (Math.random() < .5 ? 1 : -1) * randomness * r
      const bulge = 0.32 + 1.15 * Math.exp(-r / 10)
      const ry = Math.pow(Math.random(), randomnessPower) * (Math.random() < .5 ? 1 : -1) * randomness * r * 0.5 * bulge
      rnd[i3] = rx; rnd[i3 + 1] = ry; rnd[i3 + 2] = rz

      const c = inC.clone().lerp(outC, r / radius)
      col[i3] = c.r; col[i3 + 1] = c.g; col[i3 + 2] = c.b
      sc[i] = Math.random()
    }

    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    g.setAttribute('aScale', new THREE.BufferAttribute(sc, 1))
    g.setAttribute('aRandomness', new THREE.BufferAttribute(rnd, 3))

    galaxyMat = new THREE.ShaderMaterial({
      depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true, transparent: true,
      uniforms: { uTime: { value: galaxyBaseAge }, uSize: { value: 600 }, uDim: { value: 1 } },
      vertexShader: `
        uniform float uSize; uniform float uTime;
        attribute float aScale; attribute vec3 aRandomness;
        varying vec3 vColor;
        void main(){
          vec4 mp = modelMatrix * vec4(position, 1.0);
          float angle = atan(mp.z, mp.x);
          float d = length(mp.xz);
          angle += (1.0 / max(d, 1.0)) * uTime;
          mp.x = cos(angle) * d;
          mp.z = sin(angle) * d;
          mp.xyz += aRandomness;
          vec4 vp = viewMatrix * mp;
          gl_Position = projectionMatrix * vp;
          gl_PointSize = uSize * (0.25 + aScale * 0.75);
          gl_PointSize *= (1.0 / -vp.z);
          vColor = color;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        uniform float uDim;
        void main(){
          float s = distance(gl_PointCoord, vec2(0.5));
          s = pow(1.0 - s, 8.0) * 0.85 * uDim;
          gl_FragColor = vec4(vColor * s, s);
        }`
    })
    const pts = new THREE.Points(g, galaxyMat)
    pts.renderOrder = 1
    orbitGroup.add(pts)
  }

  const ringMat = new THREE.LineBasicMaterial({ color: 0xffd307, transparent: true, opacity: 0.05 })
  for (const r of [10, 22, 34, 46, 60]) {
    const pts = new THREE.EllipseCurve(0, 0, r, r).getSpacedPoints(128)
    const g = new THREE.BufferGeometry().setFromPoints(pts).rotateX(Math.PI / 2)
    const ring = new THREE.LineLoop(g, ringMat)
    ring.renderOrder = 2
    scene.add(ring)
  }

  scene.add(new THREE.AmbientLight(0xffffff, 0.15))
  const coreLight = new THREE.PointLight(0xffd9a0, 55, 0, 1)
  coreLight.position.set(0, 0, 0)
  scene.add(coreLight)

  const positions = new Float32Array(N * 3)
  const colors = new Float32Array(N * 3)
  const spriteSizes = new Float32Array(N)
  const kinds = new Float32Array(N)
  const seeds = new Float32Array(N)
  const idxAttr = new Float32Array(N)
  const worldPos = []
  const worldSize = new Float32Array(N)

  for (let i = 0; i < N; i++) {
    const p = DATA[i]
    const h = hash(p.n)
    const y = (h - 0.5) * 1.1
    positions[i * 3] = p.x
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = p.z
    worldPos.push(new THREE.Vector3(p.x, y, p.z))

    const k = kindOf(p)
    kinds[i] = k
    seeds[i] = h
    idxAttr[i] = i
    worldSize[i] = sizeOf(p)
    spriteSizes[i] = p.th ? 0
      : k === KIND_BLOB ? worldSize[i] * 3.2
      : worldSize[i] * 1.35

    let c
    if (k === KIND_BLOB) c = COL.nebula
    else if (k === KIND_DIAMOND) c = COL.station
    else if (k === KIND_RING) c = COL.blackhole
    else if (isFeatured(p)) c = COL.featured
    else if (p.i && p.i !== 'normal') c = COL.planetAlt
    else c = COL.planet
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b
  }

  const planetGeo = new THREE.BufferGeometry()
  planetGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  planetGeo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3))
  planetGeo.setAttribute('aSize', new THREE.BufferAttribute(spriteSizes, 1))
  planetGeo.setAttribute('aKind', new THREE.BufferAttribute(kinds, 1))
  planetGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
  planetGeo.setAttribute('aIdx', new THREE.BufferAttribute(idxAttr, 1))

  const planetUniforms = {
    uPxScale: { value: 1 },
    uMinPx: { value: 3.5 },
    uMaxPx: { value: 34.0 },
    uTime: { value: 0 },
    uDim: { value: 1 },
    uSelIdx: { value: -1 }
  }

  const planetVert = `
    attribute vec3 aColor; attribute float aSize; attribute float aKind; attribute float aSeed; attribute float aIdx;
    uniform float uPxScale; uniform float uMinPx; uniform float uMaxPx; uniform float uTime;
    uniform float uDim; uniform float uSelIdx;
    varying vec3 vColor; varying float vKind; varying float vTw; varying float vDim;
    void main(){
      if (aSize <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); vKind = 0.0; vTw = 0.0; vDim = 0.0; return; }
      vec4 vp = viewMatrix * modelMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * vp;
      float px = aSize * uPxScale / -vp.z;
      float lo = uMinPx * (aKind == 1.0 ? 3.0 : 1.0);
      float hi = uMaxPx * (aKind == 1.0 ? 2.2 : 1.0);
      px = clamp(px, lo, hi);
      gl_PointSize = px;
      vColor = aColor;
      vKind = aKind;
      vTw = 0.9 + 0.1 * sin(uTime * 1.7 + aSeed * 6.2831);
      vDim = (abs(aIdx - uSelIdx) < 0.5) ? 1.0 : uDim;
    }`

  const planetFrag = `
    varying vec3 vColor; varying float vKind; varying float vTw; varying float vDim;
    void main(){
      vec2 uv = gl_PointCoord - 0.5;
      float r = length(uv) * 2.0;
      float aa = fwidth(r) * 1.2;
      float alpha; vec3 col = vColor;

      if (vKind < 0.5) {
        float core = 1.0 - smoothstep(0.62 - aa, 0.62 + aa, r);
        float halo = exp(-r * 3.0) * 0.42;
        alpha = max(core, halo) * vTw;
        col = mix(vColor * 0.5, vColor, core);
        col += vColor * core * 0.22 * (1.0 - r * 1.4);
      } else if (vKind < 1.5) {
        alpha = exp(-r * r * 3.2) * 0.34 * vTw;
      } else if (vKind < 2.5) {
        float m = (abs(uv.x) + abs(uv.y)) * 2.0;
        alpha = 1.0 - smoothstep(0.58 - aa, 0.58 + aa, m);
      } else {
        float rim = smoothstep(0.30, 0.46, r) * (1.0 - smoothstep(0.60 - aa, 0.60 + aa, r));
        float core = 1.0 - smoothstep(0.30 - aa, 0.30 + aa, r);
        alpha = max(rim, core * 0.92);
        col = mix(vec3(0.01), vColor, rim);
      }
      alpha *= vDim;
      if (alpha < 0.004) discard;
      gl_FragColor = vec4(col, alpha);
    }`

  const planetMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: planetUniforms, vertexShader: planetVert, fragmentShader: planetFrag
  })
  const planetPoints = new THREE.Points(planetGeo, planetMat)
  planetPoints.renderOrder = 3
  orbitGroup.add(planetPoints)

  const texLoader = new THREE.TextureLoader()
  const texturedMeshes = []
  for (let i = 0; i < N; i++) {
    const p = DATA[i]
    if (!p.th) continue
    const tex = texLoader.load(`/static/imgs/planets/${encodeURIComponent(p.th)}_tex.webp`)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 4
    const mat = new THREE.MeshLambertMaterial({ map: tex, transparent: true })
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(worldSize[i], 40, 26), mat)
    mesh.position.copy(worldPos[i])
    mesh.rotation.z = 0.1 + seeds[i] * 0.3
    mesh.renderOrder = 3
    mesh.userData.idx = i
    orbitGroup.add(mesh)
    texturedMeshes.push(mesh)
  }

  const isJediFlagged = p => hash(p.n + ':jedi') < 0.05
  const jediSet = new Set()
  for (let i = 0; i < N; i++) if (isJediFlagged(DATA[i])) jediSet.add(i)

  const makeMarker = (color, isSelect) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
        uniforms: {
          uTime: { value: 0 },
          uColor: { value: new THREE.Color(color) },
          uSelect: { value: isSelect ? 1.0 : 0.0 }
        },
        vertexShader: `
          varying vec2 vUv;
          void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `
          uniform vec3 uColor; uniform float uTime; uniform float uSelect;
          varying vec2 vUv;
          void main(){
            vec2 uv = vUv - 0.5;
            float r = length(uv) * 2.0;
            float aa = fwidth(r) * 1.5;
            float ring = smoothstep(0.66 - aa, 0.66, r) * (1.0 - smoothstep(0.76, 0.76 + aa, r));
            float a = ring * 0.9;
            if (uSelect > 0.5) {
              float ang = atan(uv.y, uv.x) + uTime * 0.8;
              float ticks = step(0.72, abs(sin(ang * 2.0)));
              a = ring * (0.35 + 0.65 * ticks);
              a += (1.0 - smoothstep(0.02, 0.10, abs(r - 0.92))) * 0.25 * (0.6 + 0.4 * sin(uTime * 2.4));
            }
            if (a < 0.01) discard;
            gl_FragColor = vec4(uColor, a);
          }`
      })
    )
    m.renderOrder = 4
    m.visible = false
    m.userData.idx = -1
    scene.add(m)
    return m
  }
  const hoverMarker = makeMarker('#ffffff', false)
  const selectMarker = makeMarker('#ffd307', true)

  const placeMarker = (marker, idx) => {
    marker.userData.idx = idx
    marker.visible = true
  }

  let W = 2, H = 2, pickScale = 1
  const resize = () => {
    W = wrap.clientWidth; H = wrap.clientHeight
    const dpr = DPR()
    renderer.setPixelRatio(dpr)
    renderer.setSize(W, H, false)
    camera.aspect = W / H
    camera.updateProjectionMatrix()
    pickScale = H / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))
    planetUniforms.uPxScale.value = pickScale * dpr
    planetUniforms.uMinPx.value = 3.5 * dpr
    planetUniforms.uMaxPx.value = 34.0 * dpr
    galaxyMat.uniforms.uSize.value = H * dpr * 2.1
    scene.userData.starMat.uniforms.uDpr.value = dpr
  }
  new ResizeObserver(resize).observe(wrap)
  resize()

  const Y_AXIS = new THREE.Vector3(0, 1, 0)
  let tween = null
  const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
  const flyTo = (pos, tgt, dur, follow) => {
    tween = {
      p0: camera.position.clone(), p1: pos.clone(),
      t0: controls.target.clone(), t1: tgt.clone(),
      p1o: pos.clone(), t1o: tgt.clone(),
      rot0: orbitGroup.rotation.y, follow: !!follow,
      start: null, dur
    }
    controls.enabled = false
  }
  const stepTween = now => {
    if (!tween) return
    if (tween.start === null) tween.start = now
    if (tween.follow) {
      const rotDelta = orbitGroup.rotation.y - tween.rot0
      tween.p1.copy(tween.p1o).applyAxisAngle(Y_AXIS, rotDelta)
      tween.t1.copy(tween.t1o).applyAxisAngle(Y_AXIS, rotDelta)
    }
    const k = Math.min((now - tween.start) / tween.dur, 1)
    const e = easeInOut(k)
    camera.position.lerpVectors(tween.p0, tween.p1, e)
    controls.target.lerpVectors(tween.t0, tween.t1, e)
    if (k >= 1) { tween = null; controls.enabled = true }
  }

  const ndc = new THREE.Vector2()
  const proj = new THREE.Vector3()
  let hovered = -1
  let selected = -1

  const pick = (mx, my) => {
    let best = -1, bestScore = 0
    const cp = camera.position
    for (let i = 0; i < N; i++) {
      const lx = liveX(i), ly = worldPos[i].y, lz = liveZ(i)
      proj.set(lx, ly, lz).project(camera)
      if (proj.z > 1) continue
      const sx = (proj.x * 0.5 + 0.5) * W
      const sy = (-proj.y * 0.5 + 0.5) * H
      const dx = sx - mx, dy = sy - my
      const d = Math.sqrt(dx * dx + dy * dy)
      const dc = Math.sqrt((lx - cp.x) ** 2 + (ly - cp.y) ** 2 + (lz - cp.z) ** 2)
      const rPx = worldSize[i] * pickScale / Math.max(dc, 0.001)
      const score = d - Math.max(12, rPx + 6)
      if (score < bestScore) { bestScore = score; best = i }
    }
    return best
  }

  const screenXY = idx => {
    proj.set(liveX(idx), worldPos[idx].y, liveZ(idx)).project(camera)
    return [(proj.x * 0.5 + 0.5) * W, (-proj.y * 0.5 + 0.5) * H]
  }

  const tooltip = document.getElementById('gxTooltip')
  const panel = document.getElementById('planetPanel')
  const hudCoords = document.getElementById('gxCoords')
  const loading = document.getElementById('gxLoading')
  const resetBtn = document.getElementById('gxReset')
  const searchInput = document.getElementById('gxSearchInput')
  const searchList = document.getElementById('gxSearchList')

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const fmtGrid = p => `${p.x >= 0 ? '+' : ''}${p.x.toFixed(1)} / ${p.z >= 0 ? '+' : ''}${p.z.toFixed(1)}`

  const sectorOf = p => {
    const r = Math.hypot(p.x, p.z)
    if (r < 10) return 'DEEP CORE'
    if (r < 22) return 'CORE WORLDS'
    if (r < 34) return 'INNER RIM'
    if (r < 46) return 'MID RIM'
    return 'OUTER RIM'
  }
  const sectorCode = p =>
    'S-' + String(Math.floor(((Math.atan2(p.z, p.x) + Math.PI) / (2 * Math.PI)) * 12) % 12 + 1).padStart(2, '0')

  const kindLabel = p => {
    if (p.t) return p.t.toUpperCase()
    const i = p.i || ''
    if (i.startsWith('nebula')) return 'NEBULA'
    if (i.startsWith('phenom')) return 'PHENOMENON'
    if (i.startsWith('clustr')) return 'STAR CLUSTER'
    if (i.startsWith('staton')) return 'STATION'
    if (i.startsWith('blkhle')) return 'SINGULARITY'
    return 'STAR SYSTEM'
  }

  const showTooltip = idx => {
    const p = DATA[idx]
    const [sx, sy] = screenXY(idx)
    tooltip.innerHTML = `<span class="tt-name">${esc(p.n)}</span><span class="tt-sub">${kindLabel(p)}${isFeatured(p) ? ' · ARCHIVED' : ''}</span>`
    tooltip.style.display = 'block'
    const r = tooltip.getBoundingClientRect()
    let x = sx + 14, y = sy - r.height - 10
    if (x + r.width > W - 8) x = sx - r.width - 14
    if (y < 8) y = sy + 14
    tooltip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  }
  const hideTooltip = () => { tooltip.style.display = 'none' }

  const row = (label, val, cls) => val ? `<div class="pp-row"><span>${label}</span><b${cls ? ` class="${cls}"` : ''}>${esc(val)}</b></div>` : ''

  let reportsByLoc = new Map()
  const idxByName = new Map(DATA.map((p, i) => [p.n.toLowerCase(), i]))
  fetch('/api/reports').then(r => r.ok ? r.json() : []).then(list => {
    for (const r of list) {
      const k = (r.location || '').trim().toLowerCase()
      if (!k) continue
      if (!reportsByLoc.has(k)) reportsByLoc.set(k, [])
      reportsByLoc.get(k).push(r)
      if ((r.type || '').toUpperCase().includes('JEDI') && idxByName.has(k)) {
        jediSet.add(idxByName.get(k))
      }
    }
  }).catch(() => {})

  const jediStatus = (p, reps) => {
    if (reps.some(r => (r.type || '').toUpperCase().includes('JEDI')))
      return { txt: 'SIGHTING LOGGED - CITIZEN REPORT', cls: 'alert' }
    if (isJediFlagged(p)) return { txt: 'SIGHTING LOGGED', cls: 'alert' }
    if (hash(p.n + ':jedi') < 0.15) return { txt: 'UNDER REVIEW', cls: 'warn' }
    return { txt: 'NONE REPORTED', cls: '' }
  }

  const vrPanel = {}
  {
    const cv = document.createElement('canvas')
    cv.width = 512
    cv.height = 680
    vrPanel.ctx = cv.getContext('2d')
    vrPanel.tex = new THREE.CanvasTexture(cv)
    vrPanel.tex.colorSpace = THREE.SRGBColorSpace
    vrPanel.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 0.66),
      new THREE.MeshBasicMaterial({ map: vrPanel.tex, transparent: true })
    )
    vrPanel.mesh.position.set(0.62, 1.35, -0.85)
    vrPanel.mesh.rotation.y = -0.4
    vrPanel.mesh.visible = false
    vrPanel.mesh.renderOrder = 6
    xrRig.add(vrPanel.mesh)
  }

  const drawVRPanel = idx => {
    const p = DATA[idx]
    const g = vrPanel.ctx
    const hot = jediSet.has(idx)
    const ac = hot ? '#ff5147' : '#ffd307'
    const mono = s => s + "px 'JetBrains Mono', monospace"
    g.clearRect(0, 0, 512, 680)
    g.fillStyle = 'rgba(4, 4, 4, 0.94)'
    g.fillRect(0, 0, 512, 680)
    g.strokeStyle = hot ? 'rgba(255, 69, 58, 0.8)' : 'rgba(255, 211, 7, 0.55)'
    g.lineWidth = 2
    g.strokeRect(1, 1, 510, 678)
    g.fillStyle = ac
    g.fillRect(5, 5, 6, 6)
    g.fillRect(501, 669, 6, 6)
    g.fillStyle = '#757575'
    g.font = mono(15)
    g.fillText('// SYSTEM RECORD', 24, 44)
    g.fillStyle = ac
    g.font = 'bold ' + mono(28)
    g.fillText(p.n.toUpperCase().slice(0, 26), 24, 84)
    g.fillStyle = '#9a9a9a'
    g.font = mono(14)
    g.fillText('GRID ' + fmtGrid(p) + '   ' + sectorOf(p) + ' - ' + sectorCode(p), 24, 112)
    const reps = reportsByLoc.get(p.n.toLowerCase()) || []
    const jedi = jediStatus(p, reps)
    let y = 154
    const row = (k, v, vc) => {
      if (!v) return
      g.font = mono(15)
      g.fillStyle = '#757575'
      g.fillText(k, 24, y)
      g.fillStyle = vc || '#ffffff'
      g.fillText(String(v).slice(0, 22), 226, y)
      y += 30
    }
    row('TYPE', kindLabel(p))
    row('ATMOSPHERE', p.a)
    row('DIAMETER', p.d ? p.d.toLocaleString('en-US') + ' KM' : '')
    row('MOONS', p.m)
    row('STARS', p.st)
    row('JEDI ACTIVITY', jedi.txt, jedi.cls === 'alert' ? '#ff5147' : jedi.cls === 'warn' ? '#ffe9a8' : '#ffffff')
    if (reps.length) row('CITIZEN REPORTS', reps.length + ' ON FILE', '#ff5147')
    y += 10
    if (p.de) {
      g.fillStyle = '#757575'
      g.font = mono(14)
      g.fillText('ARCHIVE ENTRY', 24, y)
      y += 26
      g.fillStyle = '#c9c9c9'
      g.font = mono(14)
      const words = p.de.split(' ')
      let line = ''
      for (const w of words) {
        const test = line ? line + ' ' + w : w
        if (g.measureText(test).width > 464 && line) {
          g.fillText(line, 24, y)
          y += 22
          if (y > 648) { line = '...'; break }
          line = w
        } else {
          line = test
        }
      }
      if (line && y <= 660) g.fillText(line, 24, y)
    } else {
      g.fillStyle = '#757575'
      g.font = mono(14)
      g.fillText('NO ARCHIVE RECORD ON FILE. SURVEY PENDING.', 24, y)
    }
    g.fillStyle = '#555555'
    g.font = mono(10)
    const hint = 'TRIGGER PLANET AGAIN: FLY TO IT  ·  GRIP: MOVE PANEL'
    g.fillText(hint, 256 - g.measureText(hint).width / 2, 664)
    vrPanel.tex.needsUpdate = true
  }

  const vrSearch = { q: '', results: [], hover: null }
  const vrKeys = []
  {
    const rows = [
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
      ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
      ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', '-'],
      ['Z', 'X', 'C', 'V', 'B', 'N', 'M', '\'', '.']
    ]
    rows.forEach((r, ri) => {
      const x0 = (512 - (r.length * 46 - 2)) / 2
      r.forEach((ch, i) => vrKeys.push({ ch, x: x0 + i * 46, y: 352 + ri * 58, w: 44, h: 52 }))
    })
    vrKeys.push({ ch: ' ', x: 26, y: 584, w: 230, h: 52, label: 'SPACE' })
    vrKeys.push({ ch: 'DEL', x: 262, y: 584, w: 110, h: 52 })
    vrKeys.push({ ch: 'CLR', x: 378, y: 584, w: 110, h: 52 })
  }

  const vrSearchPanel = {}
  {
    const cv = document.createElement('canvas')
    cv.width = 512
    cv.height = 680
    vrSearchPanel.ctx = cv.getContext('2d')
    vrSearchPanel.tex = new THREE.CanvasTexture(cv)
    vrSearchPanel.tex.colorSpace = THREE.SRGBColorSpace
    vrSearchPanel.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 0.66),
      new THREE.MeshBasicMaterial({ map: vrSearchPanel.tex, transparent: true })
    )
    vrSearchPanel.mesh.position.set(-0.62, 1.35, -0.85)
    vrSearchPanel.mesh.rotation.y = 0.4
    vrSearchPanel.mesh.visible = false
    vrSearchPanel.mesh.renderOrder = 6
    xrRig.add(vrSearchPanel.mesh)
  }

  const runVRSearch = () => {
    const q = vrSearch.q.trim().toLowerCase()
    const starts = [], contains = []
    if (q) {
      for (let i = 0; i < N; i++) {
        const ix = lowerNames[i].indexOf(q)
        if (ix === 0) starts.push(i)
        else if (ix > 0) contains.push(i)
        if (starts.length >= 5) break
      }
    }
    vrSearch.results = starts.concat(contains).slice(0, 5)
  }

  const drawVRSearch = () => {
    const g = vrSearchPanel.ctx
    const mono = s => s + "px 'JetBrains Mono', monospace"
    g.clearRect(0, 0, 512, 680)
    g.fillStyle = 'rgba(4, 4, 4, 0.94)'
    g.fillRect(0, 0, 512, 680)
    g.strokeStyle = 'rgba(255, 211, 7, 0.55)'
    g.lineWidth = 2
    g.strokeRect(1, 1, 510, 678)
    g.fillStyle = '#ffd307'
    g.fillRect(5, 5, 6, 6)
    g.fillRect(501, 669, 6, 6)
    g.fillStyle = '#757575'
    g.font = mono(15)
    g.fillText('// SEARCH SYSTEM', 24, 40)
    g.strokeStyle = 'rgba(255, 211, 7, 0.4)'
    g.lineWidth = 1
    g.strokeRect(24, 56, 464, 44)
    g.fillStyle = '#ffd307'
    g.font = mono(20)
    g.fillText(vrSearch.q + '_', 36, 85)
    let y = 124
    vrSearch.results.forEach((idx, r) => {
      const hov = vrSearch.hover === 'r' + r
      if (hov) { g.fillStyle = '#ffd307'; g.fillRect(24, y, 464, 38) }
      g.fillStyle = hov ? '#000000' : '#ffffff'
      g.font = mono(16)
      g.fillText(DATA[idx].n.toUpperCase().slice(0, 24), 34, y + 26)
      g.fillStyle = hov ? 'rgba(0, 0, 0, 0.6)' : '#757575'
      g.font = mono(11)
      g.fillText(sectorOf(DATA[idx]), 366, y + 25)
      y += 40
    })
    if (!vrSearch.results.length && vrSearch.q) {
      g.fillStyle = '#757575'
      g.font = mono(14)
      g.fillText('NO SYSTEMS MATCH', 34, 148)
    }
    for (const k of vrKeys) {
      const hov = vrSearch.hover === 'k' + k.ch
      if (hov) {
        g.fillStyle = '#ffd307'
        g.fillRect(k.x, k.y, k.w, k.h)
      } else {
        g.strokeStyle = '#3a3a3a'
        g.lineWidth = 1
        g.strokeRect(k.x + 0.5, k.y + 0.5, k.w - 1, k.h - 1)
      }
      g.fillStyle = hov ? '#000000' : '#e8e8e8'
      g.font = mono(16)
      const label = k.label || k.ch
      g.fillText(label, k.x + k.w / 2 - g.measureText(label).width / 2, k.y + k.h / 2 + 6)
    }
    g.fillStyle = '#555555'
    g.font = mono(10)
    const hint = 'HOLD GRIP TO MOVE'
    g.fillText(hint, 256 - g.measureText(hint).width / 2, 664)
    vrSearchPanel.tex.needsUpdate = true
  }

  const vrUiRegion = uv => {
    const x = uv.x * 512
    const y = (1 - uv.y) * 680
    for (let r = 0; r < vrSearch.results.length; r++) {
      if (y >= 124 + r * 40 && y < 164 + r * 40 && x >= 24 && x <= 488) return { type: 'row', row: r, id: 'r' + r }
    }
    for (const k of vrKeys) {
      if (x >= k.x && x <= k.x + k.w && y >= k.y && y <= k.y + k.h) return { type: 'key', key: k, id: 'k' + k.ch }
    }
    return null
  }

  const pressVRUi = ui => {
    if (ui.type === 'row') {
      const idx = vrSearch.results[ui.row]
      if (idx != null) select(idx)
      return
    }
    const ch = ui.key.ch
    if (ch === 'DEL') vrSearch.q = vrSearch.q.slice(0, -1)
    else if (ch === 'CLR') vrSearch.q = ''
    else if (vrSearch.q.length < 20) vrSearch.q += ch
    runVRSearch()
    drawVRSearch()
  }

  const MODE = wrap.dataset.mode === 'picker' ? 'picker' : 'full'

  const openPanel = idx => {
    const p = DATA[idx]
    const reps = reportsByLoc.get(p.n.toLowerCase()) || []
    const jedi = jediStatus(p, reps)

    const head = `
      <div class="pp-head">
        <div>
          <div class="pp-kicker">${MODE === 'picker' ? '// TARGET SYSTEM' : '// SYSTEM RECORD'}</div>
          <div class="pp-name">${esc(p.n)}</div>
          <div class="pp-grid">GRID ${fmtGrid(p)}${MODE === 'picker' ? ' &middot; ' + sectorOf(p) : ''}</div>
        </div>
        <button class="pp-close" id="ppClose" title="Close record">&#10005;</button>
      </div>`

    if (MODE === 'picker') {
      panel.innerHTML = `
        ${head}
        <button class="pp-select-btn" id="ppSelect">&#9658; SET AS INCIDENT LOCATION</button>
      `
      document.getElementById('ppSelect').addEventListener('click', () => {
        const inp = document.querySelector('input[name="location"]')
        if (inp) {
          inp.value = p.n.toUpperCase()
          inp.dispatchEvent(new Event('input', { bubbles: true }))
          inp.classList.add('gx-flash')
          setTimeout(() => inp.classList.remove('gx-flash'), 1400)
        }
        const sec = document.querySelector('input[name="sector"]')
        if (sec) sec.value = sectorOf(p)
        const b = document.getElementById('ppSelect')
        b.textContent = 'LOCATION LOGGED'
        b.classList.add('done')
      })
    } else {
      panel.innerHTML = `
        ${head}
        ${p.th ? `<div class="pp-img"><img src="/static/imgs/planets/${encodeURIComponent(p.th)}.webp" alt="${esc(p.n)}"></div>` : ''}
        <div class="pp-badges">
          <i class="pp-badge pp-badge-dim">${kindLabel(p)}</i>
          ${isFeatured(p) ? '<i class="pp-badge">IMPERIAL ARCHIVE</i>' : ''}
        </div>
        <div class="pp-rows">
          ${row('SECTOR', `${sectorOf(p)} · ${sectorCode(p)}`)}
          ${row('ATMOSPHERE', p.a)}
          ${row('DIAMETER', p.d ? p.d.toLocaleString('en-US') + ' KM' : '')}
          ${row('MOONS', p.m)}
          ${row('STARS', p.st)}
          ${row('JEDI ACTIVITY', jedi.txt, jedi.cls)}
          ${reps.length ? row('CITIZEN REPORTS', reps.length + ' ON FILE', 'alert') : ''}
          ${reps.length ? row('LATEST REPORT', `${reps[0].type || 'UNKNOWN'} [${reps[0].status || 'UNVERIFIED'}]`) : ''}
        </div>
        ${p.de || (p.sections && p.sections.length)
          ? `<div class="pp-desc">
              <div class="pp-desc-label">ARCHIVE ENTRY</div>
              <div class="pp-desc-body">
                ${p.de ? `<p>${esc(p.de)}</p>` : ''}
                ${(p.sections || []).map(s => `<div class="pp-desc-label pp-sub">${esc(s.title)}</div><p>${esc(s.text)}</p>`).join('')}
              </div>
            </div>`
          : '<div class="pp-empty">NO ARCHIVE RECORD ON FILE.<br>SURVEY PENDING.</div>'}
      `
    }
    panel.classList.toggle('jedi', jediSet.has(idx))
    panel.classList.add('open')
    document.getElementById('ppClose').addEventListener('click', deselect)
  }
  const closePanel = () => panel.classList.remove('open')

  const select = idx => {
    selected = idx
    hovered = -1
    hideTooltip()
    hoverMarker.visible = false
    selectMarker.material.uniforms.uColor.value.set(jediSet.has(idx) ? '#ff453a' : '#ffd307')
    placeMarker(selectMarker, idx)
    openPanel(idx)
    drawVRPanel(idx)

    if (!renderer.xr.isPresenting) {
      const target = new THREE.Vector3(liveX(idx), worldPos[idx].y, liveZ(idx))
      const dir = camera.position.clone().sub(controls.target).normalize()
      const dist = Math.max(worldSize[idx] * 4.2, 2.4)
      const pos = target.clone().add(dir.multiplyScalar(dist)).add(new THREE.Vector3(0, dist * 0.3, 0))
      flyTo(pos, target, 1.25, true)
    }
  }

  const deselect = () => {
    if (selected === -1) return
    selected = -1
    selectMarker.visible = false
    closePanel()
    if (!renderer.xr.isPresenting) flyTo(HOME_POS, HOME_TGT, 1.4)
  }

  const approachSelected = () => {
    if (selected === -1 || !renderer.xr.isPresenting) return
    const target = new THREE.Vector3(liveX(selected), worldPos[selected].y, liveZ(selected))
    const dir = target.clone().sub(camW).normalize()
    const standoff = Math.max(worldSize[selected] * 6, 2.5)
    const delta = target.sub(dir.multiplyScalar(standoff)).sub(camW)
    vrGlide = {
      from: xrRig.position.clone(),
      to: xrRig.position.clone().add(delta),
      start: clock.getElapsedTime(),
      dur: 1.2
    }
  }
  resetBtn.addEventListener('click', () => { selected === -1 ? flyTo(HOME_POS, HOME_TGT, 1.2) : deselect() })
  window.addEventListener('keydown', e => { if (e.key === 'Escape') { deselect(); searchList.classList.remove('open') } })

  let downX = 0, downY = 0, moved = false
  const localXY = e => {
    const r = canvas.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  canvas.addEventListener('pointerdown', e => { [downX, downY] = localXY(e); moved = false })
  canvas.addEventListener('pointermove', e => {
    const [x, y] = localXY(e)
    if (Math.abs(x - downX) + Math.abs(y - downY) > 5) moved = true
    if (e.buttons) { hideTooltip(); return }
    const idx = pick(x, y)
    hovered = idx
    if (idx !== -1 && idx !== selected) {
      canvas.style.cursor = 'pointer'
      placeMarker(hoverMarker, idx)
      showTooltip(idx)
    } else {
      canvas.style.cursor = 'grab'
      hoverMarker.visible = false
      hideTooltip()
    }
    ndc.set((x / W) * 2 - 1, -(y / H) * 2 + 1)
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, camera)
    const t = -ray.ray.origin.y / (ray.ray.direction.y || 1e-9)
    if (t > 0) {
      const wx = ray.ray.origin.x + ray.ray.direction.x * t
      const wz = ray.ray.origin.z + ray.ray.direction.z * t
      const gx = wx * rotC - wz * rotS
      const gz = wx * rotS + wz * rotC
      hudCoords.textContent = `X ${gx >= 0 ? '+' : ''}${gx.toFixed(1)}  Z ${gz >= 0 ? '+' : ''}${gz.toFixed(1)}`
    }
  })
  canvas.addEventListener('pointerleave', () => { hoverMarker.visible = false; hideTooltip() })
  canvas.addEventListener('pointerup', e => {
    if (moved || e.button !== 0) return
    const [x, y] = localXY(e)
    const idx = pick(x, y)
    if (idx !== -1) select(idx)
    else if (selected !== -1) deselect()
  })

  const lowerNames = DATA.map(p => p.n.toLowerCase())
  let activeResult = -1
  let results = []

  const renderResults = () => {
    if (!results.length) { searchList.classList.remove('open'); return }
    searchList.innerHTML = results.map((idx, i) =>
      `<li data-idx="${idx}" class="${i === activeResult ? 'active' : ''}">
        <span>${esc(DATA[idx].n)}</span><em>${fmtGrid(DATA[idx])}</em>
      </li>`).join('')
    searchList.classList.add('open')
    searchList.querySelectorAll('li').forEach(li =>
      li.addEventListener('pointerdown', e => { e.preventDefault(); commitSearch(+li.dataset.idx) }))
  }

  const runSearch = q => {
    q = q.trim().toLowerCase()
    activeResult = -1
    if (q.length < 1) { results = []; renderResults(); return }
    const starts = [], contains = []
    for (let i = 0; i < N; i++) {
      const ix = lowerNames[i].indexOf(q)
      if (ix === 0) starts.push(i)
      else if (ix > 0) contains.push(i)
      if (starts.length >= 8) break
    }
    results = starts.concat(contains).slice(0, 8)
    renderResults()
  }

  const commitSearch = idx => {
    searchList.classList.remove('open')
    searchInput.value = DATA[idx].n
    searchInput.blur()
    select(idx)
  }

  searchInput.addEventListener('input', () => runSearch(searchInput.value))
  searchInput.addEventListener('focus', () => runSearch(searchInput.value))
  searchInput.addEventListener('blur', () => setTimeout(() => searchList.classList.remove('open'), 150))
  searchInput.addEventListener('keydown', e => {
    if (!results.length) return
    if (e.key === 'ArrowDown') { e.preventDefault(); activeResult = (activeResult + 1) % results.length; renderResults() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeResult = (activeResult - 1 + results.length) % results.length; renderResults() }
    else if (e.key === 'Enter') { e.preventDefault(); commitSearch(results[activeResult === -1 ? 0 : activeResult]) }
  })

  let dimT = 0
  let lastFrameT = 0
  let vrGlide = null
  const followPos = new THREE.Vector3()
  const followDelta = new THREE.Vector3()
  const camW = new THREE.Vector3()
  const camWQ = new THREE.Quaternion()
  const rayO = new THREE.Vector3()
  const rayD = new THREE.Vector3()
  const xrQ = new THREE.Quaternion()
  const xrV = new THREE.Vector3()
  const vrRay = new THREE.Raycaster()
  const frame = t => {

    orbitGroup.rotation.y = -t * ORBIT_RATE
    rotC = Math.cos(orbitGroup.rotation.y)
    rotS = Math.sin(orbitGroup.rotation.y)
    galaxyMat.uniforms.uTime.value = galaxyBaseAge + t * 0.8
    planetUniforms.uTime.value = t

    const dimTarget = selected !== -1 ? 1 : 0
    dimT += (dimTarget - dimT) * 0.07
    galaxyMat.uniforms.uDim.value = 1 - dimT * 0.87
    planetUniforms.uDim.value = 1 - dimT * 0.75
    planetUniforms.uSelIdx.value = selected
    ringMat.opacity = 0.05 * (1 - dimT * 0.9)
    for (const mesh of texturedMeshes) {
      mesh.rotation.y = t * 0.12 + seeds[mesh.userData.idx] * 6.28
      mesh.material.opacity = mesh.userData.idx === selected ? 1 : 1 - dimT * 0.82
    }

    camera.getWorldPosition(camW)
    camera.getWorldQuaternion(camWQ)

    const dt = Math.min(Math.max(t - lastFrameT, 0), 0.05)
    lastFrameT = t

    if (renderer.xr.isPresenting) {
      if (!vrSearchPanel.mesh.visible) { vrSearchPanel.mesh.visible = true; drawVRSearch() }

      if (vrGlide) {
        const gk = Math.min((t - vrGlide.start) / vrGlide.dur, 1)
        xrRig.position.lerpVectors(vrGlide.from, vrGlide.to, easeInOut(gk))
        if (gk >= 1) vrGlide = null
      }

      let fly = 0, flyCtl = null
      for (const ctl of xrCtl) {
        const src = ctl.userData.src
        const gp = src && src.gamepad
        if (!gp || !ctl.userData.on || gp.axes.length < 2) continue
        const y1 = gp.axes[1] || 0
        const y2 = gp.axes.length >= 4 ? (gp.axes[3] || 0) : 0
        const ay = Math.abs(y2) > Math.abs(y1) ? y2 : y1
        if (Math.abs(ay) > 0.15 && Math.abs(ay) > Math.abs(fly)) { fly = ay; flyCtl = ctl }
        if (src.handedness === 'right') {
          const x1 = gp.axes[0] || 0
          const x2 = gp.axes.length >= 4 ? (gp.axes[2] || 0) : 0
          const axv = Math.abs(x2) > Math.abs(x1) ? x2 : x1
          if (Math.abs(axv) > 0.6 && !ctl.userData.turned) {
            ctl.userData.turned = true
            const delta = axv > 0 ? -Math.PI / 6 : Math.PI / 6
            const cos = Math.cos(delta), sin = Math.sin(delta)
            const px = xrRig.position.x - camW.x, pz = xrRig.position.z - camW.z
            xrRig.position.x = camW.x + px * cos + pz * sin
            xrRig.position.z = camW.z - px * sin + pz * cos
            xrRig.rotation.y += delta
          } else if (Math.abs(axv) < 0.3) {
            ctl.userData.turned = false
          }
        }
      }
      if (flyCtl) {
        vrGlide = null
        flyCtl.getWorldQuaternion(xrQ)
        rayD.set(0, 0, -1).applyQuaternion(xrQ)
        xrRig.position.addScaledVector(rayD, -fly * Math.abs(fly) * 26 * dt)
        if (xrRig.position.length() > 500) xrRig.position.setLength(500)
      }

      let xrHover = -1
      let uiHover = null
      for (const ctl of xrCtl) {
        if (!ctl.userData.on) { ctl.userData.hover = -1; ctl.userData.uiHit = null; ctl.userData.panelHit = null; continue }
        if (ctl.userData.grab) {
          ctl.userData.hover = -1
          ctl.userData.uiHit = null
          ctl.userData.panelHit = null
          ctl.userData.laser.scale.z = 0.2
          ctl.userData.laser.material.opacity = 0.25
          continue
        }
        ctl.getWorldPosition(rayO)
        ctl.getWorldQuaternion(xrQ)
        rayD.set(0, 0, -1).applyQuaternion(xrQ).normalize()
        vrRay.set(rayO, rayD)
        let panelMesh = null, panelDist = Infinity, uiRegion = null
        const sHits = vrSearchPanel.mesh.visible ? vrRay.intersectObject(vrSearchPanel.mesh, false) : []
        if (sHits.length) {
          panelMesh = vrSearchPanel.mesh
          panelDist = sHits[0].distance
          if (sHits[0].uv) uiRegion = vrUiRegion(sHits[0].uv)
        }
        const rHits = vrPanel.mesh.visible ? vrRay.intersectObject(vrPanel.mesh, false) : []
        if (rHits.length && rHits[0].distance < panelDist) {
          panelMesh = vrPanel.mesh
          panelDist = rHits[0].distance
          uiRegion = null
        }
        ctl.userData.panelHit = panelMesh
        if (panelMesh) {
          ctl.userData.uiHit = uiRegion
          ctl.userData.hover = -1
          ctl.userData.laser.scale.z = panelDist
          ctl.userData.laser.material.opacity = uiRegion ? 0.9 : 0.55
          if (uiRegion && !uiHover) uiHover = uiRegion.id
          continue
        }
        ctl.userData.uiHit = null
        let best = -1, bestT = Infinity
        for (let i = 0; i < N; i++) {
          xrV.set(liveX(i), worldPos[i].y, liveZ(i)).sub(rayO)
          const along = xrV.dot(rayD)
          if (along < 0.5 || along > 400) continue
          const perp2 = xrV.lengthSq() - along * along
          const tol = Math.max(worldSize[i] * 1.6, 0.35 + along * 0.02)
          if (perp2 < tol * tol && along < bestT) { bestT = along; best = i }
        }
        ctl.userData.hover = best
        ctl.userData.laser.scale.z = best !== -1 ? bestT : 60
        ctl.userData.laser.material.opacity = best !== -1 ? 0.9 : 0.4
        if (best !== -1) xrHover = best
      }
      if (uiHover !== vrSearch.hover) { vrSearch.hover = uiHover; drawVRSearch() }
      if (xrHover !== -1 && xrHover !== selected) placeMarker(hoverMarker, xrHover)
      else if (xrHover === -1) hoverMarker.visible = false
      vrPanel.mesh.visible = selected !== -1
    } else {
      if (vrSearchPanel.mesh.visible) vrSearchPanel.mesh.visible = false
      vrPanel.mesh.visible = false
    }

    for (const mk of [hoverMarker, selectMarker]) {
      if (!mk.visible || mk.userData.idx < 0) continue
      const i = mk.userData.idx
      mk.position.set(liveX(i), worldPos[i].y, liveZ(i))
      const dist = mk.position.distanceTo(camW)
      mk.scale.setScalar(Math.max(worldSize[i] * 3.2, 26 * dist / pickScale))
      mk.quaternion.copy(camWQ)
      mk.material.uniforms.uTime.value = t
    }

    if (!renderer.xr.isPresenting) {
      stepTween(t)

      if (selected !== -1 && !tween) {
        followPos.set(liveX(selected), worldPos[selected].y, liveZ(selected))
        followDelta.subVectors(followPos, controls.target)
        controls.target.add(followDelta)
        camera.position.add(followDelta)
      }

      controls.update()
    }
    renderer.render(scene, camera)
  }
  renderer.setAnimationLoop(() => frame(clock.getElapsedTime()))

  loading.classList.add('done')
  setTimeout(() => loading.remove(), 900)
  flyTo(HOME_POS, HOME_TGT, 2.6)

  window.__gx = { renderer, scene, camera, controls, select, deselect, frame, orbitGroup, clock }

  // Boot WebXR support (feature-detects, injects "Enter VR" button if supported)
  initXR({ renderer, scene, camera, controls }).catch(err => {
    console.warn('[galaxy-xr] XR init failed:', err)
  })

  function loadingFail (msg) {
    const l = document.getElementById('gxLoading')
    if (l) l.innerHTML = `<span style="color:#ff6b5e">${msg}</span>`
  }
}
