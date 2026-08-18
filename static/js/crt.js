(function () {
  'use strict'

  var SVGNS = 'http://www.w3.org/2000/svg'
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  var els = {}

  function build () {
    var ov = document.createElement('div')
    ov.className = 'crt-overlay'
    ov.innerHTML =
      '<div class="crt-scanlines"></div>' +
      '<canvas class="crt-grain"></canvas>' +
      '<div class="crt-scanners"><span></span><span></span></div>' +
      '<div class="crt-glow"></div>'
    document.body.appendChild(ov)

    var bevel = document.createElement('div')
    bevel.className = 'crt-bevel'
    document.body.appendChild(bevel)

    var frame = document.createElement('div')
    frame.className = 'crt-frame'
    document.body.appendChild(frame)

    var svg = document.createElementNS(SVGNS, 'svg')
    svg.setAttribute('class', 'crt-stroke')
    var path = document.createElementNS(SVGNS, 'path')
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', 'rgba(255, 245, 220, 0.07)')
    path.setAttribute('stroke-width', '2')
    svg.appendChild(path)
    document.body.appendChild(svg)

    els.frame = frame
    els.bevel = bevel
    els.svg = svg
    els.path = path
    els.grain = ov.querySelector('.crt-grain')
    els.spans = ov.querySelectorAll('.crt-scanners span')
  }

  function barrelPaths () {
    var vv = window.visualViewport
    var W = vv ? Math.round(vv.width) : window.innerWidth
    var H = vv ? Math.round(vv.height) : window.innerHeight
    var mob = W <= 768
    var C = mob ? 10 : 18
    var E = mob ? 6 : 10
    var R = mob
      ? Math.min(Math.max(18, W * 0.026), 26)
      : Math.min(Math.max(30, W * 0.032), 48)

    var inner = [
      'M ' + (C + R) + ',' + C,
      'Q ' + (W / 2) + ',' + E + ' ' + (W - C - R) + ',' + C,
      'Q ' + (W - C) + ',' + C + ' ' + (W - C) + ',' + (C + R),
      'Q ' + (W - E) + ',' + (H / 2) + ' ' + (W - C) + ',' + (H - C - R),
      'Q ' + (W - C) + ',' + (H - C) + ' ' + (W - C - R) + ',' + (H - C),
      'Q ' + (W / 2) + ',' + (H - E) + ' ' + (C + R) + ',' + (H - C),
      'Q ' + C + ',' + (H - C) + ' ' + C + ',' + (H - C - R),
      'Q ' + E + ',' + (H / 2) + ' ' + C + ',' + (C + R),
      'Q ' + C + ',' + C + ' ' + (C + R) + ',' + C,
      'Z'
    ].join(' ')

    var outer = 'M 0,0 L ' + W + ',0 L ' + W + ',' + H + ' L 0,' + H + ' Z'
    return { inner: inner, outer: outer, W: W, H: H }
  }

  function shape () {
    var p = barrelPaths()
    els.frame.style.clipPath = "path(evenodd, '" + p.outer + ' ' + p.inner + "')"
    els.frame.style.visibility = 'visible'
    els.bevel.style.clipPath = "path('" + p.inner + "')"
    els.svg.setAttribute('viewBox', '0 0 ' + p.W + ' ' + p.H)
    els.path.setAttribute('d', p.inner)
  }

  function initGrain () {
    if (reduced) return
    var canvas = els.grain
    var W = 320, H = 200
    canvas.width = W
    canvas.height = H
    var ctx = canvas.getContext('2d')
    var img = ctx.createImageData(W, H)
    var data = img.data
    var tick = 0
    function draw () {
      tick++
      if (tick % 3 === 0) {
        for (var i = 0; i < data.length; i += 4) {
          var v = (Math.random() * 255) | 0
          data[i] = v
          data[i + 1] = v
          data[i + 2] = v
          data[i + 3] = 255
        }
        ctx.putImageData(img, 0, 0)
      }
      requestAnimationFrame(draw)
    }
    requestAnimationFrame(draw)
  }

  function initScanners () {
    if (reduced) return
    var spans = els.spans
    if (!spans.length) return

    function restartFromTop (span, delayS) {
      span.style.setProperty('--del', (delayS || 0).toFixed(3) + 's')
      span.style.animationName = 'none'
      void span.offsetWidth
      span.style.animationName = ''
    }

    spans[0].style.setProperty('--dur', '11s')
    if (spans[1]) spans[1].style.setProperty('--dur', '15s')

    function groupBurst () {
      for (var i = 0; i < 2 && i < spans.length; i++) {
        (function (span, offsetS) {
          setTimeout(function () {
            span.style.visibility = 'visible'
            restartFromTop(span, 0)
          }, offsetS * 1000)
        })(spans[i], i * 0.07)
      }
      setTimeout(groupBurst, 18000 + Math.random() * 20000)
    }

    for (var i = 0; i < spans.length; i++) {
      restartFromTop(spans[i], i * 0.4)
    }
    setTimeout(groupBurst, 12000 + Math.random() * 10000)
  }

  function init () {
    build()
    requestAnimationFrame(function () {
      shape()
      initGrain()
      initScanners()
    })
    var t
    function onChange () {
      cancelAnimationFrame(t)
      t = requestAnimationFrame(shape)
    }
    window.addEventListener('resize', onChange)
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onChange)
      window.visualViewport.addEventListener('scroll', onChange)
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
